/**
 * n2z Browser Extension — Background Service Worker
 *
 * Orchestrates bidirectional sync between Zotero and NotebookLM:
 * - Forward sync: Zotero collections → NotebookLM notebooks (via URL/file injection)
 * - Backward sync: NotebookLM notes → Zotero collections (via DOM scraping)
 */

const ZOTERO_BASE = "http://localhost:23119";

// Prevents overlapping syncs on the same NotebookLM tab from colliding on
// chrome.debugger.attach, interleaving CDP commands, or writing duplicate
// syncedItemHashes. Keyed by tabId.
const activeSyncs = new Set();

const NOTEBOOKLM_URL_PREFIX = "https://notebooklm.google.com/";
const AMBIGUOUS_TAB_ERROR =
  "Multiple NotebookLM tabs are open. Please switch to the notebook you want to sync into and try again.";

// ─── Zotero API helpers ──────────────────────────────────────────────

async function zoteroRequest(path, body = null) {
  const options = {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "Zotero-Allowed-Request": "true",
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${ZOTERO_BASE}${path}`, options);
  } catch {
    throw new Error(
      "Zotero is not running or the n2z plugin is not loaded. Make sure Zotero is open."
    );
  }
  if (!res.ok) {
    throw new Error(`Zotero returned HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(
      "Zotero returned a non-JSON response (plugin may have crashed)."
    );
  }
}

async function checkZoteroConnection() {
  try {
    const res = await zoteroRequest("/n2z/status");
    return res.success === true;
  } catch {
    return false;
  }
}

async function getCollections(libraryId) {
  return zoteroRequest("/n2z/collections", { libraryId });
}

async function getExportableItems(collectionId) {
  return zoteroRequest("/n2z/list", { collectionId });
}

async function getFile(attachmentId) {
  return zoteroRequest("/n2z/file", { attachmentId });
}

async function getMappings() {
  return zoteroRequest("/n2z/mapping", { action: "getAll" });
}

async function setMapping(mapping) {
  return zoteroRequest("/n2z/mapping", { action: "set", mapping });
}

async function removeMapping(collectionId) {
  return zoteroRequest("/n2z/mapping", { action: "remove", collectionId });
}

async function importNotesToZotero(notes) {
  return zoteroRequest("/n2z/import-notes", notes);
}

// ─── NotebookLM tab helpers ──────────────────────────────────────────

/**
 * Resolves which NotebookLM tab a sync operation should target.
 *
 * Strategy order:
 *   1. "active"     — active tab of the last-focused window is NotebookLM
 *   2. "preferred"  — a NotebookLM tab whose URL matches preferredNotebookId
 *   3. "sole"       — exactly one NotebookLM tab is open anywhere
 *   4. "none"       — no NotebookLM tab open
 *   5. "ambiguous"  — multiple NotebookLM tabs open and none match
 */
async function resolveNotebookLMTab(preferredNotebookId = null) {
  const activeTabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const active = activeTabs[0];
  if (active?.url?.startsWith(NOTEBOOKLM_URL_PREFIX)) {
    return { tab: active, reason: "active" };
  }

  const allNotebookLMTabs = await chrome.tabs.query({
    url: "https://notebooklm.google.com/*",
  });

  if (preferredNotebookId) {
    const match = allNotebookLMTabs.find((t) =>
      t.url?.includes(`/notebook/${preferredNotebookId}`)
    );
    if (match) return { tab: match, reason: "preferred" };
  }

  if (allNotebookLMTabs.length === 1) {
    return { tab: allNotebookLMTabs[0], reason: "sole" };
  }
  if (allNotebookLMTabs.length === 0) {
    return { tab: null, reason: "none" };
  }
  return { tab: null, reason: "ambiguous" };
}

async function findNotebookLMTab() {
  const { tab } = await resolveNotebookLMTab();
  return tab;
}

function extractNotebookIdFromUrl(url) {
  const match = url.match(/\/notebook\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// ─── Forward Sync ────────────────────────────────────────────────────

/**
 * Performs forward sync: gets items from Zotero and returns them
 * so the popup can display what will be synced. Actual injection
 * happens per-item via addUrlSource or file injection.
 */
async function forwardSync(collectionId, collectionName) {
  // 1. Resolve which NotebookLM tab to target
  const { tab, reason } = await resolveNotebookLMTab();
  if (!tab) {
    return {
      success: false,
      error:
        reason === "ambiguous"
          ? AMBIGUOUS_TAB_ERROR
          : "No NotebookLM tab found. Please open NotebookLM first.",
    };
  }

  const notebookId = extractNotebookIdFromUrl(tab.url);
  if (!notebookId) {
    return {
      success: false,
      error: "Please navigate to a specific notebook in NotebookLM.",
    };
  }

  // Concurrency lock — prevent overlapping syncs on the same tab
  if (activeSyncs.has(tab.id)) {
    return {
      success: false,
      error: "A sync is already running on this NotebookLM tab.",
    };
  }
  activeSyncs.add(tab.id);
  try {
    return await forwardSyncImpl(tab, notebookId, collectionId, collectionName);
  } finally {
    activeSyncs.delete(tab.id);
  }
}

async function forwardSyncImpl(tab, notebookId, collectionId, collectionName) {
  // 1b. Set notebook title to the collection name (user can change it later)
  if (collectionName) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [collectionName],
      func: (name) => {
        // NotebookLM's notebook title is typically an editable input/textarea
        // at the top of the page, or a contenteditable heading
        const candidates = document.querySelectorAll(
          'input, textarea, [contenteditable="true"], [contenteditable=""]'
        );
        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          // Title is near the top of the page and reasonably wide
          if (rect.top > 200 || rect.width < 100 || rect.height === 0) continue;
          const tag = el.tagName.toLowerCase();
          if (tag === "input" || tag === "textarea") {
            // Only set if it's a default/untitled notebook name
            const val = el.value || "";
            if (!val || /^untitled/i.test(val) || /^new notebook/i.test(val) || val.length < 3) {
              const setter = tag === "textarea"
                ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set
                : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
              if (setter) setter.call(el, name);
              else el.value = name;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              el.dispatchEvent(new Event("blur", { bubbles: true }));
              return { success: true, method: "input" };
            }
            return { success: false, reason: "notebook-already-named", current: val };
          }
          if (el.getAttribute("contenteditable") !== null) {
            const text = el.textContent?.trim() || "";
            if (!text || /^untitled/i.test(text) || /^new notebook/i.test(text) || text.length < 3) {
              el.textContent = name;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("blur", { bubbles: true }));
              return { success: true, method: "contenteditable" };
            }
            return { success: false, reason: "notebook-already-named", current: text };
          }
        }
        return { success: false, reason: "no-title-field-found" };
      },
    });
    await sleep(500);
  }

  // 1c. Ensure the "Sources" tab is active (may be on Chat or Studio)
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const isIconElement = (el) => {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        const tag = el.tagName?.toLowerCase() || "";
        const cls = (el.className || "").toString().toLowerCase();
        return tag === "mat-icon" || cls.includes("material-icons") || cls.includes("mat-icon");
      };
      const getCleanText = (node) => {
        let result = "";
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
          else if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.tagName === "STYLE" || child.tagName === "SCRIPT") continue;
            if (isIconElement(child)) continue;
            result += getCleanText(child);
          }
        }
        return result;
      };
      const clickables = document.querySelectorAll(
        '[role="tab"], button, [role="button"], a, [class*="tab"]'
      );
      for (const el of clickables) {
        const text = getCleanText(el).trim();
        if (/^Sources$/i.test(text)) {
          el.click();
          return true;
        }
      }
      return false;
    },
  });
  await sleep(1000);

  // 2. Get exportable items from Zotero
  const itemsRes = await getExportableItems(collectionId);
  if (!itemsRes.success) {
    return {
      success: false,
      error: itemsRes.error || "Failed to get items from Zotero",
    };
  }

  const items = itemsRes.data;
  if (!items || items.length === 0) {
    return {
      success: false,
      error:
        "No exportable items found in this collection. Items need either a local PDF/file or a URL/DOI.",
    };
  }

  // Warn about NotebookLM's 50-source limit
  if (items.length > 50) {
    return {
      success: false,
      error: `This collection has ${items.length} items, but NotebookLM only supports 50 sources per notebook. Please select a smaller sub-collection.`,
    };
  }

  // 3. Check for already-synced items (keyed by collection+notebook pair)
  const syncKey = `sync_${collectionId}_${notebookId}`;
  const syncState = await chrome.storage.local.get(syncKey);
  const syncedHashes = syncState[syncKey] || {};
  const newItems = items.filter((item) => !syncedHashes[item.itemKey]);

  if (newItems.length === 0) {
    return {
      success: true,
      message: `All ${items.length} items already synced to this notebook.`,
      synced: 0,
      total: items.length,
    };
  }

  // 4. Separate by type
  const urlItems = newItems.filter((i) => i.exportType === "url");
  const fileItems = newItems.filter((i) => i.exportType === "file");
  const allResults = [];

  // 5a. Add ALL URL sources at once (NotebookLM supports multiple URLs
  // separated by newlines in a single paste)
  if (urlItems.length > 0) {
    try {
      const urls = urlItems.map((i) => i.url);
      const result = await addUrlSourcesBatch(tab.id, urls);
      const confirmed = result.success;

      // Build detailed error from step info
      let errorDetail = result.error || "";
      if (!confirmed && result.steps) {
        const failedStep = Object.entries(result.steps).find(([, v]) => !v?.success);
        if (failedStep) {
          errorDetail = `Step ${failedStep[0]}: ${failedStep[1]?.error || "failed"}`;
        }
      }

      for (const item of urlItems) {
        allResults.push({
          title: item.title,
          success: confirmed,
          error: errorDetail,
          type: "url",
        });
        if (confirmed) {
          syncedHashes[item.itemKey] = Date.now().toString();
        }
      }
    } catch (e) {
      for (const item of urlItems) {
        allResults.push({
          title: item.title,
          success: false,
          error: e.message,
          type: "url",
        });
      }
    }
  }

  // 5b. Add file sources via CDP
  // Wait for any URL dialog to fully close before starting file uploads
  if (fileItems.length > 0 && urlItems.length > 0) {
    await sleep(2000);
  }
  if (fileItems.length > 0) {
    let debuggerAttached = false;
    try {
      await chrome.debugger.attach({ tabId: tab.id }, "1.3");
      debuggerAttached = true;
    } catch (e) {
      for (const item of fileItems) {
        allResults.push({
          title: item.title,
          success: false,
          error: `Debugger failed: ${e.message}`,
          type: "file",
        });
      }
    }

    if (debuggerAttached) {
      try {
        for (const item of fileItems) {
          const fileRes = await getFile(item.attachmentId);
          if (!fileRes.success || !fileRes.data) {
            allResults.push({
              title: item.title,
              success: false,
              error: "Could not fetch file from Zotero",
              type: "file",
            });
            continue;
          }
          const result = await injectFileViaCDP(tab.id, fileRes.data);
          allResults.push({
            title: item.title,
            success: result.success,
            error: result.error,
            type: "file",
          });
          if (result.success) {
            syncedHashes[item.itemKey] = Date.now().toString();
          }
          await sleep(3000);
        }
      } finally {
        try {
          await chrome.debugger.detach({ tabId: tab.id });
        } catch {}
      }
    }
  }

  // 6. Save sync state (keyed by collection+notebook pair)
  await chrome.storage.local.set({
    [syncKey]: syncedHashes,
  });

  // 7. Update mapping in Zotero
  await setMapping({
    collectionId,
    collectionName,
    notebookId,
    notebookUrl: tab.url,
    lastSyncForward: new Date().toISOString(),
    lastSyncBackward: null,
    syncedItemHashes: syncedHashes,
    importedNoteIds: [],
  });

  const successCount = allResults.filter((r) => r.success).length;
  const failCount = allResults.filter((r) => !r.success).length;

  let message = `Synced ${successCount}/${newItems.length} items (${urlItems.length} URLs, ${fileItems.length} files).`;
  if (failCount > 0) {
    const errors = allResults
      .filter((r) => !r.success)
      .slice(0, 3)
      .map((r) => r.error)
      .join("; ");
    message += ` Errors: ${errors}`;
  }

  return {
    success: successCount > 0 || failCount === 0,
    message,
    synced: successCount,
    failed: failCount,
    total: items.length,
    results: allResults,
  };
}

/**
 * Adds multiple URLs as sources in NotebookLM in a single batch.
 * NotebookLM's "Websites" dialog accepts multiple URLs separated by newlines.
 * Flow: Click "Add sources" → Click "Websites" → Paste all URLs → Click "Insert"
 */
async function addUrlSourcesBatch(tabId, urls) {
  // Shared helper injected into each step
  const getCleanTextFn = `
    const getCleanText = (el) => {
      let text = "";
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          text += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.tagName?.toLowerCase() || "";
          const cls = (child.className || "").toString().toLowerCase();
          if (tag === "mat-icon" || cls.includes("material-icons") || cls.includes("mat-icon")) continue;
          text += getCleanText(child);
        }
      }
      return text.trim();
    };
  `;

  const steps = {};

  // Step 1: Click "Add sources" button
  const step1 = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const getCleanText = (el) => { let t=""; for (const c of el.childNodes) { if (c.nodeType===3) t+=c.textContent; else if (c.nodeType===1) { const tag=c.tagName?.toLowerCase()||""; const cls=(c.className||"").toString().toLowerCase(); if (tag==="mat-icon"||cls.includes("material-icons")||cls.includes("mat-icon")) continue; t+=getCleanText(c); } } return t.trim(); };

      const candidates = document.querySelectorAll('button, [role="button"], a, [tabindex="0"]');
      for (const el of candidates) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const clean = getCleanText(el).toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        if (clean.includes("add source") || aria.includes("add source")) {
          el.click();
          return { success: true, clicked: clean || aria };
        }
      }
      const visible = Array.from(candidates)
        .filter(e => { const s = window.getComputedStyle(e); return s.display !== "none" && s.visibility !== "hidden"; })
        .map(e => getCleanText(e)).filter(t => t && t.length < 40).slice(0, 10);
      return { success: false, error: "No 'Add sources' button. Visible: " + visible.join(", ") };
    },
  });
  steps.step1 = step1?.[0]?.result;
  if (!steps.step1?.success) return { ...steps.step1, steps };

  await sleep(2000);

  // Step 2: Click "Websites" in the source type picker
  const step2 = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const getCleanText = (el) => { let t=""; for (const c of el.childNodes) { if (c.nodeType===3) t+=c.textContent; else if (c.nodeType===1) { const tag=c.tagName?.toLowerCase()||""; const cls=(c.className||"").toString().toLowerCase(); if (tag==="mat-icon"||cls.includes("material-icons")||cls.includes("mat-icon")) continue; t+=getCleanText(c); } } return t.trim(); };

      // Look broadly for any clickable element with "Website" text
      const allClickable = document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], [tabindex="0"], a, div, span');
      for (const el of allClickable) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const clean = getCleanText(el).toLowerCase();
        // Must contain "website" and be a reasonably small element (not a huge container)
        if ((clean === "websites" || clean === "website") && el.textContent.length < 100) {
          el.click();
          return { success: true, clicked: clean, tag: el.tagName };
        }
      }
      // Fallback: look for elements whose raw text starts with icon names for website
      for (const el of allClickable) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const raw = (el.textContent || "").trim().toLowerCase();
        if (raw.length < 100 && raw.includes("website")) {
          el.click();
          return { success: true, clicked: raw.substring(0, 50), tag: el.tagName, method: "contains-website" };
        }
      }
      const visible = Array.from(allClickable)
        .filter(e => { const s = window.getComputedStyle(e); return s.display !== "none" && s.visibility !== "hidden"; })
        .map(e => { const c = getCleanText(e); const r = e.textContent?.trim()||""; return c.length < 50 ? (c === r ? c : c + " [" + r.substring(0,30) + "]") : ""; })
        .filter(t => t && t.length > 0).slice(0, 15);
      return { success: false, error: "No 'Websites' option found. Visible: " + visible.join(", ") };
    },
  });
  steps.step2 = step2?.[0]?.result;
  if (!steps.step2?.success) return { ...steps.step2, steps };

  await sleep(2000);

  // Step 3: Paste all URLs into the textarea
  // The dialog shows a textarea with placeholder "Paste any links"
  // Multiple URLs can be separated by newlines
  const urlsText = urls.join("\n");
  const step3 = await chrome.scripting.executeScript({
    target: { tabId },
    args: [urlsText],
    func: (urlsText) => {
      // Priority 1: find textarea with "paste" in placeholder (the URL paste area)
      let field = null;
      const textareas = document.querySelectorAll("textarea");
      for (const ta of textareas) {
        const style = window.getComputedStyle(ta);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const ph = (ta.getAttribute("placeholder") || "").toLowerCase();
        if (ph.includes("paste") || ph.includes("link") || ph.includes("url")) {
          field = ta;
          break;
        }
      }
      // Priority 2: any visible textarea
      if (!field) {
        for (const ta of textareas) {
          const style = window.getComputedStyle(ta);
          if (style.display === "none" || style.visibility === "hidden") continue;
          field = ta;
          break;
        }
      }
      // Priority 3: visible text input
      if (!field) {
        const inputs = document.querySelectorAll('input[type="text"], input[type="url"]');
        for (const inp of inputs) {
          const style = window.getComputedStyle(inp);
          if (style.display === "none" || style.visibility === "hidden") continue;
          field = inp;
          break;
        }
      }

      if (!field) {
        const allFields = Array.from(document.querySelectorAll("input, textarea"))
          .map(i => `${i.tagName}:${i.type||""}:ph="${i.placeholder||""}"`)
          .slice(0, 8);
        return { success: false, error: "No URL field found. Fields: " + allFields.join(", ") };
      }

      // Focus and set value
      field.focus();

      // Use native setter for Angular compatibility
      const setter = field.tagName === "TEXTAREA"
        ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set
        : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

      if (setter) {
        setter.call(field, urlsText);
      } else {
        field.value = urlsText;
      }

      // Dispatch events for Angular/React change detection
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));

      return {
        success: true,
        placeholder: field.placeholder || "",
        tag: field.tagName,
        urlCount: urlsText.split("\n").length,
        valueSet: field.value.length > 0,
      };
    },
  });
  steps.step3 = step3?.[0]?.result;
  if (!steps.step3?.success) return { ...steps.step3, steps };

  await sleep(1500);

  // Step 4: Click the "Insert" button
  // The button is clearly visible in the dialog with text "Insert"
  const step4 = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const getCleanText = (el) => { let t=""; for (const c of el.childNodes) { if (c.nodeType===3) t+=c.textContent; else if (c.nodeType===1) { const tag=c.tagName?.toLowerCase()||""; const cls=(c.className||"").toString().toLowerCase(); if (tag==="mat-icon"||cls.includes("material-icons")||cls.includes("mat-icon")) continue; t+=getCleanText(c); } } return t.trim(); };

      // Search ALL elements, not just buttons — NotebookLM may use divs or spans
      const allClickable = document.querySelectorAll("button, [role='button'], [tabindex='0'], a");

      // First pass: exact match for "Insert"
      for (const el of allClickable) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const clean = getCleanText(el).trim();
        if (clean === "Insert" || clean === "insert") {
          el.click();
          return { success: true, clicked: clean };
        }
      }

      // Second pass: contains "insert" (case-insensitive)
      for (const el of allClickable) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const clean = getCleanText(el).trim().toLowerCase();
        if (clean.includes("insert") && clean.length < 30) {
          el.click();
          return { success: true, clicked: clean };
        }
      }

      // Third pass: any submit-like button
      for (const el of allClickable) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const clean = getCleanText(el).trim().toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        if (clean === "submit" || clean === "add source" || aria.includes("insert") || aria.includes("submit")) {
          el.click();
          return { success: true, clicked: clean || aria };
        }
      }

      // Debug: list all visible clickable elements
      const visible = Array.from(allClickable)
        .filter(e => { const s = window.getComputedStyle(e); return s.display !== "none" && s.visibility !== "hidden"; })
        .map(e => { const c = getCleanText(e).trim(); return c.length > 0 && c.length < 50 ? `${e.tagName}:"${c}"` : ""; })
        .filter(t => t.length > 0).slice(0, 15);
      return { success: false, error: "No Insert button found. Elements: " + visible.join(", ") };
    },
  });
  steps.step4 = step4?.[0]?.result;

  // Wait for NotebookLM to process
  await sleep(3000);

  // Close any remaining dialog by pressing Escape
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    },
  });

  await sleep(500);

  return { ...steps.step4, steps };
}

/**
 * Injects a file into NotebookLM via Chrome DevTools Protocol.
 * Strategy:
 * 1. Open the "Add sources" dialog
 * 2. Enable Page.setInterceptFileChooserDialog
 * 3. Click "Upload files" (CDP intercepts the OS dialog)
 * 4. Use DOM.setFileInputFiles with the actual file path
 */
async function injectFileViaCDP(tabId, file) {
  if (!file.filePath) {
    return { success: false, error: "No file path available from Zotero" };
  }

  // Strategy: Use CDP Input.dispatchDragEvent to dispatch trusted drag events.
  // Trusted events bypass Angular's isTrusted check.
  // 1. Create a hidden file input + set file via DOM.setFileInputFiles
  // 2. Read file as blob from the input
  // 3. Use Input.dispatchDragEvent (trusted) on the drop zone coordinates

  // Step 1: Ensure "Add sources" dialog is open
  const step1 = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const getCleanText = (el) => { let t=""; for (const c of el.childNodes) { if (c.nodeType===3) t+=c.textContent; else if (c.nodeType===1) { const tag=c.tagName?.toLowerCase()||""; const cls=(c.className||"").toString().toLowerCase(); if (tag==="mat-icon"||cls.includes("material-icons")||cls.includes("mat-icon")) continue; t+=getCleanText(c); } } return t.trim(); };
      const body = document.body.textContent || "";
      if (/drop your files/i.test(body) || /upload files/i.test(body)) {
        return { success: true, method: "dialog-already-open" };
      }
      const candidates = document.querySelectorAll('button, [role="button"], a, [tabindex="0"]');
      for (const el of candidates) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const clean = getCleanText(el).toLowerCase();
        if (clean.includes("add source")) {
          el.click();
          return { success: true, clicked: clean };
        }
      }
      return { success: false, error: "No 'Add sources' button" };
    },
  });

  if (!step1?.[0]?.result?.success) {
    return step1?.[0]?.result || { success: false, error: "Could not open Add sources" };
  }

  await sleep(2000);

  // Track cleanup state so the finally block only acts on what was set up.
  let interceptionEnabled = false;
  let listenerAttached = false;
  let onEvent = null;

  try {
    // Step 2: Set up file chooser interception, then click "Upload files"
    // The key insight: we must enable interception BEFORE clicking the button
    await chrome.debugger.sendCommand({ tabId }, "Page.enable", {});
    await chrome.debugger.sendCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: true });
    interceptionEnabled = true;

    // Set up event listener for file chooser
    let fileChooserResolve;
    const fileChooserPromise = new Promise(r => { fileChooserResolve = r; });
    const timeout = setTimeout(() => fileChooserResolve(null), 10000);

    onEvent = (source, method, params) => {
      if (source.tabId === tabId && method === "Page.fileChooserOpened") {
        clearTimeout(timeout);
        fileChooserResolve(params);
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);
    listenerAttached = true;

    // Click "Upload files" button
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const getCleanText = (el) => { let t=""; for (const c of el.childNodes) { if (c.nodeType===3) t+=c.textContent; else if (c.nodeType===1) { const tag=c.tagName?.toLowerCase()||""; const cls=(c.className||"").toString().toLowerCase(); if (tag==="mat-icon"||cls.includes("material-icons")||cls.includes("mat-icon")) continue; t+=getCleanText(c); } } return t.trim(); };
        const all = document.querySelectorAll('button, [role="button"], [tabindex="0"], a, div, span, label');
        for (const el of all) {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") continue;
          const clean = getCleanText(el).toLowerCase();
          if (clean === "upload files" && el.textContent.length < 60) {
            el.click();
            return { success: true, method: "upload-files-click" };
          }
        }
        return { success: false, error: "Upload files button not found" };
      },
    });

    // Wait for file chooser event
    const chooserEvent = await fileChooserPromise;

    let result;
    if (chooserEvent) {
      // File chooser intercepted! Set files via backendNodeId
      const filePath = file.filePath;
      try {
        await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
          files: [filePath],
          backendNodeId: chooserEvent.backendNodeId,
        });
        result = { success: true, method: "fileChooserIntercepted" };
      } catch (e) {
        result = { success: false, error: `setFileInputFiles via chooser: ${e.message}` };
      }
    } else {
      // No file chooser event — try fallback approaches

      // Fallback A: Find any input[type=file] that was created in the DOM
      const filePath = file.filePath;
      try {
        const doc = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1 });
        const nodes = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelectorAll", {
          nodeId: doc.root.nodeId,
          selector: 'input[type="file"]',
        });
        if (nodes?.nodeIds?.length > 0) {
          await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
            nodeId: nodes.nodeIds[nodes.nodeIds.length - 1],
            files: [filePath],
          });
          result = { success: true, method: "existingFileInput" };
        }
      } catch (e) {
        // continue to fallback B
      }

      // Fallback B: Create our own input, set file, trigger change on it,
      // then also try to find and trigger change on any Angular file input
      if (!result) {
        try {
          // Create hidden input
          await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: `
              (() => {
                let inp = document.getElementById("_n2z_file_input");
                if (inp) inp.remove();
                inp = document.createElement("input");
                inp.type = "file";
                inp.id = "_n2z_file_input";
                inp.accept = ".pdf,.txt,.md,.docx";
                inp.style.position = "fixed";
                inp.style.left = "-9999px";
                document.body.appendChild(inp);
                return true;
              })()
            `,
            returnByValue: true,
          });

          const doc2 = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1 });
          const nodes2 = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelectorAll", {
            nodeId: doc2.root.nodeId,
            selector: "#_n2z_file_input",
          });

          if (nodes2?.nodeIds?.length) {
            await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
              nodeId: nodes2.nodeIds[0],
              files: [filePath],
            });

            // Use Input.dispatchDragEvent for trusted drag events
            // First find the drop zone coordinates
            const dropInfo = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
              expression: `
                (() => {
                  // Find the drop zone area
                  const allEls = document.querySelectorAll("*");
                  for (const el of allEls) {
                    const t = (el.textContent || "").toLowerCase();
                    if (t.length > 500) continue;
                    if (/drop\\s+(your\\s+)?files/i.test(t) || /drag.*drop/i.test(t)) {
                      let candidate = el;
                      for (let i = 0; i < 5; i++) {
                        if (!candidate.parentElement) break;
                        candidate = candidate.parentElement;
                        const rect = candidate.getBoundingClientRect();
                        if (rect.width > 200 && rect.height > 100) {
                          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, found: true, tag: candidate.tagName };
                        }
                      }
                    }
                  }
                  // Fallback: use dialog center
                  const dialogs = document.querySelectorAll('[role="dialog"], [class*="dialog"]');
                  for (const d of dialogs) {
                    const rect = d.getBoundingClientRect();
                    if (rect.width > 100 && rect.height > 100) {
                      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, found: true, tag: d.tagName };
                    }
                  }
                  return { found: false };
                })()
              `,
              returnByValue: true,
            });

            const dropCoords = dropInfo?.result?.value;

            if (dropCoords?.found) {
              const x = Math.round(dropCoords.x);
              const y = Math.round(dropCoords.y);

              // Read file data from our input to include in drag data
              const fileData = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
                expression: `
                  new Promise((resolve) => {
                    const inp = document.getElementById("_n2z_file_input");
                    if (!inp || !inp.files[0]) { resolve(null); return; }
                    const f = inp.files[0];
                    resolve({ name: f.name, size: f.size, type: f.type || "application/pdf" });
                  })
                `,
                returnByValue: true,
                awaitPromise: true,
              });

              const fInfo = fileData?.result?.value;
              const mimeType = fInfo?.type || "application/pdf";

              // Dispatch trusted drag events via CDP Input domain
              await chrome.debugger.sendCommand({ tabId }, "Input.dispatchDragEvent", {
                type: "dragEnter",
                x, y,
                data: {
                  items: [{ mimeType, data: "" }],
                  files: [file.filePath],
                  dragOperationsMask: 1,
                },
              });

              await chrome.debugger.sendCommand({ tabId }, "Input.dispatchDragEvent", {
                type: "dragOver",
                x, y,
                data: {
                  items: [{ mimeType, data: "" }],
                  files: [file.filePath],
                  dragOperationsMask: 1,
                },
              });

              await chrome.debugger.sendCommand({ tabId }, "Input.dispatchDragEvent", {
                type: "drop",
                x, y,
                data: {
                  items: [{ mimeType, data: "" }],
                  files: [file.filePath],
                  dragOperationsMask: 1,
                },
              });

              // Clean up
              await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
                expression: `document.getElementById("_n2z_file_input")?.remove()`,
              });

              result = { success: true, method: "cdp-trusted-drag", dropTarget: dropCoords.tag };
            } else {
              result = { success: false, error: "No drop zone found for CDP drag" };
            }
          } else {
            result = { success: false, error: "Could not create file input" };
          }
        } catch (e) {
          result = { success: false, error: `Fallback drag: ${e.message}` };
        }
      }
    }

    if (result?.success) {
      await sleep(5000);
      // Close dialog
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })),
      });
    }

    return result || { success: false, error: "All file upload strategies failed" };
  } catch (e) {
    return { success: false, error: `CDP file inject: ${e.message}` };
  } finally {
    // Always remove the listener and disable interception, regardless of how
    // we exit. Without this, a mid-flight exception leaves the tab's file
    // chooser intercepted — breaking manual uploads until the tab is reloaded.
    if (listenerAttached && onEvent) {
      try {
        chrome.debugger.onEvent.removeListener(onEvent);
      } catch {}
    }
    if (interceptionEnabled) {
      try {
        await chrome.debugger.sendCommand(
          { tabId },
          "Page.setInterceptFileChooserDialog",
          { enabled: false }
        );
      } catch {}
    }
  }
}

async function cdpEval(tabId, expression) {
  const result = await chrome.debugger.sendCommand(
    { tabId },
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
  );
  return result?.result?.value;
}

// ─── Backward Sync: Note Extraction ─────────────────────────────────

/**
 * Extracts notes from NotebookLM using scripting API.
 * Step 1: Find all note cards in the right panel.
 * Step 2: Click each card to open it and scrape the full content.
 */
async function extractNotesFromTab(tabId) {
  // Step 0: Ensure the "Studio" tab/panel is visible.
  // On narrow/vertical monitors the 3-column layout collapses and
  // Studio becomes a tab that must be clicked first.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const isIconElement = (el) => {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        const tag = el.tagName?.toLowerCase() || "";
        const cls = (el.className || "").toString().toLowerCase();
        return tag === "mat-icon" || cls.includes("material-icons") || cls.includes("mat-icon");
      };
      const getCleanText = (node) => {
        let result = "";
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
          else if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.tagName === "STYLE" || child.tagName === "SCRIPT") continue;
            if (isIconElement(child)) continue;
            result += getCleanText(child);
          }
        }
        return result;
      };
      // Look for a tab/button labeled "Studio"
      const clickables = document.querySelectorAll(
        '[role="tab"], button, [role="button"], a, [class*="tab"]'
      );
      for (const el of clickables) {
        const text = getCleanText(el).trim();
        if (/^Studio$/i.test(text)) {
          el.click();
          return true;
        }
      }
      return false;
    },
  });
  await sleep(1000);

  // Step 1: Scan for note card titles (just collect metadata, no tagging)
  const scanResult = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const isIconElement = (el) => {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        const cls = (el.className || "").toString().toLowerCase();
        const tag = el.tagName?.toLowerCase() || "";
        return tag === "mat-icon" || cls.includes("material-icons") || cls.includes("mat-icon");
      };
      const getCleanText = (node) => {
        let result = "";
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
          else if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.tagName === "STYLE" || child.tagName === "SCRIPT") continue;
            if (isIconElement(child)) continue;
            result += getCleanText(child);
          }
        }
        return result;
      };

      const allElements = document.querySelectorAll("*:not(style):not(script):not(link):not(meta):not(head)");
      const seenCards = new Set();
      const seenTitles = [];
      const normalize = (t) => t.replace(/\s+/g, " ").trim().toLowerCase();
      const foundNotes = [];

      for (const el of allElements) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;

        const rawText = el.textContent?.trim() || "";
        if (rawText.length > 2000 || rawText.length < 8 || el.children.length > 20) continue;
        if (!/\d+[mhd]\s*ago/i.test(rawText)) continue;

        let card = el;
        for (let i = 0; i < 3; i++) {
          if (!card.parentElement) break;
          if (card.parentElement.children.length > 5) break;
          if (card.parentElement.tagName === "MAIN" || card.parentElement.tagName === "BODY") break;
          card = card.parentElement;
        }

        if (seenCards.has(card)) continue;
        seenCards.add(card);

        const cleanText = getCleanText(card).trim();
        if (cleanText.length < 8 || /\{[^}]*:[^}]*\}/.test(cleanText)) continue;

        const lines = cleanText.split(/\n/).map(l => l.trim()).filter(Boolean);
        let title = "";
        let noteType = "saved-note";
        const typePattern = /^(Explainer|Deep Dive|Study Guide|Briefing|FAQ|Timeline|Outline|Report|Audio Overview|New Note)$/i;

        for (const line of lines) {
          if (line.length <= 2) continue;
          if (/^\d+[mhd]\s*ago$/i.test(line)) continue;
          if (/^\d+\s*sources?$/i.test(line)) continue;
          if (/^[·•\-–—\s]+$/.test(line)) continue;
          if (typePattern.test(line)) { noteType = line; continue; }
          if (!title) title = line;
        }

        if (!title || title.length < 3) continue;

        // Clean trailing junk from title: timestamps, "Add note", other note names
        title = title
          .replace(/\s*\d+[mhd]\s*ago\b.*/i, "")   // "10h ago" and everything after
          .replace(/\s*Add\s+note\b.*/i, "")         // "Add note" and everything after
          .replace(/\s*\d+\s*sources?\b.*/i, "")     // "2 sources" and everything after
          .trim();

        if (!title || title.length < 3) continue;
        const lower = title.toLowerCase();
        if (/^(sources?|chat|studio|notes?|settings?|share|help|add\s|create\s)$/i.test(lower)) continue;

        // Early dedup: skip if we already found a note with this title
        const normTitle = normalize(title);
        if (seenTitles.some(s => s === normTitle || normTitle.startsWith(s) || s.startsWith(normTitle))) continue;
        seenTitles.push(normTitle);

        if (noteType === "saved-note") {
          const m = cleanText.match(/(Explainer|Deep Dive|Study Guide|Briefing|FAQ|Timeline|Outline|Report|Audio Overview)/i);
          if (m) noteType = m[1];
        }

        const lt = noteType.toLowerCase();
        if (lt.includes("audio") || lt.includes("deep dive")) continue;

        const tsMatch = cleanText.match(/(\d+[mhd])\s*ago/i);

        foundNotes.push({
          title: title.substring(0, 200),
          type: noteType.toLowerCase().replace(/\s+/g, "-"),
          timestamp: tsMatch ? tsMatch[0] : "",
        });
      }

      // Final dedup safety net (early dedup above should catch most)
      const seen = [];
      return foundNotes.filter(n => {
        const norm = normalize(n.title);
        const isDup = seen.some(s => s === norm || norm.startsWith(s) || s.startsWith(norm));
        if (isDup) return false;
        seen.push(norm);
        return true;
      });
    },
  });

  const noteCards = scanResult?.[0]?.result || [];
  if (noteCards.length === 0) {
    return [];
  }

  // Step 2: For each note, re-find its card in the DOM (by title),
  // click it, scrape content, then navigate back.
  // We re-find each time because Angular re-renders the DOM on back-navigation.
  const notes = [];
  const urlBefore = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.location.href,
  });
  const baseUrl = urlBefore?.[0]?.result || "";

  for (const card of noteCards) {
    // Re-find and click the card by matching its title in the current DOM
    const clickResult = await chrome.scripting.executeScript({
      target: { tabId },
      args: [card.title],
      func: (targetTitle) => {
        const isIconElement = (el) => {
          if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
          const tag = el.tagName?.toLowerCase() || "";
          const cls = (el.className || "").toString().toLowerCase();
          return tag === "mat-icon" || cls.includes("material-icons") || cls.includes("mat-icon");
        };
        const getCleanText = (node) => {
          let result = "";
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
            else if (child.nodeType === Node.ELEMENT_NODE) {
              if (child.tagName === "STYLE" || child.tagName === "SCRIPT") continue;
              if (isIconElement(child)) continue;
              result += getCleanText(child);
            }
          }
          return result;
        };

        // Find elements containing the note title
        const allElements = document.querySelectorAll("*:not(style):not(script):not(link):not(meta):not(head)");
        let bestCard = null;
        let bestSize = Infinity;

        for (const el of allElements) {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") continue;
          const rawText = el.textContent?.trim() || "";
          if (rawText.length > 2000 || rawText.length < 8) continue;
          // Must contain the title and a timestamp pattern (card indicator)
          if (!rawText.includes(targetTitle.substring(0, 30)) || !/\d+[mhd]\s*ago/i.test(rawText)) continue;

          // Prefer the smallest element that contains the full title
          // (most specific = the actual card, not a parent container)
          if (rawText.length < bestSize) {
            bestSize = rawText.length;
            bestCard = el;
          }
        }

        if (!bestCard) return { success: false, error: "card-not-found-by-title" };

        // Walk up a bit to get the actual card container
        let card = bestCard;
        for (let i = 0; i < 3; i++) {
          if (!card.parentElement) break;
          if (card.parentElement.children.length > 5) break;
          if (card.parentElement.tagName === "MAIN" || card.parentElement.tagName === "BODY") break;
          card = card.parentElement;
        }

        // Click strategy 1: Find <a> inside card
        const anchors = card.querySelectorAll("a");
        for (const a of anchors) {
          const rect = a.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            a.click();
            return { success: true, method: "anchor-click" };
          }
        }

        // Click strategy 2: Interactive child
        const interactives = card.querySelectorAll('button, [role="button"], [role="link"], [tabindex="0"]');
        for (const btn of interactives) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            btn.click();
            return { success: true, method: "interactive-child" };
          }
        }

        // Click strategy 3: Full mouse event sequence
        const rect = card.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
        card.dispatchEvent(new PointerEvent("pointerdown", opts));
        card.dispatchEvent(new MouseEvent("mousedown", opts));
        card.dispatchEvent(new PointerEvent("pointerup", opts));
        card.dispatchEvent(new MouseEvent("mouseup", opts));
        card.dispatchEvent(new MouseEvent("click", opts));
        return { success: true, method: "mouse-event-sequence" };
      },
    });

    if (!clickResult?.[0]?.result?.success) {
      let hash = 0;
      for (let i = 0; i < card.title.length; i++) {
        hash = (hash << 5) - hash + card.title.charCodeAt(i);
        hash |= 0;
      }
      notes.push({
        id: "note-" + Math.abs(hash).toString(36),
        title: card.title,
        content: "",
        type: card.type,
        timestamp: card.timestamp || new Date().toISOString(),
        _method: "click-failed:" + (clickResult?.[0]?.result?.error || "unknown"),
      });
      continue;
    }

    // Wait for the detail view — poll up to 6 seconds for signals
    let detailOpened = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(1000);
      const check = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const bodyText = document.body.textContent || "";
          return {
            hasBanner: /saved\s+(responses?|notes?)\s+are\s+(view|read)/i.test(bodyText),
            hasBreadcrumb: /Studio\s*[>›»]\s/i.test(bodyText),
            hasConvertBtn: /convert to source/i.test(bodyText),
            url: window.location.href,
          };
        },
      });
      const st = check?.[0]?.result || {};
      if (st.hasBanner || st.hasBreadcrumb || st.hasConvertBtn || st.url !== baseUrl) {
        detailOpened = true;
        break;
      }
    }

    // Scrape the opened note content using multiple strategies
    const contentResult = await chrome.scripting.executeScript({
      target: { tabId },
      args: [card.title, detailOpened],
      func: (noteTitle, detailOpened) => {
        const isIconElement = (el) => {
          if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
          const tag = el.tagName?.toLowerCase() || "";
          const cls = (el.className || "").toString().toLowerCase();
          return tag === "mat-icon" || cls.includes("material-icons") || cls.includes("mat-icon");
        };
        const getCleanText = (node) => {
          let result = "";
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
            else if (child.nodeType === Node.ELEMENT_NODE) {
              if (child.tagName === "STYLE" || child.tagName === "SCRIPT") continue;
              if (isIconElement(child)) continue;
              result += getCleanText(child);
            }
          }
          return result;
        };
        const getCleanHtml = (node) => {
          const clone = node.cloneNode(true);
          clone.querySelectorAll("style, script, mat-icon, .material-icons").forEach(s => s.remove());
          return clone.innerHTML;
        };
        const isChrome = (text) => {
          if (/convert to source/i.test(text) && text.length < 80) return true;
          if (/saved\s+(responses?|notes?)\s+are/i.test(text) && text.length < 80) return true;
          if (/^Studio\s*[>›»]/i.test(text) && text.length < 40) return true;
          if (/^\d+\s*sources?$/i.test(text)) return true;
          return false;
        };

        const debug = {
          detailOpened,
          url: window.location.href,
          bodyLen: (document.body.textContent || "").length,
        };

        // === STRATEGY 1: Banner-anchored ===
        // Find "Saved responses are view only" or similar banner
        let bannerEl = null;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
        let wNode;
        while ((wNode = walker.nextNode())) {
          const t = wNode.textContent?.trim() || "";
          if (t.length > 200 || t.length < 5) continue;
          if (/saved\s+(responses?|notes?)\s+are\s+(view|read)/i.test(t) ||
              (t.length < 60 && /view[\-\s]*only/i.test(t) && !/chat|source/i.test(t))) {
            if (!bannerEl || t.length < bannerEl.textContent.length) {
              bannerEl = wNode;
            }
          }
        }

        if (bannerEl) {
          debug.bannerFound = true;
          let contentParent = bannerEl.parentElement;
          for (let i = 0; i < 5; i++) {
            if (!contentParent?.parentElement) break;
            if (contentParent.children.length >= 2) break;
            contentParent = contentParent.parentElement;
          }

          // Collect content after banner
          let contentParts = [];
          let htmlParts = [];
          const directChildren = Array.from(contentParent.children);
          let afterBanner = false;
          for (const child of directChildren) {
            if (child === bannerEl || child.contains(bannerEl)) { afterBanner = true; continue; }
            if (!afterBanner) continue;
            const text = getCleanText(child).trim();
            if (isChrome(text)) continue;
            if (text.length < 5) continue;
            contentParts.push(text);
            htmlParts.push(getCleanHtml(child));
          }
          if (contentParts.length > 0 && contentParts.join("").length > 20) {
            return { content: contentParts.join("\n\n"), html: htmlParts.join(""), method: "after-banner-siblings", debug };
          }

          // Deeper search
          const blocksAfter = [];
          let pastBanner = false;
          contentParent.querySelectorAll("div, p, section, article").forEach(el => {
            if (el === bannerEl || el.contains(bannerEl)) { pastBanner = true; return; }
            if (bannerEl.contains(el)) return;
            if (!pastBanner) return;
            const text = getCleanText(el).trim();
            if (text.length < 30 || isChrome(text)) return;
            blocksAfter.push({ text, html: getCleanHtml(el), len: text.length });
          });
          if (blocksAfter.length > 0) {
            blocksAfter.sort((a, b) => b.len - a.len);
            return { content: blocksAfter[0].text, html: blocksAfter[0].html, method: "after-banner-largest", debug };
          }

          // Strip parent
          const clone = contentParent.cloneNode(true);
          clone.querySelectorAll("style, script, mat-icon, .material-icons").forEach(s => s.remove());
          const toRemove = [];
          clone.querySelectorAll("*").forEach(el => {
            const t = el.textContent?.trim() || "";
            if (isChrome(t)) toRemove.push(el);
          });
          toRemove.forEach(el => { try { el.remove(); } catch {} });
          const text = getCleanText(clone).trim();
          if (text.length > 30) {
            return { content: text, html: clone.innerHTML.trim(), method: "banner-parent-stripped", debug };
          }
        }

        // === STRATEGY 2: Breadcrumb-anchored ===
        // Find "Studio > Note" or "Studio > ..." breadcrumb
        let breadcrumbEl = null;
        const allEls2 = document.querySelectorAll("*");
        for (const el of allEls2) {
          const t = getCleanText(el).trim();
          if (t.length > 60) continue;
          if (/^Studio\s*[>›»]\s*(Note|Saved)/i.test(t)) {
            breadcrumbEl = el;
            break;
          }
        }

        if (breadcrumbEl) {
          debug.breadcrumbFound = true;
          // Walk up to the note panel
          let panel = breadcrumbEl;
          for (let i = 0; i < 8; i++) {
            if (!panel.parentElement) break;
            panel = panel.parentElement;
            const rect = panel.getBoundingClientRect();
            if (rect.height > 300 && rect.width > 200 && rect.width < 900) break;
          }

          // Find note title then content after it
          const headings = panel.querySelectorAll("h1, h2, h3, [role='heading']");
          let titleEl = null;
          for (const h of headings) {
            const ht = getCleanText(h).trim();
            if (ht.length < 3) continue;
            if (ht === noteTitle || noteTitle.startsWith(ht) || ht.startsWith(noteTitle.substring(0, 20))) {
              titleEl = h;
              break;
            }
          }

          // Extract content blocks from panel
          const blocks = [];
          panel.querySelectorAll("div, p, section, article").forEach(el => {
            if (titleEl && (el === titleEl || el.contains(titleEl) || titleEl.contains(el))) return;
            if (el.contains(breadcrumbEl)) return;
            const text = getCleanText(el).trim();
            if (text.length < 30 || isChrome(text)) return;
            blocks.push({ text, html: getCleanHtml(el), len: text.length });
          });
          if (blocks.length > 0) {
            blocks.sort((a, b) => b.len - a.len);
            return { content: blocks[0].text, html: blocks[0].html, method: "breadcrumb-panel", debug };
          }
        }

        // === STRATEGY 3: Title-anchored ===
        // Find the note title heading in the detail view and grab adjacent content
        if (noteTitle && noteTitle.length > 3) {
          const headings = document.querySelectorAll("h1, h2, h3, h4, [role='heading']");
          let titleEl = null;
          for (const h of headings) {
            const ht = getCleanText(h).trim();
            if (!ht || ht.length < 3) continue;
            const rect = h.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (ht === noteTitle || noteTitle.startsWith(ht) || ht.startsWith(noteTitle.substring(0, 15))) {
              titleEl = h; // prefer last match (detail usually rendered after list)
            }
          }

          if (titleEl) {
            debug.titleFound = getCleanText(titleEl).trim().substring(0, 60);
            let container = titleEl.parentElement;
            for (let i = 0; i < 6; i++) {
              if (!container?.parentElement) break;
              const rect = container.getBoundingClientRect();
              if (rect.height > 200 && rect.width > 200) break;
              container = container.parentElement;
            }

            const blocks = [];
            container.querySelectorAll("div, p, section, article").forEach(el => {
              if (el === titleEl || el.contains(titleEl) || titleEl.contains(el)) return;
              const text = getCleanText(el).trim();
              if (text.length < 30 || isChrome(text)) return;
              blocks.push({ text, html: getCleanHtml(el), len: text.length });
            });
            if (blocks.length > 0) {
              blocks.sort((a, b) => b.len - a.len);
              return { content: blocks[0].text, html: blocks[0].html, method: "title-anchored", debug };
            }
          }
        }

        return { content: "", html: "", method: "no-content-found", debug };
      },
    });

    const scraped = contentResult?.[0]?.result || {};

    let hash = 0;
    for (let i = 0; i < card.title.length; i++) {
      hash = (hash << 5) - hash + card.title.charCodeAt(i);
      hash |= 0;
    }

    notes.push({
      id: "note-" + Math.abs(hash).toString(36),
      title: card.title,
      content: scraped.content || "",
      html: scraped.html || "",
      type: card.type,
      timestamp: card.timestamp || new Date().toISOString(),
      _debug: scraped.debug || {},
      _method: scraped.method || "unknown",
    });

    // Go back to the notes list
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const isIconElement = (el) => {
          if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
          const tag = el.tagName?.toLowerCase() || "";
          const cls = (el.className || "").toString().toLowerCase();
          return tag === "mat-icon" || cls.includes("material-icons") || cls.includes("mat-icon");
        };
        const getCleanText = (node) => {
          let result = "";
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
            else if (child.nodeType === Node.ELEMENT_NODE) {
              if (child.tagName === "STYLE" || child.tagName === "SCRIPT") continue;
              if (isIconElement(child)) continue;
              result += getCleanText(child);
            }
          }
          return result;
        };

        // Try breadcrumb "Studio" link
        const allEls = document.querySelectorAll("a, button, [role='button'], [role='link'], span");
        for (const el of allEls) {
          const text = getCleanText(el).trim();
          if (/^Studio$/i.test(text) && (el.tagName === "A" || el.getAttribute("role") === "link")) {
            el.click();
            return "breadcrumb-studio";
          }
        }

        // Try back/close button (including mat-icon "arrow_back")
        for (const btn of allEls) {
          const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
          const raw = (btn.textContent || "").trim().toLowerCase();
          if (aria.includes("back") || aria.includes("close") || raw === "arrow_back" || raw === "close") {
            btn.click();
            return "back-button";
          }
        }

        // Fallback: Escape
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        return "escape";
      },
    });

    await sleep(1500);
  }

  return notes;
}

/**
 * Backward sync: extracts notes from NotebookLM and imports to Zotero.
 */
async function backwardSync(collectionId, customTags) {
  // Prefer the notebook that this collection was originally mapped to, so that
  // if the user has multiple NotebookLM tabs open we pull notes from the right one.
  let preferredNotebookId = null;
  try {
    const mappingsRes = await getMappings();
    const mapping = (mappingsRes?.data || []).find(
      (m) => m.collectionId === collectionId
    );
    if (mapping?.notebookId) preferredNotebookId = mapping.notebookId;
  } catch {
    // Non-fatal — fall through to active-tab resolution.
  }

  const { tab, reason } = await resolveNotebookLMTab(preferredNotebookId);
  if (!tab) {
    return {
      success: false,
      error:
        reason === "ambiguous"
          ? AMBIGUOUS_TAB_ERROR
          : "No NotebookLM tab found. Please open NotebookLM first.",
    };
  }

  if (activeSyncs.has(tab.id)) {
    return {
      success: false,
      error: "A sync is already running on this NotebookLM tab.",
    };
  }
  activeSyncs.add(tab.id);
  try {
    return await backwardSyncImpl(tab, collectionId, customTags);
  } finally {
    activeSyncs.delete(tab.id);
  }
}

async function backwardSyncImpl(tab, collectionId, customTags) {
  const notebookId = extractNotebookIdFromUrl(tab.url);

  let notes;
  try {
    notes = await extractNotesFromTab(tab.id);
  } catch (e) {
    return { success: false, error: `Could not extract notes: ${e.message}` };
  }

  if (!notes || notes.length === 0) {
    return {
      success: true,
      message: "No notes found in this notebook.",
      imported: 0,
    };
  }

  const payloads = notes.map((note) => ({
    collectionId,
    notebookId: notebookId || "",
    noteTitle: note.title,
    noteContent: note.html || note.content,
    noteType: note.type || "saved-note",
    sourceUrl: tab.url,
    tags: customTags || [],
    timestamp: note.timestamp || new Date().toISOString(),
    noteExternalId: note.id,
  }));

  const result = await importNotesToZotero(payloads);
  if (!result.success) {
    return { success: false, error: result.error || "Failed to import notes" };
  }

  const importedCount = (result.data || []).filter((r) => r !== null).length;
  const skippedCount = (result.data || []).filter((r) => r === null).length;

  return {
    success: true,
    message: `Imported ${importedCount} notes (${skippedCount} duplicates skipped).`,
    imported: importedCount,
    skipped: skippedCount,
    total: notes.length,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Message handlers ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    switch (message.type) {
      case "n2z-check-connection":
        return { connected: await checkZoteroConnection() };

      case "n2z-get-collections":
        return getCollections(message.libraryId);

      case "n2z-get-mappings":
        return getMappings();

      case "n2z-remove-mapping":
        return removeMapping(message.collectionId);

      case "n2z-forward-sync":
        return forwardSync(message.collectionId, message.collectionName);

      case "n2z-backward-sync":
        return backwardSync(message.collectionId, message.customTags);

      case "n2z-get-notebooklm-tab": {
        const { tab, reason } = await resolveNotebookLMTab();
        if (tab) {
          return {
            success: true,
            data: {
              id: tab.id,
              url: tab.url,
              notebookId: extractNotebookIdFromUrl(tab.url),
            },
          };
        }
        return {
          success: false,
          error:
            reason === "ambiguous"
              ? AMBIGUOUS_TAB_ERROR
              : "No NotebookLM tab found",
        };
      }

      case "n2z-get-items":
        return getExportableItems(message.collectionId);

      case "n2z-clear-sync-state": {
        // Clear all sync states for this collection (across all notebooks)
        const allKeys = await chrome.storage.local.get(null);
        const keysToRemove = Object.keys(allKeys).filter(
          (k) => k.startsWith(`sync_${message.collectionId}_`) || k === `sync_${message.collectionId}`
        );
        if (keysToRemove.length > 0) {
          await chrome.storage.local.remove(keysToRemove);
        }
        return { success: true, message: "Sync state cleared" };
      }

      case "n2z-extract-notes": {
        const { tab: nlmTab, reason: extractReason } =
          await resolveNotebookLMTab();
        if (!nlmTab) {
          return {
            success: false,
            error:
              extractReason === "ambiguous"
                ? AMBIGUOUS_TAB_ERROR
                : "No NotebookLM tab found",
          };
        }
        try {
          const notes = await extractNotesFromTab(nlmTab.id);
          return { success: true, data: notes, debug: notes.length === 0 ? `Page: ${nlmTab.title}` : undefined };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      case "n2z-import-selected-notes": {
        // Import pre-extracted notes (selected by user in popup) into Zotero
        const { tab: nlmTab2 } = await resolveNotebookLMTab();
        const notebookId2 = nlmTab2 ? extractNotebookIdFromUrl(nlmTab2.url) : "";
        const notes = message.notes || [];
        if (notes.length === 0) {
          return { success: false, error: "No notes to import" };
        }

        const payloads = notes.map((note) => ({
          collectionId: message.collectionId,
          notebookId: notebookId2 || "",
          noteTitle: note.title,
          noteContent: note.html || note.content,
          noteType: note.type || "saved-note",
          sourceUrl: nlmTab2?.url || "",
          tags: message.customTags || [],
          timestamp: note.timestamp || new Date().toISOString(),
          noteExternalId: note.id,
        }));

        const importResult = await importNotesToZotero(payloads);
        if (!importResult.success) {
          return { success: false, error: importResult.error || "Failed to import notes" };
        }

        const imported = (importResult.data || []).filter((r) => r !== null).length;
        const skipped = (importResult.data || []).filter((r) => r === null).length;

        return {
          success: true,
          message: `Imported ${imported} notes${skipped > 0 ? ` (${skipped} duplicates skipped)` : ""}.`,
          imported,
          skipped,
          total: notes.length,
        };
      }

      default:
        return { success: false, error: "Unknown message type" };
    }
  };

  handler()
    .then(sendResponse)
    .catch((e) => sendResponse({ success: false, error: e.message }));

  return true;
});
