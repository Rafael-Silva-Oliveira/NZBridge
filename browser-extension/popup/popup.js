/**
 * n2z Popup UI — Controls for forward and backward sync
 */

document.addEventListener("DOMContentLoaded", init);

async function init() {
  setupTabs();
  await checkConnection();
  await loadLibraries();
  await loadNotebookInfo();
  await loadMappings();
  setupEventListeners();
  await initPrereqBanners();
  await resumeInProgressSync();
}

async function initPrereqBanners() {
  const { prereqCollapsed } = await chrome.storage.local.get("prereqCollapsed");
  const banners = [
    { banner: "prereq-banner",        btn: "prereq-toggle" },
    { banner: "prereq-banner-import", btn: "prereq-toggle-import" },
  ];
  for (const { banner, btn } of banners) {
    const el = document.getElementById(banner);
    const toggleBtn = document.getElementById(btn);
    if (!el || !toggleBtn) continue;
    if (prereqCollapsed) el.classList.add("collapsed");
    toggleBtn.addEventListener("click", async () => {
      const isCollapsed = el.classList.toggle("collapsed");
      // Mirror state to the other banner instantly
      document.querySelectorAll(".prereq-banner").forEach(b => {
        isCollapsed ? b.classList.add("collapsed") : b.classList.remove("collapsed");
      });
      await chrome.storage.local.set({ prereqCollapsed: isCollapsed });
    });
  }
}

async function resumeInProgressSync() {
  // Check if a sync is already running (e.g. popup was closed and reopened)
  const tabResult = await sendMessage({ type: "n2z-get-notebooklm-tab" }, 3000);
  if (!tabResult?.success || !tabResult?.data?.id) return;

  const tabId = tabResult.data.id;
  const status = await sendMessage({ type: "n2z-sync-status", tabId }, 3000);
  if (!status?.success || !status?.data || status.data.done) return;

  // A sync is in progress — show the progress UI and start polling
  const btn = document.getElementById("btn-sync");
  const progress = document.getElementById("sync-progress");
  const progressText = document.getElementById("progress-text");
  const progressCount = document.getElementById("progress-count");
  const progressFill = document.getElementById("progress-fill");

  btn.disabled = true;
  progress.classList.remove("hidden");

  const updateUI = (data) => {
    if (data.total > 0) {
      progressFill.classList.remove("indeterminate");
      progressFill.style.width = Math.round((data.current / data.total) * 100) + "%";
      progressCount.textContent = `${data.current} / ${data.total}`;
    } else {
      progressFill.classList.add("indeterminate");
      progressCount.textContent = "";
    }
    if (data.phase === "files" && data.currentTitle) {
      progressText.textContent = truncate(data.currentTitle, 34);
    } else if (data.phase === "urls") {
      progressText.textContent = data.currentTitle || "Adding URLs…";
    } else {
      progressText.textContent = "Syncing…";
    }
  };

  updateUI(status.data);

  const pollInterval = setInterval(async () => {
    const s = await sendMessage({ type: "n2z-sync-status", tabId }, 5000);
    if (!s?.data) return;
    updateUI(s.data);
    if (s.data.done) {
      clearInterval(pollInterval);
      const result = s.data.result;
      const resultDiv = document.getElementById("sync-result");
      resultDiv.classList.remove("hidden");
      resultDiv.className = result?.success ? "result success" : "result error";
      resultDiv.textContent = result?.message || result?.error || "Sync finished";
      btn.disabled = false;
      progress.classList.add("hidden");
      progressFill.style.width = "0%";
      await loadMappings(result?.mapping ? [result.mapping] : []);
    }
  }, 1500);
}

// ─── Tab navigation ──────────────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document
        .querySelectorAll(".tab")
        .forEach((t) => t.classList.remove("active"));
      document
        .querySelectorAll(".tab-content")
        .forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      document
        .getElementById(`tab-${tab.dataset.tab}`)
        .classList.add("active");
    });
  });
}

// ─── Connection check ────────────────────────────────────────────────

async function checkConnection() {
  const result = await sendMessage({ type: "n2z-check-connection" });
  const dot = document.getElementById("status-dot");
  const banner = document.getElementById("error-banner");

  if (result.connected) {
    dot.className = "dot connected";
    banner.classList.add("hidden");
  } else {
    dot.className = "dot disconnected";
    banner.innerHTML = connectionErrorHtml(result.reason);
    banner.classList.remove("hidden");
  }
}

// Builds the connection-error banner for the popup. On Chrome/Edge 142+,
// "Local network access" blocks the service worker from reaching Zotero on
// localhost; that needs different guidance than "Zotero isn't running".
function connectionErrorHtml(reason) {
  if (reason === "blocked-or-down" || reason === "timeout") {
    return (
      "<strong>Can't reach Zotero on localhost.</strong> Make sure Zotero is " +
      "running. On Chrome/Edge 142+ you may also need to allow the local " +
      "connection: open <code>chrome://extensions</code> → <strong>NZBridge</strong> " +
      "→ <strong>Details</strong> → <strong>Site settings</strong>, set " +
      "<strong>Local network access</strong> to <strong>Allow</strong>, then " +
      "reopen this popup. (Edge: <code>edge://extensions</code>)"
    );
  }
  return "Cannot connect to Zotero. Is it running with NZBridge installed?";
}

// ─── Library + Collection loading ───────────────────────────────────

// Cache: Array<{ libraryId, libraryName, libraryType, collections }>
window._libraryTree = [];

async function loadLibraries() {
  let result = await sendMessage({ type: "n2z-get-libraries" });

  // Fallback: older plugin version without /n2z/libraries — use the flat collection list
  if (!result.success || !result.data || result.data.length === 0) {
    const fallback = await sendMessage({ type: "n2z-get-collections" });
    if (fallback.success && fallback.data) {
      result = {
        success: true,
        data: [{ libraryId: 0, libraryName: "My Library", libraryType: "user", collections: fallback.data }],
      };
    }
  }

  const syncLibSel   = document.getElementById("library-select");
  const importLibSel = document.getElementById("import-library-select");

  if (!result.success || !result.data || result.data.length === 0) {
    const msg = '<option value="">No libraries found</option>';
    syncLibSel.innerHTML = msg;
    importLibSel.innerHTML = msg;
    document.getElementById("collection-select").innerHTML = '<option value="">No collections found</option>';
    document.getElementById("import-collection-select").innerHTML = '<option value="">No collections found</option>';
    return;
  }

  window._libraryTree = result.data;

  for (const [libSel, colSel] of [
    [syncLibSel,   document.getElementById("collection-select")],
    [importLibSel, document.getElementById("import-collection-select")],
  ]) {
    libSel.innerHTML = "";
    for (const lib of result.data) {
      const opt = document.createElement("option");
      opt.value = lib.libraryId;
      opt.textContent = lib.libraryType === "group" ? `Group: ${lib.libraryName}` : lib.libraryName;
      opt.dataset.libraryName = lib.libraryName;
      opt.dataset.libraryType = lib.libraryType;
      libSel.appendChild(opt);
    }
    // Populate collections for the initially-selected library
    populateCollectionsForLibrary(libSel, colSel);
  }
}

function populateCollectionsForLibrary(libSelect, colSelect) {
  const libraryId = parseInt(libSelect.value);
  const lib = window._libraryTree.find((l) => l.libraryId === libraryId);
  colSelect.innerHTML = '<option value="">Select a collection...</option>';
  if (lib) populateCollectionOptions(colSelect, lib.collections, 0);
}

function populateCollectionOptions(select, collections, depth) {
  for (const col of collections) {
    const option = document.createElement("option");
    option.value = col.id;
    const indent = "  ".repeat(depth);
    const prefix = depth > 0 ? "└ " : "";
    option.textContent = indent + prefix + col.name + ` (${col.itemCount})`;
    option.dataset.name = col.name;
    select.appendChild(option);
    if (col.children && col.children.length > 0) {
      populateCollectionOptions(select, col.children, depth + 1);
    }
  }
}

// ─── NotebookLM tab info ─────────────────────────────────────────────

async function loadNotebookInfo() {
  const result = await sendMessage({ type: "n2z-get-notebooklm-tab" });
  const info = document.getElementById("notebook-info");

  if (result.success && result.data) {
    info.textContent = `Connected: ${result.data.notebookId || "Notebook detected"}`;
    info.style.color = "#166534";
  } else {
    info.textContent = result.error || "No NotebookLM tab open";
    info.style.color = "#991b1b";
  }
}

// ─── Item preview ────────────────────────────────────────────────────

// Stores loaded items so handleForwardSync can read selected keys
window._previewItems = [];

async function previewItems(collectionId) {
  const preview = document.getElementById("item-preview");
  const summary = document.getElementById("item-summary");
  const itemList = document.getElementById("item-list");
  const syncBtn = document.getElementById("btn-sync");
  const resetBtn = document.getElementById("btn-reset-sync");

  window._previewItems = [];

  if (!collectionId) {
    preview.classList.add("hidden");
    itemList.classList.add("hidden");
    syncBtn.disabled = true;
    resetBtn.disabled = true;
    return;
  }

  summary.textContent = "Loading items...";
  preview.classList.remove("hidden");
  itemList.classList.add("hidden");

  const result = await sendMessage({
    type: "n2z-get-items",
    collectionId: parseInt(collectionId),
  });

  if (!result.success || !result.data) {
    summary.innerHTML = '<span class="warn">Could not load items</span>';
    syncBtn.disabled = true;
    return;
  }

  const items = result.data;
  window._previewItems = items;

  const fileItems = items.filter((i) => i.exportType === "file");
  const urlItems  = items.filter((i) => i.exportType === "url");
  const totalCount = items.length;

  if (totalCount === 0) {
    summary.innerHTML = '<span class="warn">No exportable items (no PDFs, URLs, or DOIs found)</span>';
    syncBtn.disabled = true;
    return;
  }

  // Summary line
  const parts = [];
  if (fileItems.length) parts.push(`${fileItems.length} PDF${fileItems.length > 1 ? "s" : ""}`);
  if (urlItems.length)  parts.push(`${urlItems.length} URL${urlItems.length > 1 ? "s" : ""}`);
  let summaryHtml = `<strong>${totalCount} item${totalCount > 1 ? "s" : ""}</strong>: ${parts.join(", ")}`;
  if (totalCount > 50) {
    summaryHtml += `<br/><span class="warn">&#9888; ${totalCount} items — NotebookLM free tier supports max 50 sources</span>`;
  }
  summary.innerHTML = summaryHtml;

  // Render file group
  const filesContainer = document.getElementById("files-container");
  const urlsContainer  = document.getElementById("urls-container");
  const fileCountEl    = document.getElementById("file-count");
  const urlCountEl     = document.getElementById("url-count");
  const groupFiles     = document.getElementById("group-files");
  const groupUrls      = document.getElementById("group-urls");

  filesContainer.innerHTML = "";
  urlsContainer.innerHTML  = "";

  if (fileItems.length) {
    fileCountEl.textContent = `(${fileItems.length})`;
    groupFiles.classList.remove("hidden");
    for (const item of fileItems) {
      filesContainer.appendChild(makeItemRow(item));
    }
  } else {
    groupFiles.classList.add("hidden");
  }

  if (urlItems.length) {
    urlCountEl.textContent = `(${urlItems.length})`;
    groupUrls.classList.remove("hidden");
    for (const item of urlItems) {
      urlsContainer.appendChild(makeItemRow(item));
    }
  } else {
    groupUrls.classList.add("hidden");
  }

  itemList.classList.remove("hidden");
  syncBtn.disabled = false;
  resetBtn.disabled = false;

  // Group select-all checkboxes
  document.getElementById("select-all-files").onchange = (e) => {
    filesContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = e.target.checked);
    updateSyncButtonState();
  };
  document.getElementById("select-all-urls").onchange = (e) => {
    urlsContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = e.target.checked);
    updateSyncButtonState();
  };

  // Update sync button when individual items toggled
  itemList.querySelectorAll('.item-row input[type="checkbox"]').forEach(cb => {
    cb.onchange = () => updateSyncButtonState();
  });
  updateSyncButtonState();
}

function makeItemRow(item) {
  const row = document.createElement("label");
  row.className = "item-row";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = true;
  cb.dataset.itemKey = item.itemKey;
  const name = document.createElement("span");
  name.className = "item-row-name";
  name.textContent = item.title || item.url || item.itemKey;
  name.title = item.title || item.url || "";
  row.appendChild(cb);
  row.appendChild(name);
  return row;
}

function getSelectedItemKeys() {
  return Array.from(
    document.querySelectorAll('#item-list .item-row input[type="checkbox"]:checked')
  ).map(cb => cb.dataset.itemKey);
}

function updateSyncButtonState() {
  const anySelected = getSelectedItemKeys().length > 0;
  document.getElementById("btn-sync").disabled = !anySelected;
}

// ─── Mappings ────────────────────────────────────────────────────────

async function loadMappings(fallbackMappings = []) {
  const result = await sendMessage({ type: "n2z-get-mappings" });
  const list = document.getElementById("mappings-list");
  const mappings =
    result.success && Array.isArray(result.data) && result.data.length > 0
      ? result.data
      : fallbackMappings;

  if (!mappings || mappings.length === 0) {
    list.innerHTML = '<p class="empty-state">No mappings yet.</p>';
    return;
  }

  list.innerHTML = "";
  for (const mapping of mappings) {
    const item = document.createElement("div");
    item.className = "mapping-item";

    const lastSync = mapping.lastSyncForward
      ? new Date(mapping.lastSyncForward).toLocaleDateString()
      : "Never";

    const libraryBadge = mapping.libraryName && mapping.libraryName !== "My Library"
      ? `<div class="mapping-library">Library: ${escapeHtml(mapping.libraryName)}</div>`
      : "";

    item.innerHTML = `
      <div class="mapping-info">
        <div class="mapping-collection">${escapeHtml(mapping.collectionName)}</div>
        ${libraryBadge}
        <div class="mapping-notebook">Notebook: ${escapeHtml(mapping.notebookId || "Unknown")}</div>
        <div class="mapping-sync">Last sync: ${lastSync}</div>
      </div>
      <button class="mapping-delete" data-collection-id="${mapping.collectionId}" title="Remove mapping">&times;</button>
    `;

    list.appendChild(item);
  }

  list.querySelectorAll(".mapping-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const collectionId = parseInt(btn.dataset.collectionId);
      await sendMessage({ type: "n2z-remove-mapping", collectionId });
      await loadMappings();
    });
  });
}

// ─── Event listeners ─────────────────────────────────────────────────

function setupEventListeners() {
  // Library dropdowns repopulate their matching collection select on change
  const syncLibSel   = document.getElementById("library-select");
  const syncColSel   = document.getElementById("collection-select");
  const importLibSel = document.getElementById("import-library-select");
  const importColSel = document.getElementById("import-collection-select");

  syncLibSel.addEventListener("change", () => {
    populateCollectionsForLibrary(syncLibSel, syncColSel);
    previewItems(""); // reset preview when library changes
  });

  importLibSel.addEventListener("change", () => {
    populateCollectionsForLibrary(importLibSel, importColSel);
  });

  const syncSelect = document.getElementById("collection-select");
  syncSelect.addEventListener("change", () => {
    previewItems(syncSelect.value);
  });

  document
    .getElementById("btn-sync")
    .addEventListener("click", handleForwardSync);

  document
    .getElementById("btn-reset-sync")
    .addEventListener("click", async () => {
      const select = document.getElementById("collection-select");
      if (!select.value) return;
      await sendMessage({ type: "n2z-clear-sync-state", collectionId: parseInt(select.value) });
      const resultDiv = document.getElementById("sync-result");
      resultDiv.classList.remove("hidden");
      resultDiv.className = "result success";
      resultDiv.textContent = "Sync state cleared. You can sync again.";
    });

  document
    .getElementById("btn-extract")
    .addEventListener("click", handleExtractNotes);

  document
    .getElementById("btn-import")
    .addEventListener("click", handleImportNotes);

  document
    .getElementById("select-all")
    .addEventListener("change", (e) => {
      const checked = e.target.checked;
      document
        .querySelectorAll('#notes-container input[type="checkbox"]')
        .forEach((cb) => { cb.checked = checked; });
    });
}

async function handleForwardSync() {
  const select = document.getElementById("collection-select");
  const collectionId = parseInt(select.value);
  const collectionName =
    select.options[select.selectedIndex].dataset.name || "";

  const btn = document.getElementById("btn-sync");
  const progress = document.getElementById("sync-progress");
  const resultDiv = document.getElementById("sync-result");
  const progressText = document.getElementById("progress-text");
  const progressCount = document.getElementById("progress-count");
  const progressFill = document.getElementById("progress-fill");

  btn.disabled = true;
  progress.classList.remove("hidden");
  resultDiv.classList.add("hidden");
  progressText.textContent = "Starting…";
  progressCount.textContent = "";
  progressFill.style.width = "0%";
  progressFill.classList.add("indeterminate");

  let syncTabId = null;

  // Listen for real-time progress broadcasts from the background
  const onProgress = (message) => {
    if (message.type !== "n2z-sync-progress") return;
    if (syncTabId && message.tabId !== syncTabId) return;
    updateProgressUI(message);
    if (message.done) {
      chrome.runtime.onMessage.removeListener(onProgress);
      finishSync(message.result);
    }
  };
  chrome.runtime.onMessage.addListener(onProgress);

  try {
    // Fire-and-forget: background starts sync and returns immediately
    const selectedItemKeys = getSelectedItemKeys();
    const libSel = document.getElementById("library-select");
    const selectedLibOpt = libSel.options[libSel.selectedIndex];
    const startResult = await sendMessage({
      type: "n2z-forward-sync",
      collectionId,
      collectionName,
      selectedItemKeys: selectedItemKeys.length > 0 ? selectedItemKeys : null,
      libraryId: parseInt(libSel.value) || null,
      libraryName: selectedLibOpt?.dataset.libraryName || null,
    }, 10000);

    if (!startResult || !startResult.started) {
      // Sync didn't start (validation error, already running, etc.)
      chrome.runtime.onMessage.removeListener(onProgress);
      resultDiv.classList.remove("hidden");
      resultDiv.className = "result error";
      resultDiv.textContent = (startResult && startResult.error) || "Could not start sync";
      btn.disabled = false;
      progress.classList.add("hidden");
      return;
    }

    syncTabId = startResult.tabId;

    // Fallback: if the popup misses the broadcast (e.g. was briefly closed),
    // poll every 1.5s to keep the UI up to date.
    const pollInterval = setInterval(async () => {
      const status = await sendMessage({ type: "n2z-sync-status", tabId: syncTabId }, 5000);
      if (!status || !status.data) return;
      updateProgressUI(status.data);
      if (status.data.done) {
        clearInterval(pollInterval);
        chrome.runtime.onMessage.removeListener(onProgress);
        finishSync(status.data.result);
      }
    }, 1500);

    // Store cleanup ref so finishSync can clear it
    window._n2zPollInterval = pollInterval;
  } catch (e) {
    chrome.runtime.onMessage.removeListener(onProgress);
    resultDiv.classList.remove("hidden");
    resultDiv.className = "result error";
    resultDiv.textContent = "Error: " + e.message;
    btn.disabled = false;
    progress.classList.add("hidden");
  }

  function updateProgressUI(data) {
    if (data.total > 0) {
      progressFill.classList.remove("indeterminate");
      const pct = Math.round((data.current / data.total) * 100);
      progressFill.style.width = pct + "%";
      progressCount.textContent = `${data.current} / ${data.total}`;
    } else {
      progressFill.classList.add("indeterminate");
      progressCount.textContent = "";
    }

    if (data.phase === "urls") {
      progressText.textContent = data.currentTitle || "Adding URLs…";
    } else if (data.phase === "files") {
      const name = data.currentTitle ? truncate(data.currentTitle, 34) : "Uploading file…";
      progressText.textContent = name;
    } else {
      progressText.textContent = "Syncing…";
    }
  }

  async function finishSync(result) {
    if (window._n2zPollInterval) {
      clearInterval(window._n2zPollInterval);
      window._n2zPollInterval = null;
    }
    progressFill.classList.remove("indeterminate");
    progressFill.style.width = "100%";

    resultDiv.classList.remove("hidden");
    if (result && result.success) {
      resultDiv.className = "result success";
      resultDiv.textContent = result.message;
    } else {
      resultDiv.className = "result error";
      resultDiv.textContent =
        (result && result.error) || (result && result.message) || "Sync failed — no error details returned";
    }

    btn.disabled = false;
    progress.classList.add("hidden");
    progressFill.style.width = "0%";
    await loadMappings(result?.mapping ? [result.mapping] : []);
  }
}

function truncate(str, max) {
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

async function handleExtractNotes() {
  const resultDiv = document.getElementById("import-result");
  const notesSection = document.getElementById("found-notes");
  const container = document.getElementById("notes-container");
  const importBtn = document.getElementById("btn-import");

  resultDiv.classList.add("hidden");
  container.innerHTML = '<p class="empty-state">Scanning for notes...</p>';
  notesSection.classList.remove("hidden");

  try {
    // Use background script to extract notes (popup can't use chrome.scripting)
    const result = await sendMessage({ type: "n2z-extract-notes" });

    if (!result.success) {
      container.innerHTML = `<p class="empty-state">${escapeHtml(result.error || "Could not extract notes")}. Please open a notebook first.</p>`;
      importBtn.disabled = true;
      return;
    }

    const notes = result.data || [];

    if (notes.length === 0) {
      const debugInfo = result.debug || "";
      container.innerHTML = `<p class="empty-state">No notes found in this notebook. ${debugInfo ? "<br/><small>" + escapeHtml(debugInfo) + "</small>" : "Save some notes in NotebookLM first."}</p>`;
      importBtn.disabled = true;
      return;
    }

    container.innerHTML = "";
    for (const note of notes) {
      const item = document.createElement("div");
      item.className = "note-item";

      const preview = stripHtml(note.content || note.html || "").substring(0, 120);
      const debugInfo = note._method ? ` [${note._method}]` : "";
      const debugExtra = note._debug ? ` det:${note._debug.detailOpened} ban:${!!note._debug.bannerFound} bc:${!!note._debug.breadcrumbFound}` : "";
      item.innerHTML = `
        <input type="checkbox" checked data-note-id="${escapeHtml(note.id)}" />
        <div class="note-item-info">
          <div class="note-item-title">${escapeHtml(note.title)}</div>
          <div class="note-item-preview">${escapeHtml((note.type !== "saved-note" ? note.type + " — " : "") + (preview || "(no content)") + debugInfo + debugExtra)}</div>
        </div>
      `;
      container.appendChild(item);
    }

    window._extractedNotes = notes;
    importBtn.disabled = false;
  } catch (e) {
    container.innerHTML = `<p class="empty-state">Error: ${escapeHtml(e.message)}</p>`;
    importBtn.disabled = true;
  }
}

async function handleImportNotes() {
  const select = document.getElementById("import-collection-select");
  const collectionId = parseInt(select.value);
  if (!collectionId) {
    alert("Please select a target collection.");
    return;
  }

  // Get only the checked notes from the extracted set
  const allNotes = window._extractedNotes || [];
  const checkedIds = new Set();
  document.querySelectorAll('#notes-container input[type="checkbox"]:checked').forEach((cb) => {
    checkedIds.add(cb.dataset.noteId);
  });
  const selectedNotes = allNotes.filter((n) => checkedIds.has(n.id));

  if (selectedNotes.length === 0) {
    alert("No notes selected. Please check at least one note.");
    return;
  }

  const customTagsInput = document.getElementById("custom-tags").value;
  const customTags = customTagsInput
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const importBtn = document.getElementById("btn-import");
  const resultDiv = document.getElementById("import-result");

  importBtn.disabled = true;
  resultDiv.classList.add("hidden");

  try {
    const result = await sendMessage({
      type: "n2z-import-selected-notes",
      collectionId,
      customTags,
      notes: selectedNotes,
    });

    resultDiv.classList.remove("hidden");
    if (result && result.success) {
      resultDiv.className = "result success";
      resultDiv.textContent = result.message;
    } else {
      resultDiv.className = "result error";
      resultDiv.textContent =
        (result && result.error) || "Import failed";
    }
  } catch (e) {
    resultDiv.classList.remove("hidden");
    resultDiv.className = "result error";
    resultDiv.textContent = "Error: " + e.message;
  } finally {
    importBtn.disabled = false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sendMessage(message, timeoutMs = 180000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        success: false,
        error:
          "Operation timed out. The background worker may have been suspended — try again.",
      });
    }, timeoutMs);
    chrome.runtime.sendMessage(message, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response || { success: false, error: "No response" });
    });
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return div.textContent || "";
}
