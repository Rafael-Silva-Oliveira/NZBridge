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

// Tabs whose in-progress forward sync the user asked to cancel. The sync loop
// checks this at safe checkpoints (before each file batch / the URL phase) and
// stops cleanly, leaving already-uploaded sources in place. Keyed by tabId.
const cancelledSyncs = new Set();

// Stores the last known progress/result for each tabId so the popup can
// poll for updates without a long-lived message channel.
// Shape: { phase, current, total, currentTitle, done, result }
const syncProgress = new Map();

// Gemini Notebook now uses notebook.google.com. Keep the legacy NotebookLM
// host during the rollout because existing accounts and links may use either.
const NOTEBOOK_URL_PATTERNS = [
  "https://notebook.google.com/*",
  "https://notebooklm.google.com/*",
];

function isNotebookUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      ["notebook.google.com", "notebooklm.google.com"].includes(
        parsed.hostname,
      ) && parsed.pathname.startsWith("/notebook/")
    );
  } catch {
    return false;
  }
}
const AMBIGUOUS_TAB_ERROR =
  "Multiple NotebookLM tabs are open. Please switch to the notebook you want to sync into and try again.";

// ─── File-upload tuning ──────────────────────────────────────────────
// Files are uploaded in batches (one Add-sources dialog cycle per batch).
// Each batch is dropped exactly ONCE; we then wait for NotebookLM to finish
// processing it (source count grows and the spinner clears) before opening the
// next dialog. We never re-drop a batch — re-dropping while the first upload is
// still in flight is what caused duplicate sources.
const FILE_BATCH_SIZE = 4; // files per dialog open/drop/close cycle
const SETTLE_TIMEOUT_MS = 45000; // max wait for a batch to finish processing
const SETTLE_POLL_MS = 500; // poll cadence while waiting to settle
const SETTLE_QUIET_MS = 1200; // require the count stable + not busy this long
const SETTLE_FALLBACK_SLEEP_MS = 4000; // used only when the panel is unreadable

// The "Upload files" button click can transiently miss when the dialog UI isn't
// fully interactive yet (button not hit-testable, or rendered a frame late), so
// the file chooser never opens. Rather than fail the whole batch on a single
// miss, we re-read fresh coords and re-fire the trusted click a few times, each
// with a short chooser timeout so a miss is detected fast instead of burning a
// long budget. If every drop attempt still misses, the batch is retried wholesale
// (a fresh dialog cycle), which is what a manual re-sync did by hand.
const UPLOAD_CLICK_ATTEMPTS = 3; // trusted-click → file-chooser retries per drop
const CHOOSER_ATTEMPT_TIMEOUT_MS = 5000; // per-attempt wait for Page.fileChooserOpened
const BATCH_UPLOAD_ATTEMPTS = 3; // full drop+settle retries before giving up on a batch

// ─── Zotero API helpers ──────────────────────────────────────────────

// Chrome/Edge 142+ "Local Network Access" classifies the extension service
// worker as a "public" origin and blocks requests to loopback targets
// (localhost:23119) unless the user grants the "Local network access"
// permission. A service worker cannot trigger that prompt itself, so the
// fetch fails/hangs. We surface this guidance whenever a connection can't be
// established so the user (or IT) knows the exact toggle to flip.
const LNA_HINT =
  "If Zotero is running, Chrome/Edge may be blocking the local connection. " +
  "Open chrome://extensions → NZBridge → Details → Site settings, and set " +
  '"Local network access" to Allow, then try again. (Edge: edge://extensions)';

// Default timeout for normal API calls. Short so connection/collection checks
// fail fast instead of hanging until the popup's message timeout.
const ZOTERO_TIMEOUT_MS = 8000;
// File transfers (/n2z/file) return base64 PDFs and can be large; give them
// a much longer budget.
const ZOTERO_FILE_TIMEOUT_MS = 60000;

async function zoteroRequest(
  path,
  body = null,
  { timeoutMs = ZOTERO_TIMEOUT_MS } = {},
) {
  const options = {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "Zotero-Allowed-Request": "true",
    },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${ZOTERO_BASE}${path}`, options);
  } catch (e) {
    // AbortSignal.timeout() throws TimeoutError; a network/LNA block throws
    // TypeError ("Failed to fetch"). Both mean "couldn't reach Zotero" — tag
    // with a code so callers can render the right guidance.
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    const err = new Error(
      (timedOut
        ? "Connection to Zotero timed out. "
        : "Could not reach Zotero on localhost:23119. ") + LNA_HINT,
    );
    err.code = timedOut ? "timeout" : "blocked-or-down";
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Zotero returned HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(
      "Zotero returned a non-JSON response (plugin may have crashed).",
    );
  }
}

async function checkZoteroConnection() {
  try {
    const res = await zoteroRequest("/n2z/status");
    return { connected: res.success === true, reason: "ok" };
  } catch (e) {
    return { connected: false, reason: e?.code || "blocked-or-down" };
  }
}

async function getLibraries() {
  return zoteroRequest("/n2z/libraries", {});
}

async function getCollections(libraryId) {
  return zoteroRequest("/n2z/collections", { libraryId });
}

async function getTags(libraryId) {
  console.log(`[n2z] getTags(libraryId=${libraryId})`);
  const result = await zoteroRequest("/n2z/tags", { libraryId });
  console.log(`[n2z] getTags result:`, result);
  return result;
}

async function getExportableItems({ collectionId, libraryId, tag } = {}) {
  if (tag != null && libraryId != null) {
    return zoteroRequest("/n2z/list", { libraryId, tag });
  }
  return zoteroRequest("/n2z/list", { collectionId });
}

async function getFile(attachmentId) {
  return zoteroRequest(
    "/n2z/file",
    { attachmentId },
    { timeoutMs: ZOTERO_FILE_TIMEOUT_MS },
  );
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
  if (isNotebookUrl(active?.url)) {
    return { tab: active, reason: "active" };
  }

  const candidateTabs = await chrome.tabs.query({
    url: NOTEBOOK_URL_PATTERNS,
  });
  const allNotebookLMTabs = candidateTabs.filter((tab) =>
    isNotebookUrl(tab.url),
  );

  if (preferredNotebookId) {
    const match = allNotebookLMTabs.find((t) =>
      t.url?.includes(`/notebook/${preferredNotebookId}`),
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

// chrome.storage.local key for cached extracted notes of a notebook.
function notesCacheKey(notebookId) {
  return `extractedNotes_${notebookId}`;
}

// ─── Forward Sync ────────────────────────────────────────────────────

/**
 * Performs forward sync: gets items from Zotero and returns them
 * so the popup can display what will be synced. Actual injection
 * happens per-item via addUrlSource or file injection.
 */
async function forwardSync(
  collectionId,
  collectionName,
  selectedItemKeys,
  libraryId,
  libraryName,
  tag,
) {
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

  // Reset progress state for this tab
  syncProgress.set(tab.id, {
    phase: "starting",
    current: 0,
    total: 0,
    currentTitle: "",
    done: false,
    result: null,
  });

  // Run the sync in the background — do NOT await it here.
  // The popup polls for progress via n2z-sync-status.
  forwardSyncImpl(
    tab,
    notebookId,
    collectionId,
    collectionName,
    selectedItemKeys,
    libraryId,
    libraryName,
    tag,
  )
    .then((result) => {
      // Release the sync lock BEFORE broadcasting "done" so the popup's
      // post-sync re-render can reconcile against the tab (the reconcile
      // handler refuses to run while the tab is still in activeSyncs).
      activeSyncs.delete(tab.id);
      cancelledSyncs.delete(tab.id);
      syncProgress.set(tab.id, {
        ...syncProgress.get(tab.id),
        done: true,
        result,
      });
      broadcastProgress({ tabId: tab.id, done: true, result });
    })
    .catch((e) => {
      activeSyncs.delete(tab.id);
      cancelledSyncs.delete(tab.id);
      const result = { success: false, error: e.message };
      syncProgress.set(tab.id, {
        ...syncProgress.get(tab.id),
        done: true,
        result,
      });
      broadcastProgress({ tabId: tab.id, done: true, result });
    });

  return { success: true, started: true, tabId: tab.id };
}

async function forwardSyncImpl(
  tab,
  notebookId,
  collectionId,
  collectionName,
  selectedItemKeys,
  libraryId,
  libraryName,
  tag,
) {
  // 1b. Set notebook title to the collection/tag name (user can change it later)
  if (collectionName) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [collectionName],
      func: (name) => {
        // NotebookLM's notebook title is typically an editable input/textarea
        // at the top of the page, or a contenteditable heading
        const candidates = document.querySelectorAll(
          'input, textarea, [contenteditable="true"], [contenteditable=""]',
        );
        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          // Title is near the top of the page and reasonably wide
          if (rect.top > 200 || rect.width < 100 || rect.height === 0) continue;
          const tag = el.tagName.toLowerCase();
          if (tag === "input" || tag === "textarea") {
            // Only set if it's a default/untitled notebook name
            const val = el.value || "";
            if (
              !val ||
              /^untitled/i.test(val) ||
              /^new notebook/i.test(val) ||
              val.length < 3
            ) {
              const setter =
                tag === "textarea"
                  ? Object.getOwnPropertyDescriptor(
                      window.HTMLTextAreaElement.prototype,
                      "value",
                    )?.set
                  : Object.getOwnPropertyDescriptor(
                      window.HTMLInputElement.prototype,
                      "value",
                    )?.set;
              if (setter) setter.call(el, name);
              else el.value = name;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              el.dispatchEvent(new Event("blur", { bubbles: true }));
              return { success: true, method: "input" };
            }
            return {
              success: false,
              reason: "notebook-already-named",
              current: val,
            };
          }
          if (el.getAttribute("contenteditable") !== null) {
            const text = el.textContent?.trim() || "";
            if (
              !text ||
              /^untitled/i.test(text) ||
              /^new notebook/i.test(text) ||
              text.length < 3
            ) {
              el.textContent = name;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("blur", { bubbles: true }));
              return { success: true, method: "contenteditable" };
            }
            return {
              success: false,
              reason: "notebook-already-named",
              current: text,
            };
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
        return (
          tag === "mat-icon" ||
          cls.includes("material-icons") ||
          cls.includes("mat-icon")
        );
      };
      const getCleanText = (node) => {
        let result = "";
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
          else if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.tagName === "STYLE" || child.tagName === "SCRIPT")
              continue;
            if (isIconElement(child)) continue;
            result += getCleanText(child);
          }
        }
        return result;
      };
      const clickables = document.querySelectorAll(
        '[role="tab"], button, [role="button"], a, [class*="tab"]',
      );
      const sourceTabLabels = [
        "sources",
        "source",
        "来源",
        "來源",
        "ソース",
        "情報源",
        "소스",
        "출처",
        "fuentes",
        "sources",
        "quellen",
        "fontes",
        "fonti",
        "bronnen",
        "sumber",
      ];
      for (const el of clickables) {
        const text = getCleanText(el).trim().toLowerCase();
        if (sourceTabLabels.includes(text)) {
          el.click();
          return true;
        }
      }
      return false;
    },
  });
  await sleep(1000);

  // 2. Get exportable items from Zotero (by collection or by tag across a library)
  const itemsRes = tag
    ? await getExportableItems({ libraryId, tag })
    : await getExportableItems({ collectionId });
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

  // Note: NotebookLM Pro users can exceed 50 sources. We no longer block here;
  // free-tier users will see failures from NotebookLM itself for sources beyond the limit.

  // 3. Check for already-synced items. The durable record is the Zotero
  // mapping (survives reopen, shown in the Mappings tab); the local copy is a
  // cache. Seed from the mapping when it matches this notebook, then merge the
  // local cache so nothing is lost either way.
  const syncKey = `sync_${collectionId}_${notebookId}`;
  const syncState = await chrome.storage.local.get(syncKey);
  let syncedHashes = { ...(syncState[syncKey] || {}) };
  try {
    const existingMapping = await zoteroRequest("/n2z/mapping", {
      action: "get",
      collectionId,
    });
    if (
      existingMapping?.success &&
      existingMapping.data?.notebookId === notebookId
    ) {
      syncedHashes = {
        ...(existingMapping.data.syncedItemHashes || {}),
        ...syncedHashes,
      };
    }
  } catch {
    /* mapping fetch is best-effort; fall back to local cache */
  }

  const selectedSet = selectedItemKeys ? new Set(selectedItemKeys) : null;
  const newItems = items.filter(
    (item) =>
      !syncedHashes[item.itemKey] &&
      (!selectedSet || selectedSet.has(item.itemKey)),
  );

  if (newItems.length === 0) {
    const mapping = {
      collectionId,
      collectionName,
      libraryId,
      libraryName,
      notebookId,
      notebookUrl: tab.url,
      lastSyncForward: new Date().toISOString(),
      lastSyncBackward: null,
      syncedItemHashes: syncedHashes,
      importedNoteIds: [],
    };
    await setMapping(mapping);
    return {
      success: true,
      message: `All ${items.length} items are already synced to this notebook.`,
      synced: 0,
      total: items.length,
      mapping,
    };
  }

  // 4. Separate by type
  const urlItems = newItems.filter((i) => i.exportType === "url");
  const fileItems = newItems.filter((i) => i.exportType === "file");
  const allResults = [];
  const totalItems = newItems.length;
  let doneCount = 0;

  const emitProgress = (phase, currentTitle, files) => {
    const state = {
      phase,
      current: doneCount,
      total: totalItems,
      currentTitle: currentTitle || "",
      files: files || null,
      done: false,
      result: null,
    };
    syncProgress.set(tab.id, state);
    broadcastProgress({ tabId: tab.id, ...state });
  };

  // 5a. Add ALL URL sources at once (NotebookLM supports multiple URLs
  // separated by newlines in a single paste)
  if (urlItems.length > 0) {
    emitProgress(
      "urls",
      `Adding ${urlItems.length} URL${urlItems.length > 1 ? "s" : ""}...`,
    );
    try {
      const urls = urlItems.map((i) => i.url);
      const result = await addUrlSourcesBatch(tab.id, urls);
      const confirmed = result.success;

      // Build detailed error from step info
      let errorDetail = result.error || "";
      if (!confirmed && result.steps) {
        const failedStep = Object.entries(result.steps).find(
          ([, v]) => !v?.success,
        );
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
          __itemKey: item.itemKey,
        });
        // Provisional marker; the real NotebookLM label is bound after the sync
        // settles (step 6). `name`/`url` are fallbacks if label capture fails.
        if (confirmed) {
          syncedHashes[item.itemKey] = {
            at: Date.now(),
            name: item.title || item.url || "",
            url: item.url || "",
          };
        }
        doneCount++;
      }
    } catch (e) {
      for (const item of urlItems) {
        allResults.push({
          title: item.title,
          success: false,
          error: e.message,
          type: "url",
        });
        doneCount++;
      }
    }
  }

  // 5b. Add file sources via CDP — upload in batches of FILE_BATCH_SIZE
  // (NotebookLM's file input accepts multiple files at once). Each batch is
  // dropped once, then we wait for it to finish processing before the next.
  // See FILE_BATCH_SIZE / SETTLE_* constants.

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
        doneCount++;
      }
    }

    if (debuggerAttached) {
      try {
        // Fetch file data (base64) from Zotero for each file
        const resolvedFiles = [];
        for (const item of fileItems) {
          let fileRes;
          try {
            fileRes = await getFile(item.attachmentId);
          } catch (e) {
            // Connection/LNA failure or timeout — e.message carries the
            // chrome://extensions guidance. Record per-item and keep going.
            allResults.push({
              title: item.title,
              success: false,
              error: e.message,
              type: "file",
            });
            doneCount++;
            continue;
          }
          if (!fileRes.success || !fileRes.data) {
            allResults.push({
              title: item.title,
              success: false,
              error: "Could not fetch file from Zotero",
              type: "file",
            });
            doneCount++;
          } else {
            resolvedFiles.push({ item, fileData: fileRes.data });
          }
        }

        // Upload in batches via base64 drop. Each batch is dropped exactly
        // ONCE, then we wait for NotebookLM to finish ingesting it (source
        // count grows + spinner clears, held stable briefly) before opening
        // the next dialog. We never re-drop a batch — that was the cause of
        // duplicate sources. Already-synced items are skipped on the next sync
        // via syncedHashes, so a rare genuine miss is recovered then.
        for (let bi = 0; bi < resolvedFiles.length; bi += FILE_BATCH_SIZE) {
          // Cancel checkpoint: stop before starting a new batch (never mid-drop,
          // which would corrupt NotebookLM's dialog). Files already uploaded keep
          // their markers; remaining ones are recorded as cancelled.
          if (cancelledSyncs.has(tab.id)) {
            for (let j = bi; j < resolvedFiles.length; j++) {
              allResults.push({
                title: resolvedFiles[j].item.title,
                success: false,
                error: "Cancelled",
                type: "file",
                __itemKey: resolvedFiles[j].item.itemKey,
              });
            }
            break;
          }
          const batch = resolvedFiles.slice(bi, bi + FILE_BATCH_SIZE);
          const t0 = Date.now();

          const batchFileData = batch.map((p) => ({
            base64: p.fileData.base64,
            filename: p.fileData.filename,
            contentType: p.fileData.contentType || "application/pdf",
          }));

          // Show every file in this batch as a bulleted list in the popup.
          const batchTitles = batch.map((p) => p.item.title);
          const batchLabel =
            batch.length > 1
              ? `Uploading ${batch.length} files`
              : "Uploading 1 file";
          emitProgress("files", batchLabel, batchTitles);

          // Drop the batch and wait for it to land. We retry the whole cycle ONLY
          // when the drop itself failed (res.success === false) — i.e. the click
          // missed and the file chooser never opened, so provably ZERO files were
          // added and re-dropping is safe. This is the reported bug, and re-opening
          // a fresh dialog is exactly what a manual re-sync did by hand.
          //
          // We deliberately do NOT re-drop when the drop succeeded but the count
          // didn't confirm in time (slow ingestion): re-dropping there could
          // double-add files that were merely slow to land. Those are left
          // "Upload not confirmed" and recovered on the next sync via syncedHashes
          // (which only re-adds items NOT already marked synced). The Step-0
          // stale-dialog cleanup in injectFilesBatchViaCDP closes any dialog a
          // failed click attempt left open, so retries can't duplicate.
          let ok = false;
          let res = { success: false };
          let before = { count: null };
          let after = { count: null, busy: false, method: null };
          let landed = false;
          let attempts = 0;
          for (let a = 1; a <= BATCH_UPLOAD_ATTEMPTS; a++) {
            // Cancel checkpoint between attempts (never mid-drop).
            if (a > 1 && cancelledSyncs.has(tab.id)) break;
            attempts = a;

            before = await getSourceState(tab.id);
            res = await injectFilesBatchViaCDP(tab.id, batchFileData);

            // Only wait for the count to climb if the drop actually reported
            // success — otherwise no files were added and a 45s wait is wasted.
            landed = false;
            if (res.success) {
              if (before.count == null) {
                await sleep(SETTLE_FALLBACK_SLEEP_MS);
                landed = true; // best effort: panel unreadable, trust the drop
              } else {
                const target = before.count + batch.length;
                const deadline = Date.now() + SETTLE_TIMEOUT_MS;
                let reachedSince = null;
                while (Date.now() < deadline) {
                  const st = await getSourceState(tab.id);
                  const reached = st.count != null && st.count >= target;
                  if (reached) {
                    reachedSince = reachedSince ?? Date.now();
                    if (Date.now() - reachedSince >= SETTLE_QUIET_MS) {
                      landed = true;
                      break;
                    }
                  } else {
                    reachedSince = null;
                  }
                  await sleep(SETTLE_POLL_MS);
                }
              }
            }

            after = await getSourceState(tab.id);
            // Confirmed only when the full batch landed (count reached target) or
            // the panel was unreadable and the drop reported success. We don't
            // mark synced on a partial — better to re-sync the whole batch later
            // (a re-sync only re-adds items NOT in syncedHashes) than to falsely
            // skip a missing file.
            const fullTarget =
              before.count != null ? before.count + batch.length : null;
            ok =
              (before.count == null && landed) ||
              (fullTarget != null &&
                after.count != null &&
                after.count >= fullTarget);
            if (ok) break;
            // Re-drop only on a failed drop (zero files added). A successful drop
            // that didn't confirm is left for next-sync recovery — never re-dropped.
            if (res.success) break;
            if (a < BATCH_UPLOAD_ATTEMPTS)
              console.log(
                `[n2z] batch@${bi}: drop attempt ${a}/${BATCH_UPLOAD_ATTEMPTS} failed ` +
                  `(${res.error || "unknown"}); retrying`,
              );
          }

          for (const p of batch) {
            allResults.push({
              title: p.item.title,
              success: ok,
              error: ok ? undefined : "Upload not confirmed",
              type: "file",
              __itemKey: p.item.itemKey,
            });
            // Provisional marker; the real NotebookLM label is bound after the
            // sync settles (step 6). `name` is a fallback if capture fails.
            if (ok)
              syncedHashes[p.item.itemKey] = {
                at: Date.now(),
                name: p.fileData.filename || p.item.title || "",
              };
            doneCount++;
          }

          console.log(
            `[n2z] batch@${bi}: dropped ${batch.length}, ok=${ok}, attempts=${attempts}, ` +
              `before=${before.count}, after=${after.count}, landed=${landed}, busy=${after.busy}, ` +
              `drop=${res.success}, method=${after.method}, ${Date.now() - t0}ms`,
          );
        }
      } finally {
        try {
          await chrome.debugger.detach({ tabId: tab.id });
        } catch {}
      }
    }
  }

  // 6. Bind each just-synced item to its ACTUAL NotebookLM source, so reconcile
  // can later tell precisely whether that source still exists. The debugger is
  // detached and uploads are done, so the panel is safe to read.
  //   - URL items: matched to a live source by FAVICON DOMAIN (the source URL
  //     NotebookLM encodes in the favicon) — exact and order-independent.
  //   - PDF items: no favicon URL, so matched positionally to the remaining
  //     (non-URL) live sources, which appear in upload order.
  // We persist `label` (exact untruncated name) and `faviconDomain` per item;
  // reconcile checks those against the live list with no fuzzy matching.
  try {
    for (let i = 0; i < 6; i++) {
      const st = await getSourceState(tab.id);
      if (st && !st.busy) break;
      await sleep(1000);
    }
    const liveSources = await getSourceNames(tab.id); // [{label, faviconDomain}]
    if (liveSources && liveSources.length) {
      const norm = (u) => normalizeSourceUrl(u);

      // Match URL items by favicon domain.
      const remaining = [...liveSources];
      for (const r of allResults) {
        if (!r.success || r.type !== "url" || !r.__itemKey) continue;
        const marker = syncedHashes[r.__itemKey];
        if (!marker || typeof marker !== "object") continue;
        const wantUrl = norm(marker.url);
        const hitIdx = remaining.findIndex(
          (s) =>
            s.faviconDomain && wantUrl && norm(s.faviconDomain) === wantUrl,
        );
        if (hitIdx !== -1) {
          marker.label = remaining[hitIdx].label || marker.name;
          marker.faviconDomain = remaining[hitIdx].faviconDomain;
          remaining.splice(hitIdx, 1); // consume so duplicates map 1:1
        }
      }

      // Match file (PDF) items by EXACT filename: NotebookLM labels an uploaded
      // PDF with its filename (e.g. "Heeke et al. - 2024 - …su.pdf"), which is
      // exactly `fileData.filename` (stored as the marker's `name`). Fall back
      // to positional binding only if the exact match misses.
      const fileLeftovers = remaining.filter((s) => !s.faviconDomain);
      for (const r of allResults) {
        if (!r.success || r.type !== "file" || !r.__itemKey) continue;
        const marker = syncedHashes[r.__itemKey];
        if (!marker || typeof marker !== "object") continue;
        const want = String(marker.name || "").trim();
        let hitIdx = want
          ? fileLeftovers.findIndex(
              (s) => String(s.label || "").trim() === want,
            )
          : -1;
        if (hitIdx === -1) hitIdx = 0; // positional fallback (upload order)
        const src = fileLeftovers[hitIdx];
        if (src && src.label) {
          marker.label = src.label;
          fileLeftovers.splice(hitIdx, 1);
        }
      }
    }
  } catch (e) {
    console.warn("[n2z] Could not capture source mapping:", e);
  }

  // 6b. Save sync state (keyed by collection+notebook pair)
  await chrome.storage.local.set({
    [syncKey]: syncedHashes,
  });

  // 7. Update mapping in Zotero
  const mapping = {
    collectionId,
    collectionName,
    libraryId,
    libraryName,
    notebookId,
    notebookUrl: tab.url,
    lastSyncForward: new Date().toISOString(),
    lastSyncBackward: null,
    syncedItemHashes: syncedHashes,
    importedNoteIds: [],
  };
  await setMapping(mapping);

  const successCount = allResults.filter((r) => r.success).length;
  const failCount = allResults.filter((r) => !r.success).length;
  const wasCancelled = cancelledSyncs.has(tab.id);

  let message = wasCancelled
    ? `Sync cancelled — ${successCount} of ${newItems.length} uploaded before stopping.`
    : `Synced ${successCount}/${newItems.length} items (${urlItems.length} URLs, ${fileItems.length} files).`;
  if (failCount > 0 && !wasCancelled) {
    const failed = allResults.filter((r) => !r.success);
    const titlePreview = failed
      .slice(0, 5)
      .map((r) => `"${r.title}"`)
      .join(", ");
    const remaining = failed.length - 5;
    const titleSuffix = remaining > 0 ? `, +${remaining} more` : "";
    message += ` ${failCount} failed: ${titlePreview}${titleSuffix}.`;

    const errorCounts = new Map();
    for (const r of failed) {
      const key = r.error || "Unknown error";
      errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
    }
    const grouped = Array.from(errorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([err, count]) => `${count}x "${err}"`)
      .join("; ");
    message += ` Errors: ${grouped}`;
  }

  return {
    success: successCount > 0 || failCount === 0,
    cancelled: wasCancelled,
    message,
    synced: successCount,
    failed: failCount,
    total: items.length,
    results: allResults,
    mapping,
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

  // Step 0: Close any dialog left open by a previous phase (e.g. the PDF
  // upload), so Step 1 opens a fresh Add-sources chooser rather than acting on
  // a stale one. Ignores the hidden 0×0 emoji-keyboard dialog.
  const staleOpen = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const dlgs = [
        ...document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
      ];
      return dlgs.some((d) => {
        const s = window.getComputedStyle(d);
        if (s.display === "none" || s.visibility === "hidden") return false;
        const r = d.getBoundingClientRect();
        return r.width > 50 && r.height > 50;
      });
    },
  });
  if (staleOpen?.[0]?.result) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
          }),
        ),
    });
    await sleep(600);
  }

  // Step 1: Click "Add sources" button
  const step1 = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const getCleanText = (el) => {
        let t = "";
        for (const c of el.childNodes) {
          if (c.nodeType === 3) t += c.textContent;
          else if (c.nodeType === 1) {
            const tag = c.tagName?.toLowerCase() || "";
            const cls = (c.className || "").toString().toLowerCase();
            if (
              tag === "mat-icon" ||
              cls.includes("material-icons") ||
              cls.includes("mat-icon")
            )
              continue;
            t += getCleanText(c);
          }
        }
        return t.trim();
      };
      const hasAny = (text, labels) =>
        labels.some((label) => text.includes(label));
      const addSourceLabels = [
        "add source",
        "add sources",
        "add a source",
        "添加来源",
        "添加源",
        "新增来源",
        "加入来源",
        "添加來源",
        "新增來源",
        "加入來源",
        "ソースを追加",
        "情報源を追加",
        "소스 추가",
        "출처 추가",
        "añadir fuente",
        "añadir fuentes",
        "agregar fuente",
        "agregar fuentes",
        "ajouter une source",
        "ajouter des sources",
        "quelle hinzufügen",
        "quellen hinzufügen",
        "adicionar fonte",
        "adicionar fontes",
        "aggiungi fonte",
        "aggiungi fonti",
        "bron toevoegen",
        "bronnen toevoegen",
        "tambahkan sumber",
      ];

      const candidates = document.querySelectorAll(
        'button, [role="button"], a, [tabindex="0"]',
      );
      for (const el of candidates) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const clean = getCleanText(el).toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        if (hasAny(clean, addSourceLabels) || hasAny(aria, addSourceLabels)) {
          el.click();
          return { success: true, clicked: clean || aria };
        }
      }
      const visible = Array.from(candidates)
        .filter((e) => {
          const s = window.getComputedStyle(e);
          return s.display !== "none" && s.visibility !== "hidden";
        })
        .map((e) => getCleanText(e))
        .filter((t) => t && t.length < 40)
        .slice(0, 10);
      return {
        success: false,
        error: "No Add sources button found. Visible: " + visible.join(", "),
      };
    },
  });
  steps.step1 = step1?.[0]?.result;
  if (!steps.step1?.success) return { ...steps.step1, steps };

  await sleep(2000);

  // Step 2: Click the "Website"/link option INSIDE the Add-sources dialog.
  // Critically scoped to the dialog: NotebookLM's left panel has its own
  // "Search the web" box with a "Web" control and a textarea — if we search
  // page-wide we paste URLs there instead of importing them as sources.
  const step2 = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const getCleanText = (el) => {
        let t = "";
        for (const c of el.childNodes) {
          if (c.nodeType === 3) t += c.textContent;
          else if (c.nodeType === 1) {
            const tag = c.tagName?.toLowerCase() || "";
            const cls = (c.className || "").toString().toLowerCase();
            if (
              tag === "mat-icon" ||
              cls.includes("material-icons") ||
              cls.includes("mat-icon")
            )
              continue;
            t += getCleanText(c);
          }
        }
        return t.trim();
      };
      // Pick the real, VISIBLE Add-sources dialog. NotebookLM may keep a stray
      // hidden emoji-keyboard dialog ([role=dialog], 0×0) in the DOM, so we must
      // not grab the first match — choose the largest visible one.
      const dialog = (() => {
        const all = [
          ...document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
        ];
        const visible = all.filter((d) => {
          const s = window.getComputedStyle(d);
          if (s.display === "none" || s.visibility === "hidden") return false;
          const r = d.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        });
        visible.sort((a, b) => {
          const ra = a.getBoundingClientRect(),
            rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        return visible[0] || null;
      })();
      if (!dialog)
        return { success: false, error: "Add-sources dialog not open" };

      // The dialog has TWO text areas: a "Search the web" box (always visible)
      // and the URL-paste box that only appears after clicking "Website". Only
      // treat the dialog as ready if a PASTE/LINK/URL field is present — never
      // the search box (else we'd type URLs into web-search).
      const pasteHints = [
        "paste",
        "link",
        "url",
        "粘贴",
        "貼上",
        "链接",
        "連結",
        "网址",
        "網址",
        "リンク",
        "링크",
        "enlace",
        "lien",
        "tautan",
      ];
      const searchHints = [
        "search",
        "搜索",
        "搜尋",
        "検索",
        "검색",
        "buscar",
        "rechercher",
        "suche",
        "pesquisar",
        "cerca",
        "zoek",
        "cari",
      ];
      const fieldLooksLikePaste = (f) => {
        const ph = (
          (f.getAttribute("placeholder") || "") +
          " " +
          (f.getAttribute("aria-label") || "")
        ).toLowerCase();
        if (searchHints.some((h) => ph.includes(h))) return false;
        return pasteHints.some((h) => ph.includes(h));
      };
      const hasPasteField = [
        ...dialog.querySelectorAll(
          "textarea, input[type='text'], input[type='url']",
        ),
      ].some((f) => {
        const s = window.getComputedStyle(f);
        return (
          s.display !== "none" &&
          s.visibility !== "hidden" &&
          fieldLooksLikePaste(f)
        );
      });
      if (hasPasteField)
        return {
          success: true,
          clicked: "(url paste field already present)",
          method: "already-open",
        };

      const websiteLabels = [
        "website",
        "websites",
        "link",
        "links",
        "url",
        "urls",
        "网站",
        "网页",
        "链接",
        "網址",
        "網站",
        "網頁",
        "連結",
        "ウェブサイト",
        "リンク",
        "웹사이트",
        "링크",
        "sitio web",
        "sitios web",
        "enlace",
        "site web",
        "sites web",
        "lien",
        "webseite",
        "webseiten",
        "site",
        "sites",
        "sito web",
        "siti web",
        "website",
        "webpagina",
        "situs web",
        "tautan",
      ];
      // Only consider clickables INSIDE the dialog.
      const clickables = dialog.querySelectorAll(
        'button, [role="button"], [role="menuitem"], [role="option"], [tabindex="0"], a, mat-chip, [class*="chip"]',
      );
      for (const el of clickables) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const clean = getCleanText(el).toLowerCase();
        if (
          websiteLabels.includes(clean) &&
          (el.textContent || "").length < 100
        ) {
          el.click();
          return { success: true, clicked: clean, tag: el.tagName };
        }
      }
      // Fallback: contains a website/link label.
      for (const el of clickables) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const raw = (el.textContent || "").trim().toLowerCase();
        if (
          raw.length < 100 &&
          websiteLabels.some((label) => raw.includes(label))
        ) {
          el.click();
          return {
            success: true,
            clicked: raw.substring(0, 50),
            tag: el.tagName,
            method: "contains",
          };
        }
      }
      const visible = Array.from(clickables)
        .filter((e) => {
          const s = window.getComputedStyle(e);
          return s.display !== "none" && s.visibility !== "hidden";
        })
        .map((e) => getCleanText(e))
        .filter((t) => t && t.length < 40)
        .slice(0, 15);
      return {
        success: false,
        error: "No Website option in dialog. Visible: " + visible.join(", "),
      };
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
      const urlFieldLabels = [
        "paste",
        "link",
        "url",
        "粘贴",
        "貼上",
        "链接",
        "連結",
        "网址",
        "網址",
        "貼り付け",
        "リンク",
        "url",
        "붙여넣",
        "링크",
        "pegar",
        "enlace",
        "url",
        "coller",
        "lien",
        "einfügen",
        "link",
        "colar",
        "link",
        "incolla",
        "link",
        "plakken",
        "link",
        "tempel",
        "tautan",
      ];
      // Scope to the Add-sources dialog so we never type into the left-side
      // "Search the web" box (which has its own textarea).
      // Pick the real, VISIBLE Add-sources dialog. NotebookLM may keep a stray
      // hidden emoji-keyboard dialog ([role=dialog], 0×0) in the DOM, so we must
      // not grab the first match — choose the largest visible one.
      const dialog = (() => {
        const all = [
          ...document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
        ];
        const visible = all.filter((d) => {
          const s = window.getComputedStyle(d);
          if (s.display === "none" || s.visibility === "hidden") return false;
          const r = d.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        });
        visible.sort((a, b) => {
          const ra = a.getBoundingClientRect(),
            rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        return visible[0] || null;
      })();
      if (!dialog)
        return {
          success: false,
          error: "Add-sources dialog not open (URL field step)",
        };

      const searchHints = [
        "search",
        "搜索",
        "搜尋",
        "検索",
        "검색",
        "buscar",
        "rechercher",
        "suche",
        "pesquisar",
        "cerca",
        "zoek",
        "cari",
      ];
      const fieldMeta = (f) =>
        (
          (f.getAttribute("placeholder") || "") +
          " " +
          (f.getAttribute("aria-label") || "")
        ).toLowerCase();
      const isSearchField = (f) =>
        searchHints.some((h) => fieldMeta(f).includes(h));
      const isVisible = (f) => {
        const s = window.getComputedStyle(f);
        return s.display !== "none" && s.visibility !== "hidden";
      };

      // Priority 1: field whose placeholder/aria looks like paste/link/url
      // (and NOT search), inside the dialog.
      let field = null;
      const allFieldsList = [
        ...dialog.querySelectorAll(
          "textarea, input[type='text'], input[type='url']",
        ),
      ];
      for (const f of allFieldsList) {
        if (!isVisible(f) || isSearchField(f)) continue;
        if (urlFieldLabels.some((label) => fieldMeta(f).includes(label))) {
          field = f;
          break;
        }
      }
      // Priority 2: any visible textarea that is NOT the search box.
      if (!field) {
        for (const ta of dialog.querySelectorAll("textarea")) {
          if (!isVisible(ta) || isSearchField(ta)) continue;
          field = ta;
          break;
        }
      }
      // Priority 3: any visible text/url input that is NOT the search box.
      if (!field) {
        for (const inp of dialog.querySelectorAll(
          'input[type="text"], input[type="url"]',
        )) {
          if (!isVisible(inp) || isSearchField(inp)) continue;
          field = inp;
          break;
        }
      }

      if (!field) {
        const allFields = Array.from(dialog.querySelectorAll("input, textarea"))
          .map(
            (i) => `${i.tagName}:${i.type || ""}:ph="${i.placeholder || ""}"`,
          )
          .slice(0, 8);
        return {
          success: false,
          error: "No URL field in dialog. Fields: " + allFields.join(", "),
        };
      }

      // Focus and set value
      field.focus();

      // Use native setter for Angular compatibility
      const setter =
        field.tagName === "TEXTAREA"
          ? Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype,
              "value",
            )?.set
          : Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              "value",
            )?.set;

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

  // Step 4: Submit the URLs. NotebookLM's submit control may be a text button
  // ("Insert"/"Add") OR an icon-only round arrow button (→) next to the URL
  // field. We try text labels first, then arrow/send icons, then the enabled
  // button positioned nearest-right of the URL textarea.
  const step4 = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const getCleanText = (el) => {
        let t = "";
        for (const c of el.childNodes) {
          if (c.nodeType === 3) t += c.textContent;
          else if (c.nodeType === 1) {
            const tag = c.tagName?.toLowerCase() || "";
            const cls = (c.className || "").toString().toLowerCase();
            if (
              tag === "mat-icon" ||
              cls.includes("material-icons") ||
              cls.includes("mat-icon")
            )
              continue;
            t += getCleanText(c);
          }
        }
        return t.trim();
      };
      const hasAny = (text, labels) =>
        labels.some((label) => text.includes(label));
      const isVisible = (el) => {
        const s = window.getComputedStyle(el);
        return s.display !== "none" && s.visibility !== "hidden";
      };
      const isDisabled = (el) =>
        el.disabled === true ||
        el.getAttribute("disabled") !== null ||
        el.getAttribute("aria-disabled") === "true";
      const insertLabels = [
        "insert",
        "submit",
        "add source",
        "add sources",
        "插入",
        "提交",
        "添加来源",
        "新增來源",
        "挿入",
        "追加",
        "삽입",
        "추가",
        "insertar",
        "añadir",
        "agregar",
        "insérer",
        "ajouter",
        "einfügen",
        "hinzufügen",
        "inserir",
        "adicionar",
        "inserisci",
        "aggiungi",
        "invoegen",
        "toevoegen",
        "masukkan",
        "tambahkan",
      ];
      // Material icon ligatures used for "submit/continue" arrows.
      const iconNames = [
        "arrow_forward",
        "arrow_upward",
        "arrow_right_alt",
        "send",
        "subdirectory_arrow_left",
        "keyboard_return",
        "north",
        "east",
      ];
      const iconText = (el) => {
        const mi = el.querySelector(
          "mat-icon, .material-icons, .material-icons-extended, .google-symbols, [class*='material-symbols']",
        );
        return (mi?.textContent || "").trim().toLowerCase();
      };

      // Scope to the Add-sources dialog so we don't click the left panel's
      // web-search arrow button.
      // Pick the real, VISIBLE Add-sources dialog. NotebookLM may keep a stray
      // hidden emoji-keyboard dialog ([role=dialog], 0×0) in the DOM, so we must
      // not grab the first match — choose the largest visible one.
      const dialog = (() => {
        const all = [
          ...document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
        ];
        const visible = all.filter((d) => {
          const s = window.getComputedStyle(d);
          if (s.display === "none" || s.visibility === "hidden") return false;
          const r = d.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        });
        visible.sort((a, b) => {
          const ra = a.getBoundingClientRect(),
            rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        return visible[0] || null;
      })();
      if (!dialog)
        return {
          success: false,
          error: "Add-sources dialog not open (submit step)",
        };
      const allClickable = [
        ...dialog.querySelectorAll(
          "button, [role='button'], [tabindex='0'], a",
        ),
      ].filter(isVisible);

      // Pass 1: exact text match (e.g. "Insert").
      for (const el of allClickable) {
        if (isDisabled(el)) continue;
        const clean = getCleanText(el).trim().toLowerCase();
        if (insertLabels.includes(clean)) {
          el.click();
          return { success: true, clicked: clean, method: "text-exact" };
        }
      }
      // Pass 2: text/aria contains an insert label.
      for (const el of allClickable) {
        if (isDisabled(el)) continue;
        const clean = getCleanText(el).trim().toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        if (
          (hasAny(clean, insertLabels) && clean.length < 30) ||
          hasAny(aria, insertLabels)
        ) {
          el.click();
          return {
            success: true,
            clicked: clean || aria,
            method: "text-contains",
          };
        }
      }
      // Pass 3: arrow/send icon, or aria-label referencing such an icon.
      for (const el of allClickable) {
        if (isDisabled(el)) continue;
        const icon = iconText(el);
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        if (
          iconNames.includes(icon) ||
          iconNames.some((n) => aria.includes(n.replace(/_/g, " ")))
        ) {
          el.click();
          return {
            success: true,
            clicked: icon || aria || "(icon)",
            method: "icon",
          };
        }
      }
      // Pass 4: proximity — the enabled icon-only button nearest to the RIGHT
      // of (and vertically aligned with) the URL paste field. Skip the
      // "Search the web" box so we don't click its arrow.
      const searchHints4 = [
        "search",
        "搜索",
        "搜尋",
        "検索",
        "검색",
        "buscar",
        "rechercher",
        "suche",
        "pesquisar",
        "cerca",
        "zoek",
        "cari",
      ];
      const isSearchField4 = (f) => {
        const m = (
          (f.getAttribute("placeholder") || "") +
          " " +
          (f.getAttribute("aria-label") || "")
        ).toLowerCase();
        return searchHints4.some((h) => m.includes(h));
      };
      let field = null;
      for (const ta of dialog.querySelectorAll(
        "textarea, input[type='text'], input[type='url']",
      )) {
        if (isVisible(ta) && !isSearchField4(ta)) {
          field = ta;
          break;
        }
      }
      if (field) {
        const fr = field.getBoundingClientRect();
        let best = null,
          bestDist = Infinity;
        for (const el of allClickable) {
          if (isDisabled(el)) continue;
          const txt = getCleanText(el).trim();
          if (txt.length > 3) continue; // submit affordance here is icon-only
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const verticallyNear =
            r.top < fr.bottom + 40 && r.bottom > fr.top - 40;
          const toRight = r.left >= fr.left; // same row, at/after the field
          if (!verticallyNear || !toRight) continue;
          const dist = Math.hypot(
            r.left - fr.right,
            r.top + r.height / 2 - (fr.top + fr.height / 2),
          );
          if (dist < bestDist) {
            bestDist = dist;
            best = el;
          }
        }
        if (best) {
          best.click();
          return {
            success: true,
            clicked: "(nearest-to-field)",
            method: "proximity",
          };
        }
      }

      // Debug: list visible clickable elements with their icon, if any.
      const visible = allClickable
        .map((e) => {
          const c = getCleanText(e).trim();
          const ic = iconText(e);
          const lbl =
            c ||
            (ic ? `[icon:${ic}]` : "") ||
            e.getAttribute("aria-label") ||
            "";
          return lbl && lbl.length < 50
            ? `${e.tagName}:"${lbl}"${isDisabled(e) ? "(disabled)" : ""}`
            : "";
        })
        .filter((t) => t.length > 0)
        .slice(0, 20);
      return {
        success: false,
        error:
          "No submit/Insert control found. Elements: " + visible.join(", "),
      };
    },
  });
  steps.step4 = step4?.[0]?.result;
  if (!steps.step4?.success) return { ...steps.step4, steps };

  // Verify the submit actually took: on success NotebookLM clears the URL
  // field / closes the dialog. If the URLs are still sitting in the field
  // after the wait, the submit did not register — report failure so the user
  // isn't told it worked when the URLs stayed in the box.
  const submitted = await waitForInTab(
    tabId,
    () => {
      // Pick the real, VISIBLE Add-sources dialog. NotebookLM may keep a stray
      // hidden emoji-keyboard dialog ([role=dialog], 0×0) in the DOM, so we must
      // not grab the first match — choose the largest visible one.
      const dialog = (() => {
        const all = [
          ...document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
        ];
        const visible = all.filter((d) => {
          const s = window.getComputedStyle(d);
          if (s.display === "none" || s.visibility === "hidden") return false;
          const r = d.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        });
        visible.sort((a, b) => {
          const ra = a.getBoundingClientRect(),
            rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        return visible[0] || null;
      })();
      if (!dialog) return true; // dialog closed → submitted
      const fields = [
        ...dialog.querySelectorAll(
          "textarea, input[type='text'], input[type='url']",
        ),
      ].filter((f) => {
        const s = window.getComputedStyle(f);
        return s.display !== "none" && s.visibility !== "hidden";
      });
      if (fields.length === 0) return true; // field gone → submitted
      // Submitted only if every visible field is now empty.
      return fields.every((f) => !f.value || f.value.trim().length === 0);
    },
    { timeoutMs: 8000, intervalMs: 300 },
  );

  if (!submitted) {
    return {
      success: false,
      error:
        "URLs were entered but the submit button did not register (they stayed in the box).",
      steps,
    };
  }

  // Wait for NotebookLM to process
  await sleep(3000);

  // Close any remaining dialog by pressing Escape
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
        }),
      );
    },
  });

  await sleep(500);

  return { ...steps.step4, steps };
}

/**
 * Uploads a batch of files into NotebookLM by constructing real File objects
 * from base64 data inside the page and dispatching a drop event on the drop zone.
 *
 * This approach works on both Chrome and Edge and avoids all CDP file path issues:
 * - DOM.setFileInputFiles requires native OS paths which fail silently on Windows
 * - Page.fileChooserOpened never fires because "Upload files" is a nav button, not a picker
 * - Drop events with a real DataTransfer populated from base64 bytes work reliably
 *
 * All files in `filesData` are dropped in a single open/drop/close cycle (one
 * DataTransfer with every file). This function only performs the drop and
 * returns whether the file input was set; the CALLER waits for NotebookLM to
 * finish ingesting the batch (and never re-drops it).
 */
async function injectFilesBatchViaCDP(tabId, filesData) {
  if (!filesData?.length) {
    return { success: false, error: "No files provided" };
  }

  // Step 0: If a prior dialog is still open (stale from a previous iteration),
  // close it first so we start from a clean state. Without this, Step 1's
  // "already-open" branch may use a stale dialog whose buttons have since
  // been torn down, causing the upload-button query to miss.
  const stalePresent = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Pick the real, VISIBLE Add-sources dialog. NotebookLM may keep a stray
      // hidden emoji-keyboard dialog ([role=dialog], 0×0) in the DOM, so we must
      // not grab the first match — choose the largest visible one.
      const dialog = (() => {
        const all = [
          ...document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
        ];
        const visible = all.filter((d) => {
          const s = window.getComputedStyle(d);
          if (s.display === "none" || s.visibility === "hidden") return false;
          const r = d.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        });
        visible.sort((a, b) => {
          const ra = a.getBoundingClientRect(),
            rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        return visible[0] || null;
      })();
      return !!dialog;
    },
  });
  if (stalePresent?.[0]?.result) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
          }),
        ),
    });
    await waitForInTab(
      tabId,
      () => {
        // Consider only visible dialogs — a stray 0×0 emoji-keyboard dialog
        // may linger in the DOM and would otherwise never "close".
        const dlgs = [
          ...document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
        ];
        return !dlgs.some((d) => {
          const s = window.getComputedStyle(d);
          if (s.display === "none" || s.visibility === "hidden") return false;
          const r = d.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        });
      },
      { timeoutMs: 3000, intervalMs: 150 },
    );
  }

  // Step 1: Ensure "Add sources" dialog is open. Poll up to 8s.
  const dialogOpened = await waitForInTab(
    tabId,
    () => {
      const getCleanText = (el) => {
        let t = "";
        for (const c of el.childNodes) {
          if (c.nodeType === 3) t += c.textContent;
          else if (c.nodeType === 1) {
            const tag = c.tagName?.toLowerCase() || "";
            const cls = (c.className || "").toString().toLowerCase();
            if (
              tag === "mat-icon" ||
              cls.includes("material-icons") ||
              cls.includes("mat-icon")
            )
              continue;
            t += getCleanText(c);
          }
        }
        return t.trim();
      };
      const hasAny = (text, labels) =>
        labels.some((label) => text.includes(label));
      const addSourceLabels = [
        "add source",
        "add sources",
        "add a source",
        "添加来源",
        "添加源",
        "新增来源",
        "加入来源",
        "添加來源",
        "新增來源",
        "加入來源",
        "ソースを追加",
        "情報源を追加",
        "소스 추가",
        "출처 추가",
        "añadir fuente",
        "añadir fuentes",
        "agregar fuente",
        "agregar fuentes",
        "ajouter une source",
        "ajouter des sources",
        "quelle hinzufügen",
        "quellen hinzufügen",
        "adicionar fonte",
        "adicionar fontes",
        "aggiungi fonte",
        "aggiungi fonti",
        "bron toevoegen",
        "bronnen toevoegen",
        "tambahkan sumber",
      ];
      const body = document.body.textContent || "";
      if (
        /drop your files|upload files|drag.*files|拖放文件|拖拽文件|上传文件|上傳檔案|上傳文件|ファイルをアップロード|파일 업로드|subir archivos|téléverser|dateien hochladen|carregar arquivos|carica file|bestanden uploaden|unggah file/i.test(
          body,
        )
      ) {
        return { success: true, method: "already-open" };
      }
      const candidates = document.querySelectorAll(
        'button, [role="button"], a, [tabindex="0"]',
      );
      for (const el of candidates) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const clean = getCleanText(el).toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        if (hasAny(clean, addSourceLabels) || hasAny(aria, addSourceLabels)) {
          el.click();
          return { success: true, method: "clicked" };
        }
      }
      return null;
    },
    { timeoutMs: 8000, intervalMs: 300 },
  );

  if (!dialogOpened?.success) {
    return { success: false, error: "Could not open Add sources dialog" };
  }

  if (dialogOpened.method !== "already-open") {
    const ready = await waitForInTab(
      tabId,
      () =>
        /drop your files|upload files|drag.*files|拖放文件|拖拽文件|上传文件|上傳檔案|上傳文件|ファイルをアップロード|파일 업로드|subir archivos|téléverser|dateien hochladen|carregar arquivos|carica file|bestanden uploaden|unggah file/i.test(
          document.body.textContent || "",
        ),
      { timeoutMs: 5000, intervalMs: 100 },
    );
    if (!ready)
      return { success: false, error: "Upload dialog did not appear" };
  }

  // Step 2: Find the "Upload files" button coordinates and use a trusted CDP
  // mouse click to open the file sub-panel. A scripted .click() doesn't create
  // a user activation, but CDP Input.dispatchMouseEvent does — this allows the
  // file chooser to open, which we then intercept.
  //
  // The lookup runs in-page and returns coords only once the button is VISIBLE
  // with a non-zero rect. We poll it (via waitForInTab) so a dialog that hasn't
  // finished rendering doesn't cause a "button not found" miss, and we re-run it
  // before every click attempt below in case the dialog reflowed.
  const findUploadBtn = () => {
    const getCleanText = (el) => {
      let t = "";
      for (const c of el.childNodes) {
        if (c.nodeType === 3) t += c.textContent;
        else if (c.nodeType === 1) {
          const tag = c.tagName?.toLowerCase() || "";
          const cls = (c.className || "").toString().toLowerCase();
          if (
            tag === "mat-icon" ||
            cls.includes("material-icons") ||
            cls.includes("mat-icon")
          )
            continue;
          t += getCleanText(c);
        }
      }
      return t.trim();
    };
    const hasAny = (text, labels) =>
      labels.some((label) => text.includes(label));
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const coordsOf = (el, clean) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        text: clean,
      };
    };
    const uploadLabels = [
      "upload files",
      "upload file",
      "upload",
      "上传文件",
      "上传",
      "上傳檔案",
      "上傳文件",
      "上傳",
      "ファイルをアップロード",
      "アップロード",
      "파일 업로드",
      "업로드",
      "subir archivos",
      "subir archivo",
      "subir",
      "téléverser des fichiers",
      "téléverser",
      "importer des fichiers",
      "dateien hochladen",
      "datei hochladen",
      "hochladen",
      "carregar arquivos",
      "carregar ficheiros",
      "carregar",
      "carica file",
      "carica",
      "bestanden uploaden",
      "uploaden",
      "unggah file",
      "unggah",
    ];
    const all = document.querySelectorAll(
      'button, [role="button"], [tabindex="0"], a, label, div, span',
    );
    for (const el of all) {
      if (!isVisible(el)) continue;
      const clean = getCleanText(el).toLowerCase();
      if (uploadLabels.includes(clean)) return coordsOf(el, clean);
    }
    // Loose fallback
    for (const el of all) {
      if (!isVisible(el)) continue;
      const clean = getCleanText(el).toLowerCase();
      if (hasAny(clean, uploadLabels) && clean.length < 40)
        return coordsOf(el, clean);
    }
    return null;
  };

  const btnCoords = await waitForInTab(tabId, findUploadBtn, {
    timeoutMs: 5000,
    intervalMs: 150,
  });
  if (!btnCoords) {
    return { success: false, error: "Upload files button not found in dialog" };
  }

  // Enable file chooser interception before the trusted click
  let interceptionEnabled = false;
  let listenerAttached = false;
  let onEvent = null;

  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.enable", {});
    await chrome.debugger.sendCommand(
      { tabId },
      "Page.setInterceptFileChooserDialog",
      { enabled: true },
    );
    interceptionEnabled = true;

    // A single listener routes every Page.fileChooserOpened to whichever click
    // attempt is currently waiting. Re-armed per attempt via `chooserResolve`.
    let chooserResolve = null;
    onEvent = (source, method, params) => {
      if (
        source.tabId === tabId &&
        method === "Page.fileChooserOpened" &&
        chooserResolve
      ) {
        const r = chooserResolve;
        chooserResolve = null;
        r(params);
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);
    listenerAttached = true;

    // Step 3-4: Fire a trusted CDP click and wait for the file chooser. The
    // click can transiently miss (button not yet hit-testable), so retry with a
    // short per-attempt timeout, re-reading fresh coords each time in case the
    // dialog reflowed. A user activation only comes from CDP Input events, not a
    // scripted .click(), so this trusted dispatch is required to open the chooser.
    let chooserEvent = null;
    let lastBtnText = btnCoords.text;
    for (let attempt = 1; attempt <= UPLOAD_CLICK_ATTEMPTS; attempt++) {
      // Re-read coords on retries; the first attempt reuses the coords we already
      // polled for above.
      const coords =
        attempt === 1
          ? btnCoords
          : await waitForInTab(tabId, findUploadBtn, {
              timeoutMs: 2000,
              intervalMs: 150,
            });
      if (!coords) continue;
      lastBtnText = coords.text;

      let resolveChooser;
      const chooserPromise = new Promise((r) => {
        resolveChooser = r;
      });
      const chooserTimeout = setTimeout(
        () => resolveChooser(null),
        CHOOSER_ATTEMPT_TIMEOUT_MS,
      );
      chooserResolve = resolveChooser;

      const x = Math.round(coords.x);
      const y = Math.round(coords.y);
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });

      chooserEvent = await chooserPromise;
      clearTimeout(chooserTimeout);
      chooserResolve = null;
      if (chooserEvent) break;
      console.log(
        `[n2z] upload-click attempt ${attempt}/${UPLOAD_CLICK_ATTEMPTS} missed; retrying`,
      );
    }

    if (!chooserEvent) {
      return {
        success: false,
        error: `Trusted click on "${lastBtnText}" did not open file chooser`,
      };
    }

    // Step 5: Set ALL files in this batch via a single DataTransfer. NotebookLM's
    // file input accepts multiple files at once, so one open/drop/close cycle
    // ingests the whole batch. Bytes are built from base64 in-page (avoids the
    // Windows native-path issues of DOM.setFileInputFiles).
    const filesPayload = JSON.stringify(
      filesData.map((f) => ({
        base64: f.base64,
        filename: f.filename,
        type: f.contentType || "application/pdf",
      })),
    );
    const setResult = await chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      {
        expression: `
        (async () => {
          try {
            const files = ${filesPayload};
            const dt = new DataTransfer();
            for (const f of files) {
              const bin = atob(f.base64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              dt.items.add(new File([bytes], f.filename, { type: f.type }));
            }
            // Find the file input that was just opened
            const inp = document.querySelector('input[type="file"]');
            if (!inp) return { ok: false, reason: 'no-input' };
            Object.defineProperty(inp, 'files', { value: dt.files, configurable: true });
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            return { ok: true, files: dt.files.length };
          } catch(e) { return { ok: false, reason: e.message }; }
        })()
      `,
        returnByValue: true,
        awaitPromise: true,
      },
    );

    const setInfo = setResult?.result?.value;
    if (!setInfo?.ok) {
      return {
        success: false,
        error: `Could not set files on input: ${setInfo?.reason}`,
      };
    }

    // Step 6: Close the dialog, then wait for it to actually disappear.
    // A short settle lets the input's change handler start the upload before
    // we Escape, so a fast close can't cancel an in-flight upload. The caller
    // then waits for the batch to finish ingesting.
    await sleep(300);
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
          }),
        ),
    });
    await waitForInTab(
      tabId,
      () => {
        // Prefer the dialog element — body text can match "upload files" in
        // toasts or the sources list after upload completes.
        // Pick the real, VISIBLE Add-sources dialog. NotebookLM may keep a stray
        // hidden emoji-keyboard dialog ([role=dialog], 0×0) in the DOM, so we must
        // not grab the first match — choose the largest visible one.
        const dialog = (() => {
          const all = [
            ...document.querySelectorAll(
              'mat-dialog-container, [role="dialog"]',
            ),
          ];
          const visible = all.filter((d) => {
            const s = window.getComputedStyle(d);
            if (s.display === "none" || s.visibility === "hidden") return false;
            const r = d.getBoundingClientRect();
            return r.width > 50 && r.height > 50;
          });
          visible.sort((a, b) => {
            const ra = a.getBoundingClientRect(),
              rb = b.getBoundingClientRect();
            return rb.width * rb.height - ra.width * ra.height;
          });
          return visible[0] || null;
        })();
        if (dialog) return false;
        return !/drop your files|upload files|drag.*files|拖放文件|拖拽文件|上传文件|上傳檔案|上傳文件|ファイルをアップロード|파일 업로드|subir archivos|téléverser|dateien hochladen|carregar arquivos|carica file|bestanden uploaden|unggah file/i.test(
          document.body.textContent || "",
        );
      },
      { timeoutMs: 10000, intervalMs: 200 },
    );

    return { success: true, count: filesData.length };
  } catch (e) {
    return { success: false, error: `File inject: ${e.message}` };
  } finally {
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
          { enabled: false },
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
// Ensures the "Studio" tab/panel (which holds the saved notes) is visible.
// On narrow/vertical monitors the 3-column layout collapses and Studio becomes
// a tab that must be clicked first. Idempotent — if the note cards are already
// present it does nothing. Injected into the page; must be self-contained.
function ensureStudioVisibleFn() {
  const isIconElement = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName?.toLowerCase() || "";
    const cls = (el.className || "").toString().toLowerCase();
    return (
      tag === "mat-icon" ||
      cls.includes("material-icons") ||
      cls.includes("mat-icon")
    );
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
  // Already showing note cards / the Studio panel? Nothing to do.
  if (document.querySelector(".artifact-title, [class*='artifact-title']"))
    return true;

  // Look for a tab/button labeled "Studio" / localized equivalent and open it.
  const clickables = document.querySelectorAll(
    '[role="tab"], button, [role="button"], a, [class*="tab"]',
  );
  const studioLabels = [
    "studio",
    "工作室",
    "工作區",
    "スタジオ",
    "스튜디오",
    "estudio",
    "atelier",
    "labor",
    "estúdio",
  ];
  for (const el of clickables) {
    const text = getCleanText(el).trim().toLowerCase();
    if (studioLabels.includes(text)) {
      el.click();
      return true;
    }
  }
  return false;
}

async function extractNotesFromTab(tabId) {
  // Step 0: Ensure the Studio panel (which holds the note cards) is visible
  // before scanning. In the collapsed/tab layout Studio is a tab that must be
  // clicked, and Angular may take a moment to render the note cards — so we
  // click Studio and poll until `.artifact-title` cards appear (up to ~4s).
  for (let attempt = 0; attempt < 8; attempt++) {
    const ready = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        !!document.querySelector(".artifact-title, [class*='artifact-title']"),
    });
    if (ready?.[0]?.result) break;
    await chrome.scripting.executeScript({
      target: { tabId },
      func: ensureStudioVisibleFn,
    });
    await sleep(500);
  }

  // Step 1: Scan for note card titles (just collect metadata, no tagging)
  const scanResult = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const isIconElement = (el) => {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        const cls = (el.className || "").toString().toLowerCase();
        const tag = el.tagName?.toLowerCase() || "";
        return (
          tag === "mat-icon" ||
          cls.includes("material-icons") ||
          cls.includes("mat-icon")
        );
      };
      const getCleanText = (node) => {
        let result = "";
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
          else if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.tagName === "STYLE" || child.tagName === "SCRIPT")
              continue;
            if (isIconElement(child)) continue;
            result += getCleanText(child);
          }
        }
        return result;
      };

      const normalize = (t) => t.replace(/\s+/g, " ").trim().toLowerCase();
      const relativeTimeRe =
        /(\d+\s*[mhd]\s*ago|\d+\s*(min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*ago|\d+\s*(分钟|小時|小时|天|日|周|週|星期|个月|個月|月|年)前|\d+\s*(分|時間|日|週間|か月|ヶ月|年)前|\d+\s*(분|시간|일|주|개월|년)\s*전|hace\s+\d+\s*(min|hora|horas|día|dias|días|semana|mes|año|años)|il y a\s+\d+\s*(min|heure|heures|jour|jours|semaine|mois|an|ans)|vor\s+\d+\s*(min|minute|stunden?|tage?|wochen?|monate?|jahre?)|昨天|前天|昨日|一昨日|어제)/i;

      // Generator tiles (Slide Deck, Mind Map, Quiz, Reports, Audio/Video
      // Overview, Flashcards, Infographic, Data Table) describe themselves with a
      // "Generate …" tooltip. Saved text notes never do. We use this as a guard so
      // a tile can never be picked even if it ever borrows the note CSS class.
      const generatorRe =
        /^(generate |创建|新增|生成|작성|générer |erstellen |criar |crear |genera )/i;

      // Resolve the full, untruncated title for an artifact title element. The
      // visible <span> text is ellipsized; the complete title lives in the cdk
      // tooltip referenced by aria-describedby. Fall back to visible text.
      const fullTitleFor = (titleEl) => {
        const adId = (titleEl.getAttribute("aria-describedby") || "")
          .split(/\s+/)
          .filter(Boolean)[0];
        if (adId) {
          const tip = document.getElementById(adId);
          const tipText = (tip?.textContent || "").trim();
          if (tipText) return tipText;
        }
        return getCleanText(titleEl).trim();
      };

      // PRIMARY STRATEGY — structural anchor.
      // Saved text notes render their title as `span.artifact-title`, which is a
      // tooltip trigger inside a `.artifact-item-button` card. This class is used
      // ONLY by saved notes (not by the Studio generator tiles) and exists in both
      // the collapsed/tab layout and the expanded three-column layout, so it is a
      // reliable, language-independent anchor.
      const foundNotes = [];
      const seenTitles = [];
      const titleEls = document.querySelectorAll(
        ".artifact-title, [class*='artifact-title']",
      );
      for (const titleEl of titleEls) {
        const title = fullTitleFor(titleEl).replace(/\s+/g, " ").trim();
        if (!title || title.length < 3) continue;
        if (generatorRe.test(title)) continue; // never a generator tile

        const normTitle = normalize(title);
        if (seenTitles.some((s) => s === normTitle)) continue;
        seenTitles.push(normTitle);

        // Pull the timestamp from the surrounding card, if present (best-effort).
        const card =
          titleEl.closest(".artifact-item-button") || titleEl.parentElement;
        const cardText = card ? getCleanText(card).trim() : "";
        const tsMatch = cardText.match(relativeTimeRe);

        foundNotes.push({
          title: title.substring(0, 200),
          type: "saved-note",
          timestamp: tsMatch ? tsMatch[0] : "",
        });
      }

      if (foundNotes.length > 0) return foundNotes;

      // FALLBACK STRATEGY — legacy timestamp heuristic.
      // Kept for older NotebookLM layouts that predate the artifact-* markup.
      const allElements = document.querySelectorAll(
        "*:not(style):not(script):not(link):not(meta):not(head)",
      );
      const seenCards = new Set();

      for (const el of allElements) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;

        const rawText = el.textContent?.trim() || "";
        if (
          rawText.length > 2000 ||
          rawText.length < 8 ||
          el.children.length > 20
        )
          continue;
        if (!relativeTimeRe.test(rawText)) continue;

        let card = el;
        for (let i = 0; i < 3; i++) {
          if (!card.parentElement) break;
          if (card.parentElement.children.length > 5) break;
          if (
            card.parentElement.tagName === "MAIN" ||
            card.parentElement.tagName === "BODY"
          )
            break;
          card = card.parentElement;
        }

        if (seenCards.has(card)) continue;
        seenCards.add(card);

        const cleanText = getCleanText(card).trim();
        if (cleanText.length < 8 || /\{[^}]*:[^}]*\}/.test(cleanText)) continue;

        const lines = cleanText
          .split(/\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        let title = "";
        let noteType = "saved-note";
        const typePattern =
          /^(Explainer|Deep Dive|Study Guide|Briefing|FAQ|Timeline|Outline|Report|Audio Overview|New Note|说明|深度解析|学习指南|简报|常见问题|时间轴|大纲|报告|音频概览|新笔记)$/i;

        for (const line of lines) {
          if (line.length <= 2) continue;
          if (relativeTimeRe.test(line)) continue;
          if (/^(\d+\s*sources?|\d+\s*个?来源|\d+\s*個?來源)$/i.test(line))
            continue;
          if (/^[·•\-–—\s]+$/.test(line)) continue;
          if (typePattern.test(line)) {
            noteType = line;
            continue;
          }
          if (!title) title = line;
        }

        if (!title || title.length < 3) continue;

        // Clean trailing junk from title: timestamps, "Add note", other note names
        title = title
          .replace(
            /\s*(\d+\s*[mhd]\s*ago|\d+\s*(min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*ago|\d+\s*(分钟|小時|小时|天|日|周|週|星期|个月|個月|月|年)前|\d+\s*(分|時間|日|週間|か月|ヶ月|年)前|\d+\s*(분|시간|일|주|개월|년)\s*전|hace\s+\d+\s*(min|hora|horas|día|dias|días|semana|mes|año|años)|il y a\s+\d+\s*(min|heure|heures|jour|jours|semaine|mois|an|ans)|vor\s+\d+\s*(min|minute|stunden?|tage?|wochen?|monate?|jahre?)|昨天|前天|昨日|一昨日|어제).*/i,
            "",
          ) // timestamp and everything after
          .replace(/\s*(Add\s+note|添加笔记).*/i, "") // "Add note" and everything after
          .replace(/\s*(\d+\s*sources?|\d+\s*个?来源|\d+\s*個?來源).*/i, "") // source count and everything after
          .trim();

        if (!title || title.length < 3) continue;
        const lower = title.toLowerCase();
        if (
          /^(sources?|chat|studio|notes?|settings?|share|help|add\s|create\s|来源|聊天|工作室|笔记|设置|分享|帮助|添加|创建)$/i.test(
            lower,
          )
        )
          continue;

        // Early dedup: skip if we already found a note with this title
        const normTitle = normalize(title);
        if (
          seenTitles.some(
            (s) =>
              s === normTitle ||
              normTitle.startsWith(s) ||
              s.startsWith(normTitle),
          )
        )
          continue;
        seenTitles.push(normTitle);

        if (noteType === "saved-note") {
          const m = cleanText.match(
            /(Explainer|Deep Dive|Study Guide|Briefing|FAQ|Timeline|Outline|Report|Audio Overview|说明|深度解析|学习指南|简报|常见问题|时间轴|大纲|报告|音频概览)/i,
          );
          if (m) noteType = m[1];
        }

        const lt = noteType.toLowerCase();
        if (
          lt.includes("audio") ||
          lt.includes("deep dive") ||
          lt.includes("音频") ||
          lt.includes("深度解析")
        )
          continue;

        const tsMatch = cleanText.match(relativeTimeRe);

        foundNotes.push({
          title: title.substring(0, 200),
          type: noteType.toLowerCase().replace(/\s+/g, "-"),
          timestamp: tsMatch ? tsMatch[0] : "",
        });
      }

      // Final dedup safety net (early dedup above should catch most)
      const seen = [];
      return foundNotes.filter((n) => {
        const norm = normalize(n.title);
        const isDup = seen.some(
          (s) => s === norm || norm.startsWith(s) || s.startsWith(norm),
        );
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
    // In the collapsed/tab layout, back-navigation may land on Chat/Sources, so
    // re-show the Studio panel and wait for the note cards before re-finding.
    for (let attempt = 0; attempt < 8; attempt++) {
      const ready = await chrome.scripting.executeScript({
        target: { tabId },
        func: () =>
          !!document.querySelector(
            ".artifact-title, [class*='artifact-title']",
          ),
      });
      if (ready?.[0]?.result) break;
      await chrome.scripting.executeScript({
        target: { tabId },
        func: ensureStudioVisibleFn,
      });
      await sleep(500);
    }

    // Re-find and click the card by matching its title in the current DOM
    const clickResult = await chrome.scripting.executeScript({
      target: { tabId },
      args: [card.title],
      func: (targetTitle) => {
        const isIconElement = (el) => {
          if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
          const tag = el.tagName?.toLowerCase() || "";
          const cls = (el.className || "").toString().toLowerCase();
          return (
            tag === "mat-icon" ||
            cls.includes("material-icons") ||
            cls.includes("mat-icon")
          );
        };
        const getCleanText = (node) => {
          let result = "";
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
            else if (child.nodeType === Node.ELEMENT_NODE) {
              if (child.tagName === "STYLE" || child.tagName === "SCRIPT")
                continue;
              if (isIconElement(child)) continue;
              result += getCleanText(child);
            }
          }
          return result;
        };

        // Resolve the full title for an artifact title element (tooltip first).
        const fullTitleFor = (titleEl) => {
          const adId = (titleEl.getAttribute("aria-describedby") || "")
            .split(/\s+/)
            .filter(Boolean)[0];
          if (adId) {
            const tip = document.getElementById(adId);
            const tipText = (tip?.textContent || "").trim();
            if (tipText) return tipText;
          }
          return getCleanText(titleEl).trim();
        };
        const generatorRe =
          /^(generate |创建|新增|生成|작성|générer |erstellen |criar |crear |genera )/i;
        const norm = (t) => (t || "").replace(/\s+/g, " ").trim().toLowerCase();
        const wantNorm = norm(targetTitle);

        let card = null;
        let artifactBtn = null;

        // PRIMARY: match a saved-note card via its `.artifact-title` anchor.
        // This guarantees we never click a Studio generator tile (Slide Deck,
        // Mind Map, etc.) — those do not use `.artifact-title` and, defensively,
        // carry a "Generate …" tooltip we exclude. Works collapsed or expanded.
        const titleEls = document.querySelectorAll(
          ".artifact-title, [class*='artifact-title']",
        );
        for (const titleEl of titleEls) {
          const full = fullTitleFor(titleEl);
          if (!full || generatorRe.test(full)) continue;
          const n = norm(full);
          if (
            n === wantNorm ||
            n.startsWith(wantNorm) ||
            wantNorm.startsWith(n)
          ) {
            card =
              titleEl.closest("artifact-library-note") ||
              titleEl.closest(".artifact-item-button") ||
              titleEl.parentElement;
            // The element that actually opens the note is the full-width
            // `.artifact-stretched-button` (a real <button>). Its sibling
            // `.artifact-actions` button is the 3-dot overflow menu — avoid it.
            artifactBtn =
              (card && card.querySelector(".artifact-stretched-button")) ||
              titleEl
                .closest(".artifact-button-content")
                ?.querySelector(".artifact-stretched-button") ||
              null;
            break;
          }
        }

        // If we found the dedicated open-button, click it natively and return.
        if (artifactBtn) {
          const rect = artifactBtn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            artifactBtn.focus?.();
            artifactBtn.click();
            return { success: true, method: "artifact-stretched-button" };
          }
        }

        // FALLBACK: legacy text + timestamp heuristic for older layouts.
        if (!card) {
          const allElements = document.querySelectorAll(
            "*:not(style):not(script):not(link):not(meta):not(head)",
          );
          let bestCard = null;
          let bestSize = Infinity;
          const relativeTimeRe =
            /(\d+\s*[mhd]\s*ago|\d+\s*(min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*ago|\d+\s*(分钟|小時|小时|天|日|周|週|星期|个月|個月|月|年)前|\d+\s*(分|時間|日|週間|か月|ヶ月|年)前|\d+\s*(분|시간|일|주|개월|년)\s*전|hace\s+\d+\s*(min|hora|horas|día|dias|días|semana|mes|año|años)|il y a\s+\d+\s*(min|heure|heures|jour|jours|semaine|mois|an|ans)|vor\s+\d+\s*(min|minute|stunden?|tage?|wochen?|monate?|jahre?)|昨天|前天|昨日|一昨日|어제)/i;

          for (const el of allElements) {
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden")
              continue;
            const rawText = el.textContent?.trim() || "";
            if (rawText.length > 2000 || rawText.length < 8) continue;
            // Must contain the title and a timestamp pattern (card indicator)
            if (
              !rawText.includes(targetTitle.substring(0, 30)) ||
              !relativeTimeRe.test(rawText)
            )
              continue;

            // Prefer the smallest element that contains the full title
            // (most specific = the actual card, not a parent container)
            if (rawText.length < bestSize) {
              bestSize = rawText.length;
              bestCard = el;
            }
          }

          if (!bestCard)
            return { success: false, error: "card-not-found-by-title" };

          // Walk up a bit to get the actual card container
          card = bestCard;
          for (let i = 0; i < 3; i++) {
            if (!card.parentElement) break;
            if (card.parentElement.children.length > 5) break;
            if (
              card.parentElement.tagName === "MAIN" ||
              card.parentElement.tagName === "BODY"
            )
              break;
            card = card.parentElement;
          }
        }

        // Click strategy 0: if we matched an artifact card, click it directly.
        // Clicking the card itself (rather than searching its descendants) avoids
        // accidentally hitting the note's overflow (3-dot) menu button.
        if (card.classList && card.classList.contains("artifact-item-button")) {
          const rect = card.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const opts = {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              button: 0,
            };
            card.dispatchEvent(new PointerEvent("pointerdown", opts));
            card.dispatchEvent(new MouseEvent("mousedown", opts));
            card.dispatchEvent(new PointerEvent("pointerup", opts));
            card.dispatchEvent(new MouseEvent("mouseup", opts));
            card.dispatchEvent(new MouseEvent("click", opts));
            card.click?.();
            return { success: true, method: "artifact-card-click" };
          }
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
        const interactives = card.querySelectorAll(
          'button, [role="button"], [role="link"], [tabindex="0"]',
        );
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
        const opts = {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 0,
        };
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
        _method:
          "click-failed:" + (clickResult?.[0]?.result?.error || "unknown"),
      });
      continue;
    }

    // Wait for the detail view — poll frequently (up to ~4s) for signals.
    // The note editor (.ProseMirror) appearing is the fastest, most direct
    // signal; banner/convert/breadcrumb/url-change are backups.
    let detailOpened = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(400);
      const check = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const bodyText = document.body.textContent || "";
          // The open note renders as a `labs-tailwind-doc-viewer` in the Studio
          // panel (not inside chat-panel). Its presence on-screen is the most
          // direct "note opened" signal.
          const vh =
            window.innerHeight || document.documentElement.clientHeight;
          const editorEls = [
            ...document.querySelectorAll(
              "labs-tailwind-doc-viewer, note-editor .ProseMirror, .ProseMirror, rich-text-editor.note-editor",
            ),
          ];
          const editorVisible = editorEls.some((el) => {
            if (el.closest("chat-panel")) return false;
            const r = el.getBoundingClientRect();
            return r.height > 30 && r.bottom > 0 && r.top < vh;
          });
          return {
            hasEditor: !!editorVisible,
            hasBanner:
              /saved\s+(responses?|notes?)\s+are\s+(view|read)|已保存.*(只读|查看)|已儲存.*(唯讀|查看)|読み取り専用|읽기 전용|solo lectura|lecture seule|schreibgeschützt|somente leitura|sola lettura|alleen-lezen/i.test(
                bodyText,
              ),
            hasBreadcrumb:
              /(Studio|工作室|工作區|スタジオ|스튜디오|Estudio|Atelier|Labor|Estúdio)\s*[>›»]\s/i.test(
                bodyText,
              ),
            hasConvertBtn:
              /convert to source|转换为来源|轉換為來源|ソースに変換|소스로 변환|convertir en fuente|convertir en source|in quelle umwandeln|converter em fonte|converti in fonte/i.test(
                bodyText,
              ),
            url: window.location.href,
          };
        },
      });
      const st = check?.[0]?.result || {};
      if (
        st.hasEditor ||
        st.hasBanner ||
        st.hasBreadcrumb ||
        st.hasConvertBtn ||
        st.url !== baseUrl
      ) {
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
          return (
            tag === "mat-icon" ||
            cls.includes("material-icons") ||
            cls.includes("mat-icon")
          );
        };
        const getCleanText = (node) => {
          let result = "";
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
            else if (child.nodeType === Node.ELEMENT_NODE) {
              if (child.tagName === "STYLE" || child.tagName === "SCRIPT")
                continue;
              if (isIconElement(child)) continue;
              result += getCleanText(child);
            }
          }
          return result;
        };
        // Replace NotebookLM inline citation chips with readable "(N)" markers.
        // Each citation is `<button class="xap-inline-dialog"><span>N</span></button>`
        // (the span's aria-label holds the full source). When several citations
        // are adjacent they are merged into one "(20,21)". Operates on a clone so
        // the live page is untouched. Plain-text years are never inside these
        // buttons, so they are left alone — this is robust where regex is not.
        const normalizeCitations = (clone) => {
          const buttons = Array.from(
            clone.querySelectorAll(
              "button.xap-inline-dialog, button[class*='xap-inline-dialog']",
            ),
          );
          const visited = new Set();
          for (const btn of buttons) {
            if (visited.has(btn)) continue;
            // Gather this citation plus any immediately-adjacent citation buttons
            // (ignoring whitespace-only text nodes between them).
            const group = [btn];
            visited.add(btn);
            let sib = btn.nextSibling;
            while (sib) {
              if (sib.nodeType === Node.TEXT_NODE && !sib.textContent.trim()) {
                sib = sib.nextSibling;
                continue;
              }
              if (
                sib.nodeType === Node.ELEMENT_NODE &&
                sib.matches?.(
                  "button.xap-inline-dialog, button[class*='xap-inline-dialog']",
                )
              ) {
                group.push(sib);
                visited.add(sib);
                sib = sib.nextSibling;
                continue;
              }
              break;
            }
            const nums = group
              .map((b) => (b.textContent || "").trim())
              .filter((t) => /^\d{1,4}$/.test(t));
            // Add a leading space so citations don't fuse onto the preceding word
            // ("signaling" -> "signaling (20,21)"), but skip it if the text before
            // already ends in whitespace to avoid a double space.
            const prev = btn.previousSibling;
            const prevEndsWS =
              prev &&
              prev.nodeType === Node.TEXT_NODE &&
              /\s$/.test(prev.textContent || "");
            const lead = prevEndsWS ? "" : " ";
            const replacement = document.createTextNode(
              nums.length ? `${lead}(${nums.join(",")})` : "",
            );
            btn.parentNode.insertBefore(replacement, btn);
            for (const b of group) b.remove();
          }
        };
        const getCleanHtml = (node) => {
          const clone = node.cloneNode(true);
          clone
            .querySelectorAll("style, script, mat-icon, .material-icons")
            .forEach((s) => s.remove());
          normalizeCitations(clone);
          return clone.innerHTML;
        };
        // Text variant that also normalizes citations (clones first).
        const getCleanTextWithCitations = (node) => {
          const clone = node.cloneNode(true);
          clone
            .querySelectorAll("style, script, mat-icon, .material-icons")
            .forEach((s) => s.remove());
          normalizeCitations(clone);
          return getCleanText(clone);
        };
        const isChrome = (text) => {
          if (
            /convert to source|转换为来源|轉換為來源|ソースに変換|소스로 변환|convertir en fuente|convertir en source|in quelle umwandeln|converter em fonte|converti in fonte/i.test(
              text,
            ) &&
            text.length < 80
          )
            return true;
          if (
            /saved\s+(responses?|notes?)\s+are|已保存.*(只读|查看)|已儲存.*(唯讀|查看)|読み取り専用|읽기 전용|solo lectura|lecture seule|schreibgeschützt|somente leitura|sola lettura|alleen-lezen/i.test(
              text,
            ) &&
            text.length < 80
          )
            return true;
          if (
            /^(Studio|工作室|工作區|スタジオ|스튜디오|Estudio|Atelier|Labor|Estúdio)\s*[>›»]/i.test(
              text,
            ) &&
            text.length < 40
          )
            return true;
          if (/^(\d+\s*sources?|\d+\s*个?来源|\d+\s*個?來源)$/i.test(text))
            return true;
          return false;
        };

        const debug = {
          detailOpened,
          url: window.location.href,
          bodyLen: (document.body.textContent || "").length,
        };

        // === STRATEGY 0: Note body container ===
        // The opened note's body renders inside the Studio panel as a
        // `labs-tailwind-doc-viewer` (the note document viewer), within
        // `<studio-panel>` / `note-editor`. This is the SAME element in both the
        // expanded (3-column) and collapsed (tab) layouts.
        //
        // CRITICAL: the Chat conversation reuses similar message markup and the
        // chat history is also in the DOM. If we scraped document-wide (or just
        // "largest .message-content") we'd grab chat and return identical content
        // for every note. So we anchor on the Studio note viewer and explicitly
        // exclude anything inside `chat-panel`. Among matches, prefer the one
        // that is on-screen (the open note) and has the most text.
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const isOnScreen = (r) =>
          r.width > 100 &&
          r.height > 30 &&
          r.bottom > 0 &&
          r.top < vh &&
          r.right > 0 &&
          r.left < vw;
        const bodySelectors = [
          // Studio note viewer (read-only saved responses AND notes).
          "studio-panel labs-tailwind-doc-viewer.note-editor",
          "studio-panel labs-tailwind-doc-viewer",
          "labs-tailwind-doc-viewer.note-editor",
          "labs-tailwind-doc-viewer",
          // Editable rich-text notes.
          "note-editor .ProseMirror",
          ".ProseMirror",
          ".prosemirror-editor",
          "rich-text-editor.note-editor .ProseMirror",
        ];
        const pickBody = (requireOnScreen) => {
          for (const sel of bodySelectors) {
            let best = null;
            document.querySelectorAll(sel).forEach((el) => {
              if (el.closest("chat-panel")) return; // never the Chat conversation
              const r = el.getBoundingClientRect();
              if (requireOnScreen && !isOnScreen(r)) return;
              const text = getCleanText(el).trim();
              if (text.length < 5 || isChrome(text)) return;
              if (!best || text.length > getCleanText(best).trim().length)
                best = el;
            });
            if (best) {
              const text = getCleanTextWithCitations(best).trim();
              if (text.length > 5) {
                debug.editorFound = sel + (requireOnScreen ? "" : " (any)");
                return {
                  content: text,
                  html: getCleanHtml(best),
                  method: "note-body:" + sel,
                  debug,
                };
              }
            }
          }
          return null;
        };
        // Prefer the on-screen note body; fall back to any non-chat note body.
        const body0 = pickBody(true) || pickBody(false);
        if (body0) return body0;

        // === STRATEGY 1: Banner-anchored ===
        // Find "Saved responses are view only" or similar banner
        let bannerEl = null;
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_ELEMENT,
          null,
        );
        let wNode;
        while ((wNode = walker.nextNode())) {
          const t = wNode.textContent?.trim() || "";
          if (t.length > 200 || t.length < 5) continue;
          if (
            /saved\s+(responses?|notes?)\s+are\s+(view|read)|已保存.*(只读|查看)|已儲存.*(唯讀|查看)|読み取り専用|읽기 전용|solo lectura|lecture seule|schreibgeschützt|somente leitura|sola lettura|alleen-lezen/i.test(
              t,
            ) ||
            (t.length < 60 &&
              /view[\-\s]*only|只读|唯讀|読み取り専用|읽기 전용|solo lectura|lecture seule|schreibgeschützt/i.test(
                t,
              ) &&
              !/chat|source|聊天|來源|来源/i.test(t))
          ) {
            if (!bannerEl || t.length < bannerEl.textContent.length) {
              bannerEl = wNode;
            }
          }
        }

        if (bannerEl) {
          debug.bannerFound = true;

          // Walk up from the banner to find the tightest ancestor that has a
          // sibling child with substantial text content (the actual note body).
          // We walk all the way to STUDIO-PANEL / app-body level (up to 10 steps)
          // and pick the best candidate rather than stopping at the first >= 2 children.
          let contentParent = null;
          let candidate = bannerEl.parentElement;
          for (let i = 0; i < 10; i++) {
            if (!candidate?.parentElement) break;
            const children = Array.from(candidate.children);
            // Check if any sibling of the banner-containing child has real text
            const bannerChild = children.find(
              (c) => c === bannerEl || c.contains(bannerEl),
            );
            if (bannerChild) {
              const siblings = children.filter((c) => c !== bannerChild);
              const hasContent = siblings.some((c) => {
                const t = getCleanText(c).trim();
                return t.length > 50 && !isChrome(t);
              });
              if (hasContent) {
                contentParent = candidate;
                break;
              }
            }
            candidate = candidate.parentElement;
          }
          // Fallback to old behaviour if nothing better found
          if (!contentParent) {
            contentParent = bannerEl.parentElement;
            for (let i = 0; i < 5; i++) {
              if (!contentParent?.parentElement) break;
              if (contentParent.children.length >= 2) break;
              contentParent = contentParent.parentElement;
            }
          }

          // Collect all sibling children that are NOT the banner container
          const directChildren = Array.from(contentParent.children);
          const bannerChild = directChildren.find(
            (c) => c === bannerEl || c.contains(bannerEl),
          );
          let contentParts = [];
          let htmlParts = [];
          for (const child of directChildren) {
            if (child === bannerChild) continue;
            const text = getCleanText(child).trim();
            if (isChrome(text)) continue;
            if (text.length < 5) continue;
            contentParts.push(text);
            htmlParts.push(getCleanHtml(child));
          }
          if (contentParts.length > 0 && contentParts.join("").length > 20) {
            return {
              content: contentParts.join("\n\n"),
              html: htmlParts.join(""),
              method: "after-banner-siblings",
              debug,
            };
          }

          // Deeper search — largest block anywhere in contentParent excluding banner
          const blocksAfter = [];
          contentParent
            .querySelectorAll("div, p, section, article")
            .forEach((el) => {
              if (
                bannerEl === el ||
                bannerEl.contains(el) ||
                el.contains(bannerEl)
              )
                return;
              const text = getCleanText(el).trim();
              if (text.length < 30 || isChrome(text)) return;
              blocksAfter.push({
                text,
                html: getCleanHtml(el),
                len: text.length,
              });
            });
          if (blocksAfter.length > 0) {
            blocksAfter.sort((a, b) => b.len - a.len);
            return {
              content: blocksAfter[0].text,
              html: blocksAfter[0].html,
              method: "after-banner-largest",
              debug,
            };
          }

          // Strip parent
          const clone = contentParent.cloneNode(true);
          clone
            .querySelectorAll("style, script, mat-icon, .material-icons")
            .forEach((s) => s.remove());
          const toRemove = [];
          clone.querySelectorAll("*").forEach((el) => {
            const t = el.textContent?.trim() || "";
            if (isChrome(t)) toRemove.push(el);
          });
          toRemove.forEach((el) => {
            try {
              el.remove();
            } catch {}
          });
          const text = getCleanText(clone).trim();
          if (text.length > 30) {
            return {
              content: text,
              html: clone.innerHTML.trim(),
              method: "banner-parent-stripped",
              debug,
            };
          }
        }

        // === STRATEGY 2: Breadcrumb-anchored ===
        // Find "Studio > Note" or "Studio > ..." breadcrumb
        let breadcrumbEl = null;
        const allEls2 = document.querySelectorAll("*");
        for (const el of allEls2) {
          const t = getCleanText(el).trim();
          if (t.length > 60) continue;
          if (
            /^(Studio|工作室|工作區|スタジオ|스튜디오|Estudio|Atelier|Labor|Estúdio)\s*[>›»]\s*(Note|Saved|笔记|筆記|已保存|已儲存|メモ|保存済み|노트|저장됨|Nota|Guardado)/i.test(
              t,
            )
          ) {
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
            if (rect.height > 300 && rect.width > 200 && rect.width < 900)
              break;
          }

          // Find note title then content after it
          const headings = panel.querySelectorAll(
            "h1, h2, h3, [role='heading']",
          );
          let titleEl = null;
          for (const h of headings) {
            const ht = getCleanText(h).trim();
            if (ht.length < 3) continue;
            if (
              ht === noteTitle ||
              noteTitle.startsWith(ht) ||
              ht.startsWith(noteTitle.substring(0, 20))
            ) {
              titleEl = h;
              break;
            }
          }

          // Extract content blocks from panel
          const blocks = [];
          panel.querySelectorAll("div, p, section, article").forEach((el) => {
            if (
              titleEl &&
              (el === titleEl || el.contains(titleEl) || titleEl.contains(el))
            )
              return;
            if (el.contains(breadcrumbEl)) return;
            const text = getCleanText(el).trim();
            if (text.length < 30 || isChrome(text)) return;
            blocks.push({ text, html: getCleanHtml(el), len: text.length });
          });
          if (blocks.length > 0) {
            blocks.sort((a, b) => b.len - a.len);
            return {
              content: blocks[0].text,
              html: blocks[0].html,
              method: "breadcrumb-panel",
              debug,
            };
          }
        }

        // === STRATEGY 3: Title-anchored ===
        // Find the note title heading in the detail view and grab adjacent content
        if (noteTitle && noteTitle.length > 3) {
          const headings = document.querySelectorAll(
            "h1, h2, h3, h4, [role='heading']",
          );
          let titleEl = null;
          for (const h of headings) {
            const ht = getCleanText(h).trim();
            if (!ht || ht.length < 3) continue;
            const rect = h.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (
              ht === noteTitle ||
              noteTitle.startsWith(ht) ||
              ht.startsWith(noteTitle.substring(0, 15))
            ) {
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
            container
              .querySelectorAll("div, p, section, article")
              .forEach((el) => {
                if (
                  el === titleEl ||
                  el.contains(titleEl) ||
                  titleEl.contains(el)
                )
                  return;
                const text = getCleanText(el).trim();
                if (text.length < 30 || isChrome(text)) return;
                blocks.push({ text, html: getCleanHtml(el), len: text.length });
              });
            if (blocks.length > 0) {
              blocks.sort((a, b) => b.len - a.len);
              return {
                content: blocks[0].text,
                html: blocks[0].html,
                method: "title-anchored",
                debug,
              };
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
          return (
            tag === "mat-icon" ||
            cls.includes("material-icons") ||
            cls.includes("mat-icon")
          );
        };
        const getCleanText = (node) => {
          let result = "";
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
            else if (child.nodeType === Node.ELEMENT_NODE) {
              if (child.tagName === "STYLE" || child.tagName === "SCRIPT")
                continue;
              if (isIconElement(child)) continue;
              result += getCleanText(child);
            }
          }
          return result;
        };

        // Try breadcrumb "Studio" link
        const allEls = document.querySelectorAll(
          "a, button, [role='button'], [role='link'], span",
        );
        const studioLabels = [
          "studio",
          "工作室",
          "工作區",
          "スタジオ",
          "스튜디오",
          "estudio",
          "atelier",
          "labor",
          "estúdio",
        ];
        for (const el of allEls) {
          const text = getCleanText(el).trim().toLowerCase();
          if (
            studioLabels.includes(text) &&
            (el.tagName === "A" || el.getAttribute("role") === "link")
          ) {
            el.click();
            return "breadcrumb-studio";
          }
        }

        // Try back/close button (including mat-icon "arrow_back")
        for (const btn of allEls) {
          const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
          const raw = (btn.textContent || "").trim().toLowerCase();
          if (
            aria.includes("back") ||
            aria.includes("close") ||
            aria.includes("返回") ||
            aria.includes("关闭") ||
            aria.includes("關閉") ||
            aria.includes("戻る") ||
            aria.includes("閉じる") ||
            aria.includes("뒤로") ||
            aria.includes("닫기") ||
            aria.includes("volver") ||
            aria.includes("cerrar") ||
            aria.includes("retour") ||
            aria.includes("fermer") ||
            aria.includes("zurück") ||
            aria.includes("schließen") ||
            aria.includes("voltar") ||
            aria.includes("fechar") ||
            raw === "arrow_back" ||
            raw === "close" ||
            raw === "返回" ||
            raw === "关闭" ||
            raw === "關閉" ||
            raw === "戻る" ||
            raw === "閉じる" ||
            raw === "뒤로" ||
            raw === "닫기"
          ) {
            btn.click();
            return "back-button";
          }
        }

        // Fallback: Escape
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
          }),
        );
        return "escape";
      },
    });

    await sleep(800);
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
      (m) => m.collectionId === collectionId,
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

/**
 * Reads NotebookLM's Sources panel state in the tab:
 *   { count: number|null, busy: boolean, method }
 *
 * - `count`: number of sources currently shown (from a "N sources" label, or
 *   a row count). null when unreadable.
 * - `busy`: true while NotebookLM is still processing an upload (a spinner /
 *   progress indicator is visible). Used to wait for a batch to FINISH before
 *   starting the next one — so we never re-drop files that are still loading.
 *
 * The Add-sources dialog subtree is excluded so its own controls don't count.
 */
async function getSourceState(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const getCleanText = (node) => {
          let t = "";
          for (const c of node.childNodes) {
            if (c.nodeType === 3) t += c.textContent;
            else if (c.nodeType === 1) {
              const tag = c.tagName?.toLowerCase() || "";
              const cls = (c.className || "").toString().toLowerCase();
              if (
                tag === "mat-icon" ||
                cls.includes("material-icons") ||
                cls.includes("mat-icon")
              )
                continue;
              t += getCleanText(c);
            }
          }
          return t.trim();
        };
        const inDialog = (el) =>
          !!el.closest('[role="dialog"], mat-dialog-container');

        // Count strategy 1: explicit "N sources" text (virtualization-proof).
        let countFromText = null;
        const countRe =
          /(\d+)\s*(sources?|来源|來源|ソース|소스|출처|fuentes?|quellen?|fontes?|fonti|bronnen|sumber)/i;
        for (const el of document.querySelectorAll(
          'span, div, p, h1, h2, h3, button, [role="button"], [aria-label]',
        )) {
          if (inDialog(el)) continue;
          const text = getCleanText(el);
          if (text.length > 60) continue;
          const m =
            text.match(countRe) ||
            (el.getAttribute("aria-label") || "").match(countRe);
          if (m) {
            const n = parseInt(m[1], 10);
            if (!isNaN(n))
              countFromText =
                countFromText == null ? n : Math.max(countFromText, n);
          }
        }

        // Count strategy 2: source rows.
        const rowSelectors = [
          '[role="list"] [role="listitem"]',
          "mat-list-item",
          '[class*="source"][class*="item"]',
          '[class*="source-list"] > *',
          '[aria-label*="source" i] input[type="checkbox"]',
        ];
        let bestRowCount = 0;
        for (const sel of rowSelectors) {
          const n = [...document.querySelectorAll(sel)].filter(
            (el) => !inDialog(el),
          ).length;
          if (n > bestRowCount) bestRowCount = n;
        }

        let count = null,
          method = null;
        if (countFromText != null) {
          count = countFromText;
          method = "text";
        } else if (bestRowCount > 0) {
          count = bestRowCount;
          method = "rows";
        }

        // Busy: any processing spinner / progress indicator OUTSIDE the dialog.
        const busyEls = document.querySelectorAll(
          'mat-spinner, mat-progress-spinner, mat-progress-bar, [role="progressbar"], .mdc-circular-progress, [class*="spinner"], [class*="loading"], [aria-busy="true"]',
        );
        let busy = false;
        for (const el of busyEls) {
          if (inDialog(el)) continue;
          const s = window.getComputedStyle(el);
          if (s.display === "none" || s.visibility === "hidden") continue;
          busy = true;
          break;
        }

        return { count, method, busy };
      },
    });
    return r?.[0]?.result || { count: null, method: null, busy: false };
  } catch {
    return { count: null, method: null, busy: false };
  }
}

/**
 * Reads the live source list from NotebookLM's Sources panel.
 *
 * Returns one record per source: { label, faviconDomain }, where:
 *   - `label`         is the full, UNtruncated source name (from aria-label).
 *   - `faviconDomain` is the URL encoded in the favicon icon's src
 *     (https://www.google.com/s2/favicons?domain=<URL>) — a stable, exact
 *     identifier for URL sources. Null for PDFs (generic doc icon).
 *
 * Returns `null` (not []) when the Sources panel isn't open / readable, so
 * callers can tell "panel not visible" from "genuinely zero sources" and
 * avoid pruning markers on a blind read.
 *
 * DOM contract (verified against NotebookLM, 2026-06):
 *   - each source row is `div.single-source-container`
 *   - its name lives in `aria-label` on the row's title/button descendants
 *   - the favicon is `img.favicon-icon` with src `...?domain=<sourceURL>&sz=..`
 */
async function getSourceNames(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const inDialog = (el) =>
          !!el.closest('[role="dialog"], mat-dialog-container');
        const rows = [
          ...document.querySelectorAll(".single-source-container"),
        ].filter((el) => !inDialog(el));
        // Panel not open / not rendered → signal "unreadable", don't report 0.
        if (rows.length === 0) return null;

        const decodeFaviconDomain = (src) => {
          if (!src) return null;
          const m = src.match(/[?&]domain=([^&]+)/);
          if (!m) return null;
          try {
            return decodeURIComponent(m[1]);
          } catch {
            return m[1];
          }
        };

        return rows
          .map((row) => {
            // Full untruncated name: prefer the title element's aria-label.
            const titleEl =
              row.querySelector(".source-title[aria-label]") ||
              row.querySelector("[aria-label]");
            const label = (
              titleEl?.getAttribute("aria-label") ||
              row.textContent ||
              ""
            )
              .replace(/more_vert\s*$/i, "")
              .trim();
            const favSrc =
              row
                .querySelector('img.favicon-icon, [class*="favicon"]')
                ?.getAttribute("src") || "";
            return { label, faviconDomain: decodeFaviconDomain(favSrc) };
          })
          .filter((s) => s.label || s.faviconDomain);
      },
    });
    return r?.[0]?.result ?? null;
  } catch {
    return null;
  }
}

// Normalizes a URL for exact comparison between a Zotero item's URL and the
// domain= value NotebookLM encodes in a source's favicon. Drops the scheme,
// "www.", any trailing slash, and lowercases — so http/https and www variants
// of the same source URL compare equal.
function normalizeSourceUrl(u) {
  return String(u || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

// Normalizes a source label / filename for fuzzy comparison: lowercase,
// strip a trailing extension, collapse non-alphanumerics. Lets a stored
// upload name ("Qi et al. - 2022 - Prognostic.pdf") match the label
// NotebookLM renders for the same source even with minor formatting drift.
function normalizeSourceName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\.(pdf|html?|docx?|txt|md)$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Returns true if `stored` (an upload-time name) appears among the live
// NotebookLM source labels. NotebookLM truncates long labels in the DOM
// (e.g. "Qi et al. - 2022 - Prognostic Implications of Mo…"), so exact
// equality rarely holds for PDFs. Matching strategy, most to least strict:
//   1. normalized equality
//   2. either string is a prefix of the other (handles end-truncation)
//   3. one string fully contains the other (handles mid-truncation / icons)
//   4. strong leading-token overlap (handles "…" mid-cut where tails differ)
function nameStillPresent(stored, liveNormalized) {
  const n = normalizeSourceName(stored);
  if (!n) return false;
  const nTokens = n.split(" ").filter(Boolean);

  for (const live of liveNormalized) {
    if (!live) continue;
    if (live === n) return true;

    const shorter = n.length <= live.length ? n : live;
    const longer = n.length <= live.length ? live : n;
    if (
      shorter.length >= 6 &&
      (longer.startsWith(shorter) || longer.includes(shorter))
    ) {
      return true;
    }

    // Leading-token overlap: NotebookLM may cut mid-word, so compare the first
    // several whitespace tokens. Strong overlap on the prefix is a confident
    // match for academic filenames ("Author - Year - Title…").
    const liveTokens = live.split(" ").filter(Boolean);
    const cmp = Math.min(nTokens.length, liveTokens.length, 6);
    if (cmp >= 3) {
      let same = 0;
      for (let i = 0; i < cmp; i++) if (nTokens[i] === liveTokens[i]) same++;
      if (same >= 3 && same === cmp) return true;
    }
  }
  return false;
}

/**
 * Reconciles the saved upload registry for (collection, notebook) against the
 * notebook's live sources, pruning markers for sources that were removed in
 * NotebookLM so those items can be re-uploaded.
 *
 * Name-driven: a marker is kept only if its stored source name is still found
 * among the notebook's live source labels. Removing a source clears its marker
 * (re-uploadable); a rename also clears it, and re-syncing simply re-adds it.
 *
 * Safety rails to avoid wrongly clearing valid markers:
 *   - If the live panel can't be read (null), nothing is pruned.
 *   - Legacy markers (stored as a bare timestamp, no name) can't be name-matched,
 *     so they're kept — they predate name capture.
 *   - If EVERY marker would be pruned but the notebook still has sources, we
 *     assume a transient/misread panel and prune nothing (prevents a bad read
 *     from wiping the whole registry).
 *
 * Returns the (possibly pruned) array of still-valid item keys.
 */
async function reconcileSyncedKeys(collectionId, notebookId, tabId) {
  const syncKey = `sync_${collectionId}_${notebookId}`;
  const state = await chrome.storage.local.get(syncKey);
  const registry = state[syncKey] || {};
  const keys = Object.keys(registry);
  if (keys.length === 0) return [];

  // Don't reconcile while NotebookLM is still ingesting sources — the source
  // list/count is mid-update and would falsely look like deletions.
  const liveState = await getSourceState(tabId);
  if (liveState && liveState.busy) {
    console.log(
      `[n2z] Reconcile ${syncKey}: notebook busy ingesting — keeping all ${keys.length} markers.`,
    );
    return keys;
  }

  const liveSources = await getSourceNames(tabId); // [{label, faviconDomain}] | null
  if (liveSources == null) {
    console.log(
      `[n2z] Reconcile ${syncKey}: Sources panel not readable — keeping all ${keys.length} markers.`,
    );
    return keys; // panel not open / unreadable — never prune blind
  }

  // Build live lookup sets for exact matching.
  const liveLabels = new Set(
    liveSources.map((s) => String(s.label || "").trim()).filter(Boolean),
  );
  const liveDomains = new Set(
    liveSources.map((s) => normalizeSourceUrl(s.faviconDomain)).filter(Boolean),
  );
  const liveNormalized = liveSources
    .map((s) => normalizeSourceName(s.label))
    .filter(Boolean);

  const nameBearingKeys = keys.filter((k) => {
    const e = registry[k];
    return (
      e &&
      typeof e === "object" &&
      (e.label || e.name || e.url || e.faviconDomain)
    );
  });

  // A marker's source is "present" if ANY of its identifiers match a live
  // source, checked strongest first:
  //   1. favicon domain / stored URL  → exact, stable id for URL sources
  //   2. exact label                  → exact untruncated name captured at sync
  //   3. exact `name` vs live label   → PDF filename == NotebookLM's PDF label,
  //      which recovers markers written before `label` capture existed
  //   4. fuzzy name                   → last-resort for odd legacy markers
  const stillPresent = (e) => {
    const dom = normalizeSourceUrl(e.faviconDomain || e.url);
    if (dom && liveDomains.has(dom)) return true;
    if (e.label && liveLabels.has(String(e.label).trim())) return true;
    if (e.name && liveLabels.has(String(e.name).trim())) return true;
    if (e.name) return nameStillPresent(e.name, liveNormalized);
    return false;
  };
  const nameAbsent = nameBearingKeys.filter((k) => !stillPresent(registry[k]));

  // Authoritative source count (prefers NotebookLM's "N sources" text).
  const countState =
    liveState && liveState.count != null
      ? liveState
      : await getSourceState(tabId);
  const liveCount =
    countState && countState.count != null
      ? countState.count
      : liveSources.length;

  // POSITIVE-SIGNAL pruning: only remove markers when the notebook genuinely
  // has FEWER sources than we have markers — i.e. something was really deleted.
  // The number we may prune is exactly that shortfall. A mere name-match miss
  // (panel not ready, label drift, ingestion lag) with no count drop prunes
  // NOTHING, so a transient read can never destroy a valid marker.
  const shortfall = nameBearingKeys.length - liveCount;

  // Diagnostic: surface the exact comparison so mismatches are debuggable.
  console.log(
    `[n2z] Reconcile ${syncKey}: ${nameBearingKeys.length} markers, liveCount=${liveCount} ` +
      `(rows=${liveSources.length}), name-absent=${nameAbsent.length}, shortfall=${shortfall}\n` +
      `  stored: ${nameBearingKeys.map((k) => JSON.stringify(registry[k].label || registry[k].url || registry[k].name)).join(", ")}\n` +
      `  live:   ${liveSources.map((s) => JSON.stringify(s.label || s.faviconDomain)).join(", ")}`,
  );

  if (shortfall <= 0 || nameAbsent.length === 0) return keys; // nothing provably removed

  // Prune the name-absent markers, but never more than the real shortfall —
  // so a coincidental mismatch can't remove more than were actually deleted.
  const toPrune = nameAbsent.slice(0, shortfall);
  for (const k of toPrune) delete registry[k];
  await chrome.storage.local.set({ [syncKey]: registry });

  // Mirror the prune into the durable Zotero mapping (the source of truth the
  // checkmarks read), so removed sources clear there too.
  try {
    const m = await zoteroRequest("/n2z/mapping", {
      action: "get",
      collectionId,
    });
    if (m?.success && m.data && m.data.notebookId === notebookId) {
      for (const k of toPrune) delete m.data.syncedItemHashes?.[k];
      await zoteroRequest("/n2z/mapping", { action: "set", mapping: m.data });
    }
  } catch {
    /* best-effort; local cache already pruned */
  }

  console.log(
    `[n2z] Reconcile pruned ${toPrune.length} removed source(s); ${Object.keys(registry).length} remain.`,
  );
  return Object.keys(registry);
}

/**
 * Broadcasts a progress update to the popup (fire-and-forget).
 * The popup may not be open, so we ignore errors.
 */
function broadcastProgress(payload) {
  chrome.runtime
    .sendMessage({ type: "n2z-sync-progress", ...payload })
    .catch(() => {});
}

/**
 * Polls a predicate function inside a tab until it returns truthy, or the
 * timeout elapses. Returns the final result (the last value the predicate
 * returned). Used to replace fixed sleeps that wait on DOM transitions.
 */
async function waitForInTab(
  tabId,
  predicateFn,
  { timeoutMs = 3000, intervalMs = 100, args = [] } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: predicateFn,
        args,
      });
      last = r?.[0]?.result;
      if (last) return last;
    } catch {
      // tab may be transitioning; retry
    }
    await sleep(intervalMs);
  }
  return last;
}

// ─── Message handlers ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    switch (message.type) {
      case "n2z-check-connection":
        // Returns { connected, reason } — reason in {ok, timeout, blocked-or-down}
        return await checkZoteroConnection();

      case "n2z-get-libraries":
        return getLibraries();

      case "n2z-get-collections":
        return getCollections(message.libraryId);

      case "n2z-get-mappings":
        return getMappings();

      case "n2z-get-synced-items": {
        // Durable source of truth for "already uploaded": the per-item record
        // stored in the Zotero mapping (mapping.syncedItemHashes), keyed by
        // Zotero itemKey. Survives popup reopen; never touched by DOM reads.
        const m = await zoteroRequest("/n2z/mapping", {
          action: "get",
          collectionId: message.collectionId,
        });
        const hashes =
          m?.success && m.data ? m.data.syncedItemHashes || {} : {};
        // Only count items mapped to the CURRENTLY connected notebook, so the
        // checks reflect the notebook the user is actually looking at.
        const wantNb = message.notebookId || null;
        const sameNb =
          !wantNb || !m?.data?.notebookId || m.data.notebookId === wantNb;
        return { success: true, data: sameNb ? Object.keys(hashes) : [] };
      }

      case "n2z-remove-mapping":
        return removeMapping(message.collectionId);

      case "n2z-forward-sync":
        return forwardSync(
          message.collectionId,
          message.collectionName,
          message.selectedItemKeys,
          message.libraryId,
          message.libraryName,
          message.tag,
        );

      case "n2z-sync-status": {
        const prog = syncProgress.get(message.tabId);
        return prog
          ? { success: true, data: prog }
          : { success: false, error: "No sync in progress" };
      }

      case "n2z-cancel-sync": {
        // Flag the active sync to stop at its next safe checkpoint. If no tabId
        // is given, cancel the sole active sync (the common single-notebook case).
        let tabId = message.tabId;
        if (tabId == null) {
          const ids = [...activeSyncs];
          tabId = ids.length === 1 ? ids[0] : null;
        }
        if (tabId != null && activeSyncs.has(tabId)) {
          cancelledSyncs.add(tabId);
          return { success: true, cancelling: true };
        }
        return { success: false, error: "No sync in progress to cancel" };
      }

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

      case "n2z-get-tags":
        return getTags(message.libraryId);

      case "n2z-get-items":
        return getExportableItems({
          collectionId: message.collectionId,
          libraryId: message.libraryId,
          tag: message.tag,
        });

      case "n2z-inspect-upload-dialog": {
        const { tab: inspectTab } = await resolveNotebookLMTab();
        if (!inspectTab)
          return { success: false, error: "No NotebookLM tab found" };
        const r = await chrome.scripting.executeScript({
          target: { tabId: inspectTab.id },
          func: () => {
            const dialog =
              document.querySelector('[role="dialog"]') || document.body;
            const inputs = [...document.querySelectorAll("input")].map((i) => ({
              type: i.type,
              id: i.id,
              name: i.name,
              cls: i.className.slice(0, 80),
              accept: i.accept,
              visible: window.getComputedStyle(i).display !== "none",
            }));
            const buttons = [
              ...document.querySelectorAll('button, [role="button"]'),
            ]
              .filter((e) => {
                const s = window.getComputedStyle(e);
                return s.display !== "none" && s.visibility !== "hidden";
              })
              .map((e) => ({
                tag: e.tagName,
                text: e.textContent?.trim().slice(0, 60),
                cls: e.className?.slice(0, 60),
              }));
            return {
              dialogHTML: dialog.innerHTML.slice(0, 4000),
              inputs,
              buttons: buttons.slice(0, 20),
              bodyText: document.body.textContent.slice(0, 500),
            };
          },
        });
        return { success: true, data: r?.[0]?.result };
      }

      case "n2z-reconcile-synced": {
        // Explicit removal check (triggered by the "Check notebook" button).
        // Prunes markers for sources removed in NotebookLM, then returns the
        // remaining synced item keys from the durable Zotero mapping.
        const { tab: recTab } = await resolveNotebookLMTab();
        const readMappingKeys = async () => {
          const m = await zoteroRequest("/n2z/mapping", {
            action: "get",
            collectionId: message.collectionId,
          });
          const sameNb =
            m?.data &&
            (!message.notebookId || m.data.notebookId === message.notebookId);
          return sameNb ? Object.keys(m.data.syncedItemHashes || {}) : [];
        };
        // Never probe the tab while a sync is uploading to it — a concurrent
        // scripting read can disrupt the CDP file-chooser handshake.
        if (!recTab || activeSyncs.has(recTab.id)) {
          return { success: true, data: await readMappingKeys() };
        }
        await reconcileSyncedKeys(
          message.collectionId,
          message.notebookId,
          recTab.id,
        );
        return { success: true, data: await readMappingKeys() };
      }

      case "n2z-clear-sync-state": {
        // Clear all sync state for this collection: the local cache AND the
        // durable per-item record in the Zotero mapping (the source of truth).
        const allKeys = await chrome.storage.local.get(null);
        const keysToRemove = Object.keys(allKeys).filter(
          (k) =>
            k.startsWith(`sync_${message.collectionId}_`) ||
            k === `sync_${message.collectionId}`,
        );
        if (keysToRemove.length > 0) {
          await chrome.storage.local.remove(keysToRemove);
        }
        try {
          const m = await zoteroRequest("/n2z/mapping", {
            action: "get",
            collectionId: message.collectionId,
          });
          if (m?.success && m.data) {
            m.data.syncedItemHashes = {};
            await zoteroRequest("/n2z/mapping", {
              action: "set",
              mapping: m.data,
            });
          }
        } catch {
          /* best-effort */
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
          const notebookId = extractNotebookIdFromUrl(nlmTab.url);
          // Cache extracted notes per notebook so they survive the popup being
          // closed/reopened. A fresh "Find Text Notes" overwrites the cache.
          if (notebookId) {
            await chrome.storage.local.set({
              [notesCacheKey(notebookId)]: {
                notebookId,
                notebookTitle: nlmTab.title || "",
                notes,
                extractedAt: Date.now(),
              },
            });
          }
          return {
            success: true,
            data: notes,
            notebookId,
            debug: notes.length === 0 ? `Page: ${nlmTab.title}` : undefined,
          };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      case "n2z-get-cached-notes": {
        // Return previously-extracted notes for the active notebook, if any.
        const { tab: cacheTab } = await resolveNotebookLMTab();
        const notebookId = cacheTab
          ? extractNotebookIdFromUrl(cacheTab.url)
          : "";
        if (!notebookId)
          return { success: false, error: "No NotebookLM tab found" };
        const stored = await chrome.storage.local.get(
          notesCacheKey(notebookId),
        );
        const entry = stored[notesCacheKey(notebookId)];
        if (entry && Array.isArray(entry.notes)) {
          return {
            success: true,
            data: entry.notes,
            notebookId,
            extractedAt: entry.extractedAt,
          };
        }
        return { success: true, data: [], notebookId };
      }

      case "n2z-import-selected-notes": {
        // Import pre-extracted notes (selected by user in popup) into Zotero
        const { tab: nlmTab2 } = await resolveNotebookLMTab();
        const notebookId2 = nlmTab2
          ? extractNotebookIdFromUrl(nlmTab2.url)
          : "";
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
          return {
            success: false,
            error: importResult.error || "Failed to import notes",
          };
        }

        const imported = (importResult.data || []).filter(
          (r) => r !== null,
        ).length;
        const skipped = (importResult.data || []).filter(
          (r) => r === null,
        ).length;

        return {
          success: true,
          message: `Imported ${imported} notes${skipped > 0 ? ` (${skipped} duplicates skipped)` : ""}.`,
          imported,
          skipped,
          total: notes.length,
        };
      }

      default:
        return { success: false, error: "未知消息类型" };
    }
  };

  handler()
    .then(sendResponse)
    .catch((e) => sendResponse({ success: false, error: e.message }));

  return true;
});
