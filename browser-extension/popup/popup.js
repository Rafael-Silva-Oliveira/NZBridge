/**
 * n2z Popup UI — Controls for forward and backward sync
 */

document.addEventListener("DOMContentLoaded", init);

async function init() {
  await setupTheme();
  setupPin();
  setupTabs();
  await checkConnection();
  await loadLibraries();
  setupSearchableSelects();
  await loadNotebookInfo();
  await loadMappings();
  setupEventListeners();
  await restoreSyncSelection();
  await initPrereqBanners();
  await resumeInProgressSync();
  await loadCachedNotes();
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

  // Re-enable Cancel and point it at the resumed sync's tab.
  window._n2zSyncTabId = tabId;
  const resumeCancelBtn = document.getElementById("btn-cancel-sync");
  if (resumeCancelBtn) { resumeCancelBtn.disabled = false; resumeCancelBtn.textContent = "Cancel upload"; }

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
      progressText.textContent = data.currentTitle;
    } else if (data.phase === "urls") {
      progressText.textContent = data.currentTitle || "Adding URLs…";
    } else {
      progressText.textContent = "Syncing…";
    }
    renderProgressFiles(data);
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
      resultDiv.className = result?.cancelled ? "result" : (result?.success ? "result success" : "result error");
      resultDiv.textContent = result?.message || result?.error || "Sync finished";
      btn.disabled = false;
      progress.classList.add("hidden");
      progressFill.style.width = "0%";
      if (resumeCancelBtn) { resumeCancelBtn.disabled = true; resumeCancelBtn.textContent = "Cancel upload"; }
      window._n2zSyncTabId = null;
      await loadMappings(result?.mapping ? [result.mapping] : []);
    }
  }, 1500);
}

// ─── Theme (dark mode) ───────────────────────────────────────────────

// Applies the saved theme (default: dark) and wires the header toggle.
async function setupTheme() {
  const { theme } = await chrome.storage.local.get("theme");
  const current = theme || "dark"; // default to dark
  applyTheme(current);

  const btn = document.getElementById("theme-toggle");
  if (btn) {
    btn.addEventListener("click", async () => {
      const next = document.body.classList.contains("dark") ? "light" : "dark";
      applyTheme(next);
      await chrome.storage.local.set({ theme: next });
    });
  }
}

function applyTheme(theme) {
  const dark = theme === "dark";
  document.body.classList.toggle("dark", dark);
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    btn.textContent = dark ? "☀️" : "🌙";
    btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
  }
}

// ─── Pinned (floating) window ────────────────────────────────────────

// Browser popups can't be moved or kept open, so the pin button reopens
// this same page in a small standalone window (`?pinned=1`) that the user
// can drag around and keep open while working in NotebookLM.
function setupPin() {
  const isPinned = new URLSearchParams(location.search).has("pinned");
  const btn = document.getElementById("pin-toggle");

  if (isPinned) {
    document.body.classList.add("pinned");
    btn?.remove(); // already a floating window
    return;
  }

  btn?.addEventListener("click", async () => {
    // Focus the existing floating window instead of opening a second one
    const { pinnedWindowId } = await chrome.storage.local.get("pinnedWindowId");
    if (pinnedWindowId) {
      try {
        await chrome.windows.update(pinnedWindowId, { focused: true });
        window.close();
        return;
      } catch {
        // window was closed; fall through and create a new one
      }
    }

    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("popup/popup.html?pinned=1"),
      type: "popup",
      width: 396,
      height: 680,
    });
    await chrome.storage.local.set({ pinnedWindowId: win.id });
    window.close();
  });
}

// ─── Searchable collection dropdowns ─────────────────────────────────

// Turns each hidden <select> into a type-to-filter combobox. The <select>
// stays the source of truth (its value + change event), so all downstream
// code keeps working; we just drive it from a filtered list the user types into.
function setupSearchableSelects() {
  document.querySelectorAll(".searchable-select").forEach((wrap) => {
    const select = document.getElementById(wrap.dataset.for);
    if (select) makeSearchable(wrap, select);
  });
}

function makeSearchable(wrap, select) {
  const input = wrap.querySelector(".searchable-input");
  const list = wrap.querySelector(".searchable-list");

  // Reflect the select's current selection into the input text.
  const syncInputFromSelect = () => {
    const opt = select.options[select.selectedIndex];
    input.value = opt && opt.value ? opt.textContent.trim() : "";
  };

  // Build the filtered option list. Matches are case-insensitive substring;
  // an empty query shows everything. The placeholder option (value "") is
  // shown only for the empty query so users can clear the selection.
  const renderList = (query) => {
    const q = query.trim().toLowerCase();
    list.innerHTML = "";
    let count = 0;
    for (const opt of select.options) {
      const label = opt.textContent.trim();
      if (!opt.value && q) continue; // hide placeholder while searching
      if (q && !label.toLowerCase().includes(q)) continue;
      const row = document.createElement("div");
      row.className = "searchable-option";
      if (opt.value === select.value) row.classList.add("selected");
      row.textContent = label;
      row.dataset.value = opt.value;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus handling predictable
        select.value = opt.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        syncInputFromSelect();
        closeList();
      });
      list.appendChild(row);
      count++;
    }
    if (count === 0) {
      const empty = document.createElement("div");
      empty.className = "searchable-empty";
      empty.textContent = "No collections match";
      list.appendChild(empty);
    }
  };

  const openList = () => {
    renderList(""); // show the full list on open; typing filters it
    list.classList.remove("hidden");
  };
  const closeList = () => {
    list.classList.add("hidden");
    syncInputFromSelect(); // restore selected label if the user typed but didn't pick
  };

  input.addEventListener("focus", () => { input.select(); openList(); });
  input.addEventListener("input", () => { renderList(input.value); list.classList.remove("hidden"); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { input.blur(); }
    if (e.key === "Enter") {
      const first = list.querySelector(".searchable-option");
      if (first) {
        select.value = first.dataset.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        syncInputFromSelect();
        list.classList.add("hidden");
        input.blur();
      }
      e.preventDefault();
    }
  });
  // Close when clicking outside this widget.
  document.addEventListener("mousedown", (e) => {
    if (!wrap.contains(e.target)) closeList();
  });

  // Keep input text correct when the select is repopulated/changed in code.
  select.addEventListener("change", syncInputFromSelect);
  // Expose a refresh hook so repopulation can reset the input.
  wrap._refresh = syncInputFromSelect;
  syncInputFromSelect();
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

// Persist the chosen sync (To NotebookLM) library + collection so reopening
// the popup restores it.
async function saveSyncSelection() {
  const libraryId    = document.getElementById("library-select").value || "";
  const collectionId = document.getElementById("collection-select").value || "";
  await chrome.storage.local.set({ lastSyncSelection: { libraryId, collectionId } });
}

// Persist the import (To Zotero) target separately. We record that the user
// explicitly picked it so we stop auto-mirroring the sync selection into it.
async function saveImportSelection() {
  const libraryId    = document.getElementById("import-library-select").value || "";
  const collectionId = document.getElementById("import-collection-select").value || "";
  await chrome.storage.local.set({ lastImportSelection: { libraryId, collectionId, userSet: true } });
}

// Applies a (libraryId, collectionId) to a library/collection select pair and
// refreshes its searchable-input. Returns true if the collection was applied.
function applySelection(libSelId, colSelId, libraryId, collectionId) {
  const libSel = document.getElementById(libSelId);
  const colSel = document.getElementById(colSelId);
  if (libraryId && [...libSel.options].some((o) => o.value === String(libraryId))) {
    libSel.value = String(libraryId);
    populateCollectionsForLibrary(libSel, colSel);
  }
  let applied = false;
  if (collectionId && [...colSel.options].some((o) => o.value === String(collectionId))) {
    colSel.value = String(collectionId);
    applied = true;
  }
  const wrap = document.querySelector(`.searchable-select[data-for="${colSelId}"]`);
  if (wrap && wrap._refresh) wrap._refresh();
  return applied;
}

// Restore the previously chosen sync library + collection (if still present),
// render its item preview, and seed the import (To Zotero) tab with the same
// collection as a placeholder — unless the user has set their own import
// target, which is restored instead.
async function restoreSyncSelection() {
  const { lastSyncSelection, lastImportSelection } =
    await chrome.storage.local.get(["lastSyncSelection", "lastImportSelection"]);

  const sync = lastSyncSelection || {};
  if (sync.libraryId || sync.collectionId) {
    const applied = applySelection(
      "library-select", "collection-select", sync.libraryId, sync.collectionId
    );
    if (applied) await previewItems(sync.collectionId);
  }

  // Import target: the user's own choice wins; otherwise mirror the sync
  // collection as a convenient default (they can still change it).
  if (lastImportSelection && lastImportSelection.userSet) {
    applySelection(
      "import-library-select", "import-collection-select",
      lastImportSelection.libraryId, lastImportSelection.collectionId
    );
  } else if (sync.libraryId || sync.collectionId) {
    applySelection(
      "import-library-select", "import-collection-select",
      sync.libraryId, sync.collectionId
    );
  }
}

function populateCollectionsForLibrary(libSelect, colSelect) {
  const libraryId = parseInt(libSelect.value);
  const lib = window._libraryTree.find((l) => l.libraryId === libraryId);
  colSelect.innerHTML = '<option value="">Select a collection...</option>';
  if (lib) populateCollectionOptions(colSelect, lib.collections, 0);
  // Reset the matching searchable-select input to reflect the cleared selection.
  const wrap = document.querySelector(`.searchable-select[data-for="${colSelect.id}"]`);
  if (wrap && wrap._refresh) wrap._refresh();
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
    info.classList.add("ok");
    info.classList.remove("err");
  } else {
    info.textContent = result.error || "No NotebookLM tab open";
    info.classList.add("err");
    info.classList.remove("ok");
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
  const checkBtn = document.getElementById("btn-check-notebook");

  window._previewItems = [];

  if (!collectionId) {
    preview.classList.add("hidden");
    itemList.classList.add("hidden");
    syncBtn.disabled = true;
    resetBtn.disabled = true;
    if (checkBtn) checkBtn.disabled = true;
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

  // Items already uploaded to the connected notebook (keyed by Zotero item
  // key, so renaming a source inside NotebookLM doesn't affect this)
  const syncedKeys = await getSyncedKeys(collectionId);
  const uploadedCount = items.filter((i) => syncedKeys.has(i.itemKey)).length;

  // Summary line
  const parts = [];
  if (fileItems.length) parts.push(`${fileItems.length} PDF${fileItems.length > 1 ? "s" : ""}`);
  if (urlItems.length)  parts.push(`${urlItems.length} URL${urlItems.length > 1 ? "s" : ""}`);
  let summaryHtml = `<strong>${totalCount} item${totalCount > 1 ? "s" : ""}</strong>: ${parts.join(", ")}`;
  if (uploadedCount > 0) {
    summaryHtml += `<br/><span class="uploaded-summary">&#10003; ${uploadedCount} already in this notebook</span>`;
  }
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
    fileCountEl.textContent = groupCountLabel(fileItems, syncedKeys);
    groupFiles.classList.remove("hidden");
    for (const item of fileItems) {
      filesContainer.appendChild(makeItemRow(item, syncedKeys.has(item.itemKey)));
    }
  } else {
    groupFiles.classList.add("hidden");
  }

  if (urlItems.length) {
    urlCountEl.textContent = groupCountLabel(urlItems, syncedKeys);
    groupUrls.classList.remove("hidden");
    for (const item of urlItems) {
      urlsContainer.appendChild(makeItemRow(item, syncedKeys.has(item.itemKey)));
    }
  } else {
    groupUrls.classList.add("hidden");
  }

  itemList.classList.remove("hidden");
  syncBtn.disabled = false;
  resetBtn.disabled = false;
  // "Check notebook" is useful only when something is marked uploaded.
  if (checkBtn) checkBtn.disabled = uploadedCount === 0;

  // Group select-all checkboxes (disabled when every item is already uploaded).
  // Reset to unchecked on each render so a re-render (e.g. after a sync) doesn't
  // leave them ticked from a previous selection.
  document.getElementById("select-all-files").checked = false;
  document.getElementById("select-all-urls").checked  = false;
  document.getElementById("select-all-files").disabled = !filesContainer.querySelector('input[type="checkbox"]');
  document.getElementById("select-all-urls").disabled  = !urlsContainer.querySelector('input[type="checkbox"]');
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

// Fetches the set of item keys already uploaded to the currently connected
// notebook. The background reconciles against NotebookLM's live sources first,
// so markers for sources the user removed are pruned (making them
// re-uploadable). Empty set when no notebook is open or nothing was synced.
async function getSyncedKeys(collectionId) {
  try {
    const tabRes = await sendMessage({ type: "n2z-get-notebooklm-tab" }, 3000);
    const notebookId = tabRes?.success ? tabRes.data?.notebookId : null;

    // Durable source of truth: the Zotero mapping's per-item record. This is
    // the SAME data the Mappings tab shows, lives in Zotero (survives reopen),
    // and is never altered by reading NotebookLM's DOM. Removed-source
    // detection is a separate, explicit action (the "Check notebook" button).
    const res = await sendMessage({
      type: "n2z-get-synced-items",
      collectionId: parseInt(collectionId),
      notebookId,
    }, 5000);
    if (res?.success && Array.isArray(res.data)) {
      console.log(`[n2z] Uploaded-item markers (from Zotero mapping): ${res.data.length} key(s)`);
      return new Set(res.data);
    }
    return new Set();
  } catch (e) {
    console.warn("[n2z] Could not load uploaded-item markers:", e);
    return new Set();
  }
}

function groupCountLabel(items, syncedKeys) {
  const uploaded = items.filter((i) => syncedKeys.has(i.itemKey)).length;
  return uploaded > 0 ? `(${items.length - uploaded} new · ${uploaded} uploaded)` : `(${items.length})`;
}

function makeItemRow(item, isUploaded = false) {
  const row = document.createElement("label");
  row.className = isUploaded ? "item-row uploaded" : "item-row";
  if (isUploaded) {
    // Already in the notebook: green check instead of a checkbox, not selectable
    const check = document.createElement("span");
    check.className = "item-check";
    check.textContent = "✓";
    row.title = "Already uploaded to this notebook";
    row.appendChild(check);
  } else {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = false; // unchecked by default — user picks what to sync
    cb.dataset.itemKey = item.itemKey;
    row.appendChild(cb);
  }
  const name = document.createElement("span");
  name.className = "item-row-name";
  name.textContent = item.title || item.url || item.itemKey;
  name.title = item.title || item.url || "";
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
    saveSyncSelection();
  });

  importLibSel.addEventListener("change", () => {
    populateCollectionsForLibrary(importLibSel, importColSel);
    saveImportSelection();
  });

  importColSel.addEventListener("change", () => {
    saveImportSelection();
  });

  const syncSelect = document.getElementById("collection-select");
  syncSelect.addEventListener("change", () => {
    previewItems(syncSelect.value);
    saveSyncSelection();
  });

  document
    .getElementById("btn-sync")
    .addEventListener("click", handleForwardSync);

  document
    .getElementById("btn-cancel-sync")
    .addEventListener("click", async () => {
      const cancelBtn = document.getElementById("btn-cancel-sync");
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Cancelling…";
      // tabId is optional; the background cancels the sole active sync if omitted.
      await sendMessage({ type: "n2z-cancel-sync", tabId: window._n2zSyncTabId ?? undefined }, 5000);
    });

  document
    .getElementById("btn-check-notebook")
    .addEventListener("click", async () => {
      const select = document.getElementById("collection-select");
      if (!select.value) return;
      const btn = document.getElementById("btn-check-notebook");
      const resultDiv = document.getElementById("sync-result");
      const tabRes = await sendMessage({ type: "n2z-get-notebooklm-tab" }, 3000);
      const notebookId = tabRes?.success ? tabRes.data?.notebookId : null;
      if (!notebookId) {
        resultDiv.classList.remove("hidden");
        resultDiv.className = "result error";
        resultDiv.textContent = "Open the notebook first, then click Check notebook.";
        return;
      }
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Checking…";
      const before = (await getSyncedKeys(select.value)).size;
      const rec = await sendMessage({
        type: "n2z-reconcile-synced",
        collectionId: parseInt(select.value),
        notebookId,
      }, 15000);
      btn.textContent = orig;
      btn.disabled = false;
      await previewItems(select.value);
      const after = rec?.success && Array.isArray(rec.data) ? rec.data.length : before;
      const removed = Math.max(0, before - after);
      resultDiv.classList.remove("hidden");
      resultDiv.className = "result success";
      resultDiv.textContent = removed > 0
        ? `Cleared ${removed} source${removed > 1 ? "s" : ""} you removed in NotebookLM — ready to re-upload.`
        : "All synced sources are still in the notebook.";
    });

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
      // Uploaded markers are derived from the cleared state — re-render
      await previewItems(select.value);
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

  const cancelBtn = document.getElementById("btn-cancel-sync");
  if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.textContent = "Cancel upload"; }

  let syncTabId = null;
  window._n2zSyncTabId = null;

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
    window._n2zSyncTabId = syncTabId; // let the Cancel button target this sync

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
      progressText.textContent = data.currentTitle || "Uploading files…";
    } else {
      progressText.textContent = "Syncing…";
    }
    renderProgressFiles(data);
  }

  async function finishSync(result) {
    if (window._n2zPollInterval) {
      clearInterval(window._n2zPollInterval);
      window._n2zPollInterval = null;
    }
    progressFill.classList.remove("indeterminate");
    progressFill.style.width = "100%";

    const cancelBtn = document.getElementById("btn-cancel-sync");
    if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.textContent = "Cancel upload"; }
    window._n2zSyncTabId = null;

    resultDiv.classList.remove("hidden");
    if (result && result.cancelled) {
      resultDiv.className = "result";          // neutral, not an error
      resultDiv.textContent = result.message;  // "Sync cancelled — N of M uploaded…"
    } else if (result && result.success) {
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
    const pf = document.getElementById("progress-files");
    if (pf) { pf.classList.add("hidden"); pf.innerHTML = ""; }
    await loadMappings(result?.mapping ? [result.mapping] : []);
    // Re-render so freshly uploaded items show the green check (read from the
    // now-updated Zotero mapping). Also do this on cancel — partial uploads
    // were recorded and should show their checks.
    if (result && (result.success || result.cancelled)) {
      const colSel = document.getElementById("collection-select");
      if (colSel.value) await previewItems(colSel.value);
    }
  }
}

function truncate(str, max) {
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

// Renders the per-batch file list as bullets under the progress bar.
// Shows the list only when the current phase provides file names.
function renderProgressFiles(data) {
  const ul = document.getElementById("progress-files");
  if (!ul) return;
  const files = data.phase === "files" && Array.isArray(data.files) ? data.files : null;
  if (!files || files.length === 0) {
    ul.classList.add("hidden");
    ul.innerHTML = "";
    return;
  }
  ul.innerHTML = "";
  for (const name of files) {
    const li = document.createElement("li");
    li.textContent = name;
    li.title = name; // full name on hover (rows are ellipsized)
    ul.appendChild(li);
  }
  ul.classList.remove("hidden");
}

// Renders the list of notes into the popup and enables import.
function renderNotes(notes, { cached = false } = {}) {
  const container = document.getElementById("notes-container");
  const importBtn = document.getElementById("btn-import");

  container.innerHTML = "";
  for (const note of notes) {
    const item = document.createElement("div");
    item.className = "note-item";

    const preview = stripHtml(note.content || note.html || "").substring(0, 120);
    item.innerHTML = `
      <input type="checkbox" checked data-note-id="${escapeHtml(note.id)}" />
      <div class="note-item-info">
        <div class="note-item-title">${escapeHtml(note.title)}</div>
        <div class="note-item-preview">${escapeHtml(preview || "(no content)")}</div>
      </div>
    `;
    container.appendChild(item);
  }

  const hint = document.getElementById("notes-cache-hint");
  if (hint) {
    hint.textContent = cached
      ? "Showing previously found notes. Click Find Text Notes to refresh."
      : "";
    hint.classList.toggle("hidden", !cached);
  }

  window._extractedNotes = notes;
  importBtn.disabled = notes.length === 0;
}

// On popup open, show cached notes for the current notebook (if any) so the
// user can close/reopen the popup without losing a completed extraction.
async function loadCachedNotes() {
  try {
    const result = await sendMessage({ type: "n2z-get-cached-notes" }, 4000);
    const notes = (result && result.success && result.data) || [];
    if (notes.length === 0) return;
    document.getElementById("found-notes").classList.remove("hidden");
    renderNotes(notes, { cached: true });
  } catch {
    // Non-fatal — user can still click Find Text Notes.
  }
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

    renderNotes(notes, { cached: false });
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
