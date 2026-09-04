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
  setupTagMultiSelect();
  // Seed the import tag picker with the initially-selected library's tags.
  const importLib0 = document.getElementById("import-library-select");
  if (importLib0 && _tagMultiSelect) {
    _tagMultiSelect.reloadForLibrary(parseInt(importLib0.value)).catch(() => {});
  }
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
    { banner: "prereq-banner", btn: "prereq-toggle" },
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
      document.querySelectorAll(".prereq-banner").forEach((b) => {
        isCollapsed
          ? b.classList.add("collapsed")
          : b.classList.remove("collapsed");
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
  if (resumeCancelBtn) {
    resumeCancelBtn.disabled = false;
    resumeCancelBtn.textContent = "Cancel upload";
  }

  const updateUI = (data) => {
    if (data.total > 0) {
      progressFill.classList.remove("indeterminate");
      progressFill.style.width =
        Math.round((data.current / data.total) * 100) + "%";
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
      resultDiv.className = result?.cancelled
        ? "result"
        : result?.success
          ? "result success"
          : "result error";
      resultDiv.textContent =
        result?.message || result?.error || "Sync finished";
      btn.disabled = false;
      progress.classList.add("hidden");
      progressFill.style.width = "0%";
      if (resumeCancelBtn) {
        resumeCancelBtn.disabled = true;
        resumeCancelBtn.textContent = "Cancel upload";
      }
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
      empty.textContent = "No matches";
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

  input.addEventListener("focus", () => {
    input.select();
    openList();
  });
  input.addEventListener("input", () => {
    renderList(input.value);
    list.classList.remove("hidden");
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.blur();
    }
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

// ─── Tag multi-select (To-Zotero import) ─────────────────────────────
//
// A chip-based multi-select for the import "Custom Tags" field. The dropdown
// lists existing tags for the currently-selected import library (reusing
// loadTagsForLibrary), filtered as the user types. Picking a tag adds it as a
// removable chip. When the typed text matches no existing tag, a "+ Create"
// row lets the user add a brand-new tag; new (not-yet-in-library) tags get a
// "+" badge on their chip so they're visually distinct from existing ones.
//
// Exposes on the root element:
//   .getSelectedTags()        → string[] of chosen tag names (order preserved)
//   .reloadForLibrary(libId)  → refresh the available-tag list (keeps chips)
//   .clear()                  → remove all chips
let _tagMultiSelect = null;

function setupTagMultiSelect() {
  const root = document.getElementById("custom-tags");
  if (!root) return;
  const chipsBox = document.getElementById("custom-tags-chips");
  const input = document.getElementById("custom-tags-input");
  const list = root.querySelector(".tag-search-list");

  // Insertion-ordered selection; value = true if the tag is NOT in the library
  // (i.e. a freshly-created tag that gets the "+" badge).
  const selected = new Map();
  // Lowercased set of existing library tag names, for "exists?" checks.
  let available = []; // [{ tag }]
  let availableLower = new Set();

  const norm = (t) => t.trim();

  const renderChips = () => {
    chipsBox.innerHTML = "";
    for (const [tag, isNew] of selected) {
      const chip = document.createElement("span");
      chip.className = "tag-chip" + (isNew ? " is-new" : "");
      const label = document.createElement("span");
      label.className = "tag-chip-label";
      label.textContent = tag;
      chip.appendChild(label);
      if (isNew) {
        const badge = document.createElement("span");
        badge.className = "tag-chip-badge";
        badge.setAttribute("aria-label", "new tag");
        badge.title = "New tag — will be created in Zotero on import";
        chip.appendChild(badge);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "tag-chip-remove";
      remove.textContent = "×";
      remove.title = "Remove tag";
      remove.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selected.delete(tag);
        renderChips();
        renderList(input.value);
      });
      chip.appendChild(remove);
      chipsBox.appendChild(chip);
    }
    chipsBox.classList.toggle("empty", selected.size === 0);
  };

  const addTag = (tag, { isNew } = {}) => {
    const name = norm(tag);
    if (!name) return;
    // Case-insensitive de-dupe against already-selected chips.
    for (const existing of selected.keys()) {
      if (existing.toLowerCase() === name.toLowerCase()) return;
    }
    const fresh =
      isNew != null ? isNew : !availableLower.has(name.toLowerCase());
    selected.set(name, fresh);
    renderChips();
    input.value = "";
  };

  const renderList = (query) => {
    const q = norm(query).toLowerCase();
    list.innerHTML = "";
    let count = 0;

    // "+ Create" row: shown when the query is non-empty and doesn't exactly
    // match an existing tag or an already-selected chip.
    if (q) {
      const exactExisting = availableLower.has(q);
      const exactSelected = [...selected.keys()].some(
        (t) => t.toLowerCase() === q,
      );
      if (!exactExisting && !exactSelected) {
        const row = document.createElement("div");
        row.className = "searchable-option tag-create-option";
        row.innerHTML = `<span class="tag-create-plus" aria-hidden="true"></span> Create "${escapeHtml(
          norm(query),
        )}"`;
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          addTag(query, { isNew: true });
          renderList("");
        });
        list.appendChild(row);
        count++;
      }
    }

    for (const { tag } of available) {
      if (q && !tag.toLowerCase().includes(q)) continue;
      // Skip tags already chosen.
      if ([...selected.keys()].some((t) => t.toLowerCase() === tag.toLowerCase()))
        continue;
      const row = document.createElement("div");
      row.className = "searchable-option";
      row.textContent = tag;
      row.dataset.value = tag;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        addTag(tag, { isNew: false });
        renderList(input.value);
      });
      list.appendChild(row);
      count++;
    }

    if (count === 0) {
      const empty = document.createElement("div");
      empty.className = "searchable-empty";
      empty.textContent = q ? "No matches" : "No tags in this library";
      list.appendChild(empty);
    }
  };

  const openList = () => {
    renderList(input.value);
    list.classList.remove("hidden");
  };
  const closeList = () => list.classList.add("hidden");

  input.addEventListener("focus", openList);
  input.addEventListener("input", () => {
    renderList(input.value);
    list.classList.remove("hidden");
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.blur();
      closeList();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const first = list.querySelector(".searchable-option");
      if (first) first.dispatchEvent(new Event("mousedown"));
      return;
    }
    // Backspace on an empty field removes the last chip (familiar combobox UX).
    if (e.key === "Backspace" && !input.value && selected.size) {
      const lastKey = [...selected.keys()].pop();
      selected.delete(lastKey);
      renderChips();
      renderList("");
    }
  });
  document.addEventListener("mousedown", (e) => {
    if (!root.contains(e.target)) closeList();
  });

  root.getSelectedTags = () => [...selected.keys()];
  root.clear = () => {
    selected.clear();
    renderChips();
  };
  root.reloadForLibrary = async (libraryId) => {
    const tags = await loadTagsForLibrary(libraryId);
    available = Array.isArray(tags) ? tags.filter((t) => t && t.tag) : [];
    availableLower = new Set(available.map((t) => t.tag.toLowerCase()));
    // Existing chips that now match a library tag lose their "new" badge.
    for (const [tag] of selected) {
      if (availableLower.has(tag.toLowerCase())) selected.set(tag, false);
    }
    renderChips();
    if (!list.classList.contains("hidden")) renderList(input.value);
  };

  renderChips();
  _tagMultiSelect = root;
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
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
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
// Cache: { [libraryId]: TagInfo[] }
window._tagsByLibrary = {};
// "collection" | "tag"
window._searchMode = "collection"; // default mode when popup opens

/**
 * Generates a stable synthetic collectionId from a library + tag pair.
 * Real Zotero collectionIds are small positive integers; this offset keeps
 * tag-based mappings from colliding with them while still being usable as a
 * mapping/sync-state key.
 */
function syntheticCollectionIdForTag(libraryId, tag) {
  let hash = 5381;
  const str = String(libraryId) + "|" + String(tag);
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
    hash |= 0;
  }
  return 1000000000 + Math.abs(hash);
}

async function loadTagsForLibrary(libraryId) {
  if (window._tagsByLibrary[libraryId]) {
    console.log(
      `[n2z popup] cached tags for library ${libraryId}:`,
      window._tagsByLibrary[libraryId].length,
    );
    return window._tagsByLibrary[libraryId];
  }
  console.log(`[n2z popup] fetching tags for library ${libraryId}`);
  const result = await sendMessage({ type: "n2z-get-tags", libraryId });
  console.log(`[n2z popup] tags response:`, result);
  const tags = result?.success && Array.isArray(result.data) ? result.data : [];
  window._tagsByLibrary[libraryId] = tags;
  return tags;
}

async function loadLibraries() {
  let result = await sendMessage({ type: "n2z-get-libraries" });

  // Fallback: older plugin version without /n2z/libraries — use the flat collection list
  if (!result.success || !result.data || result.data.length === 0) {
    const fallback = await sendMessage({ type: "n2z-get-collections" });
    if (fallback.success && fallback.data) {
      result = {
        success: true,
        data: [
          {
            libraryId: 0,
            libraryName: "My Library",
            libraryType: "user",
            collections: fallback.data,
          },
        ],
      };
    }
  }

  const syncLibSel = document.getElementById("library-select");
  const importLibSel = document.getElementById("import-library-select");

  if (!result.success || !result.data || result.data.length === 0) {
    const msg = '<option value="">No libraries found</option>';
    syncLibSel.innerHTML = msg;
    importLibSel.innerHTML = msg;
    document.getElementById("collection-select").innerHTML =
      '<option value="">No collections found</option>';
    document.getElementById("import-collection-select").innerHTML =
      '<option value="">No collections found</option>';
    return;
  }

  window._libraryTree = result.data;

  for (const [libSel, colSel] of [
    [syncLibSel, document.getElementById("collection-select")],
    [importLibSel, document.getElementById("import-collection-select")],
  ]) {
    libSel.innerHTML = "";
    for (const lib of result.data) {
      const opt = document.createElement("option");
      opt.value = lib.libraryId;
      opt.textContent =
        lib.libraryType === "group"
          ? `Group: ${lib.libraryName}`
          : lib.libraryName;
      opt.dataset.libraryName = lib.libraryName;
      opt.dataset.libraryType = lib.libraryType;
      libSel.appendChild(opt);
    }
    // Populate collections for the initially-selected library
    populateCollectionsForLibrary(libSel, colSel);
  }

  // Pre-load tags for every library so the tag picker can switch quickly.
  for (const lib of result.data) {
    loadTagsForLibrary(lib.libraryId).catch(() => {});
  }
}

// Persist the chosen sync (To NotebookLM) library + collection/tag so reopening
// the popup restores it.
async function saveSyncSelection() {
  const libraryId = document.getElementById("library-select").value || "";
  const targetValue = document.getElementById("collection-select").value || "";
  const payload = { libraryId, mode: window._searchMode };
  if (window._searchMode === "tag") {
    payload.tag = targetValue;
  } else {
    payload.collectionId = targetValue;
  }
  await chrome.storage.local.set({ lastSyncSelection: payload });
}

// Persist the import (To Zotero) target separately. We record that the user
// explicitly picked it so we stop auto-mirroring the sync selection into it.
async function saveImportSelection() {
  const libraryId =
    document.getElementById("import-library-select").value || "";
  const collectionId =
    document.getElementById("import-collection-select").value || "";
  await chrome.storage.local.set({
    lastImportSelection: { libraryId, collectionId, userSet: true },
  });
}

// Applies a sync-mode selection (library + collection or tag) and refreshes
// the searchable input. Returns true if the target value was applied.
async function applySyncSelection(libraryId, collectionId, tag, mode) {
  const libSel = document.getElementById("library-select");
  const colSel = document.getElementById("collection-select");

  if (
    libraryId &&
    [...libSel.options].some((o) => o.value === String(libraryId))
  ) {
    libSel.value = String(libraryId);
  }

  const resolvedMode = mode === "tag" ? "tag" : "collection";
  await setSearchMode(resolvedMode, { skipSideEffects: true });

  const value = resolvedMode === "tag" ? tag : collectionId;
  let applied = false;
  if (value && [...colSel.options].some((o) => o.value === String(value))) {
    colSel.value = String(value);
    applied = true;
  }
  const wrap = document.querySelector(
    `.searchable-select[data-for="collection-select"]`,
  );
  if (wrap && wrap._refresh) {
    wrap._refresh();
    // Make sure the searchable input shows the restored value, not the
    // placeholder or the previous mode's selection.
    const input = wrap.querySelector(".searchable-input");
    if (input && applied) {
      const opt = colSel.options[colSel.selectedIndex];
      input.value = opt && opt.value ? opt.textContent.trim() : "";
    }
  }
  return applied;
}

// Applies a (libraryId, collectionId) to a library/collection select pair and
// refreshes its searchable-input. Returns true if the collection was applied.
function applySelection(libSelId, colSelId, libraryId, collectionId) {
  const libSel = document.getElementById(libSelId);
  const colSel = document.getElementById(colSelId);
  if (
    libraryId &&
    [...libSel.options].some((o) => o.value === String(libraryId))
  ) {
    libSel.value = String(libraryId);
    populateCollectionsForLibrary(libSel, colSel);
  }
  let applied = false;
  if (
    collectionId &&
    [...colSel.options].some((o) => o.value === String(collectionId))
  ) {
    colSel.value = String(collectionId);
    applied = true;
  }
  const wrap = document.querySelector(
    `.searchable-select[data-for="${colSelId}"]`,
  );
  if (wrap && wrap._refresh) wrap._refresh();
  return applied;
}

// Restore the previously chosen sync library + collection/tag (if still present),
// render its item preview, and seed the import (To Zotero) tab with the same
// collection as a placeholder — unless the user has set their own import
// target, which is restored instead.
async function restoreSyncSelection() {
  const { lastSyncSelection, lastImportSelection } =
    await chrome.storage.local.get([
      "lastSyncSelection",
      "lastImportSelection",
    ]);

  const sync = lastSyncSelection || {};
  if (sync.libraryId || sync.collectionId || sync.tag) {
    const applied = await applySyncSelection(
      sync.libraryId,
      sync.collectionId,
      sync.tag,
      sync.mode,
    );
    if (applied) {
      const source =
        sync.mode === "tag" && sync.tag
          ? { libraryId: parseInt(sync.libraryId), tag: sync.tag }
          : { collectionId: parseInt(sync.collectionId) };
      await previewItems(source);
    }
  }

  // Import target: the user's own choice wins; otherwise mirror the sync
  // source as a convenient default (they can still change it).
  const importSource =
    lastImportSelection && lastImportSelection.userSet
      ? lastImportSelection
      : sync;
  applySelection(
    "import-library-select",
    "import-collection-select",
    importSource.libraryId,
    importSource.collectionId,
  );
}

function populateCollectionsForLibrary(libSelect, colSelect) {
  const libraryId = parseInt(libSelect.value);
  const lib = window._libraryTree.find((l) => l.libraryId === libraryId);
  colSelect.innerHTML = '<option value="">Select a collection...</option>';
  if (lib) populateCollectionOptions(colSelect, lib.collections, 0);
  // Reset the matching searchable-select input to reflect the cleared selection.
  const wrap = document.querySelector(
    `.searchable-select[data-for="${colSelect.id}"]`,
  );
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

async function populateTagsForLibrary(libSelect, tagSelect) {
  const libraryId = parseInt(libSelect.value);
  tagSelect.innerHTML = '<option value="">Select a tag...</option>';
  const tags = await loadTagsForLibrary(libraryId);
  console.log(
    `[n2z popup] populating ${tags.length} tag(s) for library ${libraryId}`,
  );
  for (const tag of tags) {
    const option = document.createElement("option");
    option.value = tag.tag;
    option.textContent = tag.tag;
    option.dataset.name = tag.tag;
    tagSelect.appendChild(option);
  }
  const wrap = document.querySelector(
    `.searchable-select[data-for="${tagSelect.id}"]`,
  );
  if (wrap && wrap._refresh) wrap._refresh();
  // If the dropdown is already open, re-render it so the freshly-loaded tags
  // appear without the user having to blur and refocus.
  const list = wrap?.querySelector(".searchable-list");
  if (list && !list.classList.contains("hidden")) {
    const input = wrap.querySelector(".searchable-input");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function updateSyncTargetLabel() {
  const label = document.getElementById("sync-target-label");
  if (!label) return;
  label.textContent =
    window._searchMode === "tag" ? "Zotero Tag" : "Zotero Collection";
}

async function setSearchMode(mode, { skipSideEffects = false } = {}) {
  window._searchMode = mode === "tag" ? "tag" : "collection";
  document.querySelectorAll(".mode-option").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === window._searchMode);
  });
  updateSyncTargetLabel();

  const syncLibSel = document.getElementById("library-select");
  const targetSel = document.getElementById("collection-select");
  const targetInput = document.querySelector(
    '.searchable-select[data-for="collection-select"] .searchable-input',
  );
  if (targetInput) {
    targetInput.placeholder =
      window._searchMode === "tag"
        ? "Select a tag..."
        : "Select a collection...";
  }
  targetSel.value = "";

  if (window._searchMode === "tag") {
    await populateTagsForLibrary(syncLibSel, targetSel);
  } else {
    populateCollectionsForLibrary(syncLibSel, targetSel);
  }

  if (!skipSideEffects) {
    // Reset preview and sync button because the selection was cleared.
    previewItems(null);
    saveSyncSelection();
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
// Remembers the user's tick state across re-renders AND popup close/reopen
// (the popup dies when the user clicks into NotebookLM to manage sources, so
// in-memory state is lost exactly when it matters). Keyed by sync source;
// stored in chrome.storage.local. Null/unset = render defaults (main ON,
// extras OFF) until the user interacts.
window._userSelection = null;
window._selectionSourceKey = null;

// Re-reads the rendered checkboxes into the preserved-selection set and
// persists it for the next popup open.
function recordSelection() {
  window._userSelection = new Set(getSelectedUnits());
  if (window._selectionSourceKey) {
    savePreservedSelection(window._selectionSourceKey, [...window._userSelection]);
  }
}

const SELECTION_KEEP = 10; // remembered sources (newest win)

async function loadPreservedSelection(sourceKey) {
  try {
    const { selectionState } = await chrome.storage.local.get("selectionState");
    const units = selectionState?.[sourceKey]?.units;
    return Array.isArray(units) ? new Set(units) : null;
  } catch {
    return null;
  }
}

async function savePreservedSelection(sourceKey, units) {
  try {
    const { selectionState } = await chrome.storage.local.get("selectionState");
    const next = { ...(selectionState || {}) };
    next[sourceKey] = { units, at: Date.now() };
    // Keep only the newest entries so storage can't grow unbounded.
    const keep = Object.entries(next)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, SELECTION_KEEP);
    await chrome.storage.local.set({
      selectionState: Object.fromEntries(keep),
    });
  } catch {
    /* non-fatal */
  }
}

// Desired checkbox state for a unit: the user's preserved selection when one
// exists, else the defaults (main ON, extras OFF).
function preservedChecked(item, unit) {
  const sel = window._userSelection;
  if (sel) return sel.has(`${item.itemKey}::${unit.unitId}`);
  return !!unit.isDefault;
}

/**
 * Previews items for a sync source.
 * @param {null|{collectionId:number}|{libraryId:number,tag:string}} source
 */
// Resizable groups: each group (PDFs / Web URLs) has a drag handle under its
// rows; dragging gives the rows a fixed, internally scrollable height (80px
// min; max = nearly the full popup height), persisted per group in
// chrome.storage.local. Double-click resets.
const GROUP_ROWS_MIN_H = 80;

function clampGroupHeight(h) {
  // Normal popups AUTO-SIZE to their content, so innerHeight grows with the
  // drag — using it as the max would chase the fold and always stop at the
  // same visible size. Popups are hard-capped at ~600px by Chrome: fixed
  // 510px budget. The pinned window is a real resizable window — its live
  // height is the true budget and follows the user's resize.
  const isPinned = new URLSearchParams(location.search).has("pinned");
  const max = isPinned
    ? Math.max(240, Math.round(window.innerHeight - 90))
    : 510;
  return Math.min(max, Math.max(GROUP_ROWS_MIN_H, Math.round(h)));
}

function groupRowsEl(key) {
  return document.getElementById(key === "files" ? "files-container" : "urls-container");
}

function applyGroupHeights() {
  chrome.storage.local
    .get("groupHeights")
    .then(({ groupHeights }) => {
      if (!groupHeights) return;
      for (const key of ["files", "urls"]) {
        const h = groupHeights[key];
        const rows = groupRowsEl(key);
        if (!rows || !h) continue;
        rows.style.height = `${h}px`;
        rows.closest(".item-group")?.classList.add("resized");
      }
    })
    .catch(() => {});
}

async function saveGroupHeight(key, h) {
  try {
    const { groupHeights } = await chrome.storage.local.get("groupHeights");
    await chrome.storage.local.set({
      groupHeights: { ...(groupHeights || {}), [key]: h },
    });
  } catch {
    /* non-fatal */
  }
}

// Collapsible PDFs / Web URLs groups. State persists in chrome.storage.local
// so a collapsed group stays collapsed across re-renders and popup reopen.
async function applyGroupCollapse() {
  try {
    const { groupCollapsed } = await chrome.storage.local.get("groupCollapsed");
    for (const [key, groupId] of [
      ["files", "group-files"],
      ["urls", "group-urls"],
    ]) {
      const group = document.getElementById(groupId);
      if (!group) continue;
      const collapsed = !!(groupCollapsed && groupCollapsed[key]);
      group.classList.toggle("collapsed", collapsed);
      group
        .querySelector(".item-group-chevron")
        ?.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
  } catch {
    /* non-fatal */
  }
}

async function previewItems(source) {
  const preview = document.getElementById("item-preview");
  const summary = document.getElementById("item-summary");
  const itemList = document.getElementById("item-list");
  const syncBtn = document.getElementById("btn-sync");
  const resetBtn = document.getElementById("btn-reset-sync");
  const checkBtn = document.getElementById("btn-check-notebook");

  window._previewItems = [];

  if (!source) {
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

  const listMessage = source.tag
    ? { type: "n2z-get-items", libraryId: source.libraryId, tag: source.tag }
    : { type: "n2z-get-items", collectionId: source.collectionId };
  const result = await sendMessage(listMessage);

  if (!result.success || !result.data) {
    summary.innerHTML = '<span class="warn">Could not load items</span>';
    syncBtn.disabled = true;
    return;
  }

  const items = result.data;
  window._previewItems = items;

  // Selection persistence: same source as the previous render → snapshot
  // whatever the user last left on screen; a different collection/tag loads
  // its remembered selection from storage (survives popup close/reopen) or
  // starts fresh with the defaults.
  const sourceKey = source.tag
    ? `tag:${source.libraryId}:${source.tag}`
    : `col:${source.collectionId}`;
  if (window._selectionSourceKey !== sourceKey) {
    window._selectionSourceKey = sourceKey;
    window._userSelection = await loadPreservedSelection(sourceKey);
  } else {
    window._userSelection = new Set(getSelectedUnits());
    savePreservedSelection(sourceKey, [...window._userSelection]);
  }

  const fileItems = items.filter((i) => i.exportType === "file");
  const urlItems = items.filter((i) => i.exportType === "url");
  const totalCount = items.length;

  if (totalCount === 0) {
    summary.innerHTML =
      '<span class="warn">No exportable items (no PDFs, URLs, or DOIs found)</span>';
    syncBtn.disabled = true;
    return;
  }

  // Items already uploaded to the connected notebook (keyed by Zotero item
  // key or per-attachment unit key, so renaming a source inside NotebookLM
  // doesn't affect this)
  const mappingKey = source.tag
    ? syntheticCollectionIdForTag(source.libraryId, source.tag)
    : source.collectionId;
  const syncedMarkers = await getSyncedMarkers(mappingKey);
  const uploadedCount = items.filter((i) => itemGroupUploaded(i, syncedMarkers))
    .length;
  const multiCount = items.filter((i) => ensureUnits(i).length > 1).length;

  // Summary line
  const parts = [];
  if (fileItems.length)
    parts.push(`${fileItems.length} PDF${fileItems.length > 1 ? "s" : ""}`);
  if (urlItems.length)
    parts.push(`${urlItems.length} URL${urlItems.length > 1 ? "s" : ""}`);
  let summaryHtml = `<strong>${totalCount} item${totalCount > 1 ? "s" : ""}</strong>: ${parts.join(", ")}`;
  if (multiCount > 0) {
    summaryHtml += ` <span class="multi-summary">· ${multiCount} with multiple attachments (expand ▸)</span>`;
  }
  if (uploadedCount > 0) {
    summaryHtml += `<br/><span class="uploaded-summary">&#10003; ${uploadedCount} already in this notebook</span>`;
  }
  if (totalCount > 50) {
    summaryHtml += `<br/><span class="warn">&#9888; ${totalCount} items — NotebookLM free tier supports max 50 sources</span>`;
  }
  summary.innerHTML = summaryHtml;

  // Render file group
  const filesContainer = document.getElementById("files-container");
  const urlsContainer = document.getElementById("urls-container");
  const fileCountEl = document.getElementById("file-count");
  const urlCountEl = document.getElementById("url-count");
  const groupFiles = document.getElementById("group-files");
  const groupUrls = document.getElementById("group-urls");

  filesContainer.innerHTML = "";
  urlsContainer.innerHTML = "";

  if (fileItems.length) {
    fileCountEl.textContent = groupCountLabel(fileItems, syncedMarkers);
    groupFiles.classList.remove("hidden");
    for (const item of fileItems) {
      filesContainer.appendChild(makeItemBlock(item, syncedMarkers));
    }
  } else {
    groupFiles.classList.add("hidden");
  }

  if (urlItems.length) {
    urlCountEl.textContent = groupCountLabel(urlItems, syncedMarkers);
    groupUrls.classList.remove("hidden");
    for (const item of urlItems) {
      urlsContainer.appendChild(makeItemBlock(item, syncedMarkers));
    }
  } else {
    groupUrls.classList.add("hidden");
  }

  itemList.classList.remove("hidden");
  syncBtn.disabled = false;
  resetBtn.disabled = false;
  // Re-apply persisted collapse + heights so both survive re-renders
  // (selection inside hidden groups is still submitted).
  await applyGroupCollapse();
  applyGroupHeights();
  // "Check notebook" is useful only when something is marked uploaded.
  if (checkBtn) checkBtn.disabled = uploadedCount === 0;

  // Group select-all checkboxes (default/main attachments only — never the
  // per-attachment sub-checkboxes; disabled when every item is already
  // uploaded). Their state mirrors the parent checkboxes: mains start
  // ticked by default, so select-all starts ticked too.
  // Group select-all checkboxes toggle the MAIN attachments only (never the
  // per-attachment extras). The main's checkbox exists in TWO places — the
  // item row and the expanded "Main ·" row — both carry data-default="1" and
  // are kept in sync, so one selector covers both. Disabled when every item
  // is already uploaded.
  const filesParents = filesContainer.querySelectorAll(
    'input[data-default="1"]',
  );
  const urlsParents = urlsContainer.querySelectorAll('input[data-default="1"]');
  document.getElementById("select-all-files").checked =
    filesParents.length > 0 && [...filesParents].every((cb) => cb.checked);
  document.getElementById("select-all-urls").checked =
    urlsParents.length > 0 && [...urlsParents].every((cb) => cb.checked);
  document.getElementById("select-all-files").disabled = filesParents.length === 0;
  document.getElementById("select-all-urls").disabled = urlsParents.length === 0;
  document.getElementById("select-all-files").onchange = (e) => {
    filesContainer
      .querySelectorAll('input[data-default="1"]')
      .forEach((cb) => (cb.checked = e.target.checked));
    recordSelection();
    updateSyncButtonState();
  };
  document.getElementById("select-all-urls").onchange = (e) => {
    urlsContainer
      .querySelectorAll('input[data-default="1"]')
      .forEach((cb) => (cb.checked = e.target.checked));
    recordSelection();
    updateSyncButtonState();
  };

  // Update sync button + the "+N" chips when any unit (parent or sub) toggled.
  // Scope carefully: the group select-all checkboxes also live inside
  // #item-list — a bare input[type=checkbox] selector would clobber their
  // handlers right above (that's how "select all" once stopped selecting).
  itemList
    .querySelectorAll(
      '.item-row-main input[type="checkbox"], .item-subrow input[type="checkbox"]',
    )
    .forEach((cb) => {
      cb.onchange = () => {
        // The main attachment has TWO checkboxes (item row + expanded "Main"
        // row) — keep them in sync so either can be unticked.
        if (cb.dataset.default === "1") {
          const block = cb.closest(".item-block");
          block
            ?.querySelectorAll('input[data-default="1"]')
            .forEach((sib) => {
              if (sib !== cb) sib.checked = cb.checked;
            });
        }
        recordSelection();
        refreshExtraChips(filesContainer);
        refreshExtraChips(urlsContainer);
        updateSyncButtonState();
      };
    });
  updateSyncButtonState();
}

// Fetches the per-unit upload markers for items already uploaded to the
// currently connected notebook: Map(unitKey → marker). A marker carries the
// uploaded source name ({at, name, label, ...}) — or a legacy bare timestamp
// for pre-name-capture syncs. The background reads the Zotero mapping, the
// durable source of truth (lives in Zotero, survives popup reopen, never
// altered by reading NotebookLM's DOM). Removed-source detection is the
// separate, explicit "Check notebook" action.
async function getSyncedMarkers(collectionId) {
  try {
    const tabRes = await sendMessage({ type: "n2z-get-notebooklm-tab" }, 3000);
    const notebookId = tabRes?.success ? tabRes.data?.notebookId : null;

    const res = await sendMessage(
      {
        type: "n2z-get-synced-items",
        collectionId: parseInt(collectionId),
        notebookId,
      },
      5000,
    );
    if (res?.success && res.data && typeof res.data === "object") {
      const markers = new Map(Object.entries(res.data));
      console.log(
        `[n2z] Uploaded markers (from Zotero mapping): ${markers.size} unit(s)`,
      );
      return markers;
    }
    return new Map();
  } catch (e) {
    console.warn("[n2z] Could not load uploaded-item markers:", e);
    return new Map();
  }
}

function groupCountLabel(items, markers) {
  const uploaded = items.filter((i) => itemGroupUploaded(i, markers)).length;
  return uploaded > 0
    ? `(${items.length - uploaded} new · ${uploaded} uploaded)`
    : `(${items.length})`;
}

// Result text for "Check notebook". A blocked check must say WHY it was
// blocked — "all sources still in the notebook" would be a lie when the
// read was busy/unreadable/partial and the user just deleted a source.
// Cleared sources render as a bulleted list (built via DOM — names come
// from NotebookLM labels and must not be injected as HTML).
function renderCheckNotebookResult(rec, clearedKeys, clearedNames) {
  const resultDiv = document.getElementById("sync-result");
  resultDiv.classList.remove("hidden");
  resultDiv.className = "result success";
  resultDiv.textContent = "";

  const note = rec?.note;
  if (note) {
    resultDiv.textContent = checkNotebookMessage(rec, clearedKeys, clearedNames);
    return;
  }
  if (clearedKeys.length === 0) {
    resultDiv.textContent = "All synced sources are still in the notebook.";
    return;
  }

  const head = document.createElement("div");
  head.textContent = `Cleared ${clearedKeys.length} source${clearedKeys.length > 1 ? "s" : ""} you removed in NotebookLM — tick what you want to re-upload:`;
  head.className = "check-result-head";
  resultDiv.appendChild(head);

  const ul = document.createElement("ul");
  ul.className = "check-cleared-list";
  for (const name of clearedNames) {
    const li = document.createElement("li");
    li.textContent = name;
    li.title = name; // full name on hover (rows wrap but stay untruncated-safe)
    ul.appendChild(li);
  }
  resultDiv.appendChild(ul);
}

function checkNotebookMessage(rec, clearedKeys, clearedNames) {
  switch (rec?.note) {
    case "unreadable":
      return "Could not read the notebook's source list. Make sure the Sources panel is open, then try again.";
    case "partial":
      return "Only part of the source list was readable (some rows not loaded) — nothing was cleared. Scroll the sources list in NotebookLM and try again.";
    case "mapping":
      return "Could not update the sync record in Zotero — nothing was cleared. Is Zotero running?";
  }
  return "All synced sources are still in the notebook.";
}

// ─── Attachment units ─────────────────────────────────────────────────

// Normalizes an item (new plugin with `units`, or legacy shape) to a unit
// list. Must stay in sync with background.js's ensureUnits.
function ensureUnits(item) {
  if (Array.isArray(item.units) && item.units.length > 0) return item.units;
  return item.exportType === "file"
    ? [
        {
          unitId: "att-" + item.attachmentId,
          kind: "file",
          attachmentId: item.attachmentId,
          title: item.attachmentTitle || item.title,
          contentType: item.contentType,
          filename: item.filename,
          fileSize: item.fileSize,
          isDefault: true,
        },
      ]
    : [
        {
          unitId: "item-url",
          kind: "url",
          attachmentId: 0,
          title: item.title || item.url,
          contentType: "text/url",
          filename: "",
          fileSize: 0,
          url: item.url,
          isDefault: true,
        },
      ];
}

// Canonical marker/selection key for one unit. The default unit keeps the
// bare itemKey (byte-identical to the historical per-item markers).
function unitKeyOf(item, unit) {
  return unit.isDefault ? item.itemKey : item.itemKey + "::" + unit.unitId;
}

// An item counts as uploaded when ANY of its units has an upload marker —
// a synced main PDF still leaves its supplementary attachments uploadable.
function itemGroupUploaded(item, markers) {
  return resolveUploadedUnits(item, markers).size > 0;
}

// Resolves WHICH units of an item carry upload markers → Map(unit → marker).
// The default unit's marker key is the BARE itemKey — the same key form
// NZBridge ≤ 0.4 wrote for whichever attachment it actually uploaded. So a
// bare marker is attributed by NAME: the unit whose filename matches the
// marker's recorded upload name gets the ✓ (a v0.4-era DOCX upload shows its
// ✓ on the DOCX row instead of pretending the main PDF is up, and the main
// stays selectable). No name match, or a legacy bare-timestamp marker (no
// name): the default keeps the ✓ (old display) and its tooltip shows what
// was really uploaded. Per-unit "itemKey::unitId" markers are unambiguous.
function resolveUploadedUnits(item, markers) {
  const units = ensureUnits(item);
  const uploaded = new Map();
  for (const u of units) {
    if (u.isDefault) continue; // bare-itemKey marker — resolved by name below
    const k = unitKeyOf(item, u);
    if (markers.has(k)) uploaded.set(u, markers.get(k));
  }
  const defaultUnit = units.find((u) => u.isDefault) || units[0];
  const bare = markers.get(item.itemKey);
  if (bare && typeof bare === "object") {
    const want = String(bare.name || bare.label || "").trim();
    const hit = want
      ? units.find(
          (u) => !uploaded.has(u) && String(u.filename || "").trim() === want,
        )
      : null;
    uploaded.set(hit || defaultUnit, bare);
  } else if (bare) {
    uploaded.set(defaultUnit, bare); // legacy bare timestamp — can't tell which file
  }
  return uploaded;
}

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url || "";
  }
}

function fmtSize(bytes) {
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " B";
}

/**
 * Builds one item block: the row (checkbox = the MAIN attachment, ticked by
 * default so "Sync" does what a glance suggests — untick the row to upload
 * only specific extras) plus, for multi-attachment items, a chevron that
 * reveals the other attachments with their own checkboxes.
 */
function makeItemBlock(item, markers) {
  const units = ensureUnits(item);
  const defaultUnit = units.find((u) => u.isDefault) || units[0];
  const extras = units.filter((u) => u !== defaultUnit);
  const uploaded = resolveUploadedUnits(item, markers);
  const defaultUploaded = uploaded.has(defaultUnit);
  // Tooltip for ✓ rows: shows WHICH file is in the notebook (so a legacy
  // wrong-file marker, e.g. a v0.4 DOCX upload under the item's key, is
  // visible instead of silently pretending the main PDF is up) and HOW to
  // replace it — the exact flow that used to dead-end with no way to force
  // a re-upload.
  const uploadedLabel = (m) => {
    const name =
      m && typeof m === "object" && (m.name || m.label)
        ? ` — source name: ${m.label || m.name}`
        : "";
    return `Already uploaded${name}. To replace or remove it: delete the source in NotebookLM, then click Check notebook.`;
  };
  // Full name of the main attachment for hover tooltips. The row label shows
  // the ITEM title; long titles otherwise hide which FILE is the main one.
  const mainAttName =
    defaultUnit.kind === "file"
      ? defaultUnit.filename || defaultUnit.title
      : defaultUnit.url || defaultUnit.title;

  const block = document.createElement("div");
  block.className = "item-block";

  // Expansion container, declared here so the toggle handler can reach it
  const subrows = document.createElement("div");
  subrows.className = "item-subrows";

  // ── Row: the label part toggles the DEFAULT unit (main attachment) ──
  const row = document.createElement("div");
  row.className = defaultUploaded ? "item-row uploaded" : "item-row";
  if (units.length > 1) row.classList.add("has-attachments");

  const main = document.createElement("label");
  main.className = "item-row-main";
  if (defaultUploaded) {
    const check = document.createElement("span");
    check.className = "item-check";
    check.textContent = "✓";
    main.title = uploadedLabel(uploaded.get(defaultUnit));
    main.appendChild(check);
  } else {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    // Ticked by default (main = the usual thing to sync) — unless the user
    // has already shaped a selection for this source, which is preserved.
    cb.checked = preservedChecked(item, defaultUnit);
    cb.dataset.itemKey = item.itemKey;
    cb.dataset.unitId = defaultUnit.unitId;
    cb.dataset.default = "1"; // parent checkbox IS the default unit
    main.appendChild(cb);
  }
  const name = document.createElement("span");
  name.className = "item-row-name";
  name.textContent = item.title || item.url || item.itemKey;
  name.title = `${item.title || item.url || ""}\nMain attachment: ${mainAttName}`;
  main.appendChild(name);
  row.appendChild(main);

  if (units.length > 1) {
    // One real button for the whole "+N ▸" cluster — bigger, hover-highlighted
    // target that cannot be confused with the row's checkbox toggle.
    const extrasLabel =
      extras.length > 1 ? "s" : "";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "item-attachments";
    toggle.title = `Show ${extras.length} more attachment${extrasLabel}`;

    const chip = document.createElement("span");
    chip.className = "item-extra-count";
    chip.textContent = "+" + extras.length;
    toggle.appendChild(chip);

    const chevron = document.createElement("span");
    chevron.className = "item-expander";
    chevron.textContent = "▸";
    chevron.setAttribute("aria-hidden", "true");
    toggle.appendChild(chevron);

    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = subrows.classList.toggle("open");
      toggle.classList.toggle("open", open);
      toggle.title = open
        ? "Hide attachments"
        : `Show ${extras.length} more attachment${extrasLabel}`;
    });
    row.appendChild(toggle);
  }
  block.appendChild(row);

  // ── Expansion: the MAIN attachment as a real checkbox row (pre-ticked,
  // same control as the row checkbox above — untick either) + one row per
  // extra. Every attachment is now visible AND individually de-selectable
  // in the list, as the issue requested.
  if (units.length > 1) {
    const mainRow = document.createElement("label");
    mainRow.className =
      "item-subrow item-main-row" + (defaultUploaded ? " uploaded" : "");
    if (defaultUploaded) {
      const check = document.createElement("span");
      check.className = "item-check";
      check.textContent = "✓";
      mainRow.title = uploadedLabel(uploaded.get(defaultUnit));
      mainRow.appendChild(check);
    } else {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = preservedChecked(item, defaultUnit); // ON by default, like the row checkbox
      cb.dataset.itemKey = item.itemKey;
      cb.dataset.unitId = defaultUnit.unitId;
      cb.dataset.default = "1"; // same unit as the row checkbox
      mainRow.appendChild(cb);
    }
    const mainName = document.createElement("span");
    mainName.className = "item-subrow-name";
    mainName.textContent = `Main · ${
      defaultUnit.kind === "file"
        ? defaultUnit.filename || defaultUnit.title
        : domainOf(defaultUnit.url)
    }`;
    mainName.title =
      `Main attachment: ${mainAttName}\n` +
      "The attachment Zotero opens for this item — untick this (or the row checkbox above) to skip it and pick only the extra attachments.";
    mainRow.appendChild(mainName);
    if (defaultUnit.kind === "file" ? defaultUnit.fileSize : defaultUnit.url) {
      const meta = document.createElement("span");
      meta.className = "item-subrow-meta";
      meta.textContent =
        defaultUnit.kind === "file"
          ? fmtSize(defaultUnit.fileSize)
          : "Link · " + domainOf(defaultUnit.url);
      mainRow.appendChild(meta);
    }
    subrows.appendChild(mainRow);

    for (const unit of extras) {
      const unitUploaded = uploaded.has(unit);
      const sub = document.createElement("label");
      sub.className = unitUploaded ? "item-subrow uploaded" : "item-subrow";
      if (unitUploaded) {
        const check = document.createElement("span");
        check.className = "item-check";
        check.textContent = "✓";
        sub.title = uploadedLabel(uploaded.get(unit));
        sub.appendChild(check);
      } else {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = preservedChecked(item, unit);
        cb.dataset.itemKey = item.itemKey;
        cb.dataset.unitId = unit.unitId;
        sub.appendChild(cb);
      }
      const label = document.createElement("span");
      label.className = "item-subrow-name";
      label.textContent =
        unit.kind === "file"
          ? unit.filename || unit.title
          : unit.title || domainOf(unit.url);
      label.title = unit.kind === "file" ? unit.filename : unit.url || "";
      sub.appendChild(label);
      if (unit.kind === "file" ? unit.fileSize : unit.url) {
        const meta = document.createElement("span");
        meta.className = "item-subrow-meta";
        meta.textContent =
          unit.kind === "file"
            ? fmtSize(unit.fileSize)
            : "Link · " + domainOf(unit.url);
        sub.appendChild(meta);
      }
      subrows.appendChild(sub);
    }
    block.appendChild(subrows);
  }

  return block;
}

// Lights up the "+N" chip of any block whose EXTRA attachments are ticked
// (the Main row's checkbox doesn't count — it mirrors the row checkbox).
function refreshExtraChips(container) {
  container.querySelectorAll(".item-block").forEach((block) => {
    const chip = block.querySelector(".item-extra-count");
    if (!chip) return;
    const any =
      block.querySelectorAll(
        ".item-subrows input[type='checkbox']:not([data-default='1']):checked",
      ).length > 0;
    chip.classList.toggle("active", any);
  });
}

// Checked parent checkboxes → item keys (legacy compat field).
function getSelectedItemKeys() {
  return Array.from(
    document.querySelectorAll(
      '#item-list .item-row-main > input[type="checkbox"]:checked',
    ),
  ).map((cb) => cb.dataset.itemKey);
}

// Every checked checkbox (parent or sub-row) → EXPLICIT unit keys
// ("itemKey::unitId"), pinning the exact attachment resolved at RENDER time.
// The old bare-itemKey form for the default unit let the background re-derive
// "the default" from a fresh item list at sync time — Zotero's best
// attachment can settle differently in between (freshly added items), which
// made a "main" tick upload a different file than the UI showed as Main.
// Scoped to .item-block so the group select-all checkboxes (no dataset)
// can't leak garbage keys.
function getSelectedUnits() {
  return Array.from(
    document.querySelectorAll(
      '#item-list .item-block input[type="checkbox"]:checked',
    ),
  ).map((cb) => `${cb.dataset.itemKey}::${cb.dataset.unitId}`);
}

function updateSyncButtonState() {
  const anySelected = getSelectedUnits().length > 0;
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

    const libraryBadge =
      mapping.libraryName && mapping.libraryName !== "My Library"
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
  // Collapsible PDFs / Web URLs groups (persisted in chrome.storage.local)
  document.querySelectorAll(".item-group-chevron").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = btn.dataset.group;
      const group = document.getElementById(
        key === "files" ? "group-files" : "group-urls",
      );
      if (!group) return;
      const collapsed = group.classList.toggle("collapsed");
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      try {
        const { groupCollapsed } = await chrome.storage.local.get(
          "groupCollapsed",
        );
        await chrome.storage.local.set({
          groupCollapsed: { ...(groupCollapsed || {}), [key]: collapsed },
        });
      } catch {
        /* non-fatal */
      }
    });
  });

  // Resizable groups (drag each group's handle; persisted per group)
  document.querySelectorAll(".item-group-resize").forEach((handle) => {
    const key = handle.dataset.group;
    const rowsEl = groupRowsEl(key);
    const groupEl = handle.closest(".item-group");
    if (!rowsEl || !groupEl) return;
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.classList.add("dragging");
      // pageY (document coords), not clientY — growing the group scrolls the
      // popup body, which must not fight the drag math.
      const startY = e.pageY;
      const startH = rowsEl.getBoundingClientRect().height || 200;
      const onMove = (ev) => {
        groupEl.classList.add("resized");
        rowsEl.style.height = `${clampGroupHeight(
          startH + (ev.pageY - startY),
        )}px`;
        // As the group grows past the visible area, scroll the popup so the
        // handle stays under the cursor and the drag feels continuous.
        const edge = window.innerHeight - 12;
        if (ev.clientY > edge) window.scrollBy(0, ev.clientY - edge);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        handle.classList.remove("dragging");
        const h = clampGroupHeight(parseFloat(rowsEl.style.height) || startH);
        rowsEl.style.height = `${h}px`;
        saveGroupHeight(key, h);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
    });
    handle.addEventListener("dblclick", async () => {
      groupEl.classList.remove("resized");
      rowsEl.style.height = "";
      try {
        const { groupHeights } = await chrome.storage.local.get("groupHeights");
        if (groupHeights) {
          const next = { ...groupHeights };
          delete next[key];
          await chrome.storage.local.set({ groupHeights: next });
        }
      } catch {
        /* non-fatal */
      }
    });
  });

  // Library dropdowns repopulate their matching collection select on change
  const syncLibSel = document.getElementById("library-select");
  const syncColSel = document.getElementById("collection-select");
  const importLibSel = document.getElementById("import-library-select");
  const importColSel = document.getElementById("import-collection-select");

  syncLibSel.addEventListener("change", async () => {
    if (window._searchMode === "tag") {
      await populateTagsForLibrary(syncLibSel, syncColSel);
    } else {
      populateCollectionsForLibrary(syncLibSel, syncColSel);
    }
    previewItems(null); // reset preview when library changes
    saveSyncSelection();
  });

  importLibSel.addEventListener("change", () => {
    populateCollectionsForLibrary(importLibSel, importColSel);
    if (_tagMultiSelect)
      _tagMultiSelect
        .reloadForLibrary(parseInt(importLibSel.value))
        .catch(() => {});
    saveImportSelection();
  });

  importColSel.addEventListener("change", () => {
    saveImportSelection();
  });

  const syncSelect = document.getElementById("collection-select");
  syncSelect.addEventListener("change", () => {
    const libraryId = parseInt(syncLibSel.value);
    const source =
      window._searchMode === "tag"
        ? { libraryId, tag: syncSelect.value }
        : { collectionId: parseInt(syncSelect.value) };
    previewItems(source);
    saveSyncSelection();
  });

  // Mode toggle: Collection / Tag
  document.querySelectorAll(".mode-option").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await setSearchMode(btn.dataset.mode);
    });
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
      await sendMessage(
        { type: "n2z-cancel-sync", tabId: window._n2zSyncTabId ?? undefined },
        5000,
      );
    });

  document
    .getElementById("btn-check-notebook")
    .addEventListener("click", async () => {
      const select = document.getElementById("collection-select");
      const libSel = document.getElementById("library-select");
      if (!select.value) return;
      const libraryId = parseInt(libSel.value) || null;
      const isTag = window._searchMode === "tag";
      const mappingKey = isTag
        ? syntheticCollectionIdForTag(libraryId, select.value)
        : parseInt(select.value);
      const btn = document.getElementById("btn-check-notebook");
      const resultDiv = document.getElementById("sync-result");
      const tabRes = await sendMessage(
        { type: "n2z-get-notebooklm-tab" },
        3000,
      );
      const notebookId = tabRes?.success ? tabRes.data?.notebookId : null;
      if (!notebookId) {
        resultDiv.classList.remove("hidden");
        resultDiv.className = "result error";
        resultDiv.textContent =
          "Open the notebook first, then click Check notebook.";
        return;
      }
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Checking…";
      const before = await getSyncedMarkers(mappingKey);
      const rec = await sendMessage(
        {
          type: "n2z-reconcile-synced",
          collectionId: mappingKey,
          notebookId,
        },
        15000,
      );
      btn.textContent = orig;
      btn.disabled = false;
      const source = isTag
        ? { libraryId, tag: select.value }
        : { collectionId: parseInt(select.value) };
      await previewItems(source);
      const after =
        rec?.success && rec.data && typeof rec.data === "object"
          ? new Map(Object.entries(rec.data))
          : before;
      const clearedKeys = [...before.keys()].filter((k) => !after.has(k));
      const clearedNames = clearedKeys.map((k) => {
        const m = before.get(k);
        return m && typeof m === "object" && (m.label || m.name)
          ? String(m.label || m.name)
          : k;
      });
      renderCheckNotebookResult(rec, clearedKeys, clearedNames);
    });

  document
    .getElementById("btn-reset-sync")
    .addEventListener("click", async () => {
      const select = document.getElementById("collection-select");
      const libSel = document.getElementById("library-select");
      if (!select.value) return;
      const libraryId = parseInt(libSel.value) || null;
      const isTag = window._searchMode === "tag";
      const mappingKey = isTag
        ? syntheticCollectionIdForTag(libraryId, select.value)
        : parseInt(select.value);
      await sendMessage({
        type: "n2z-clear-sync-state",
        collectionId: mappingKey,
      });
      const resultDiv = document.getElementById("sync-result");
      resultDiv.classList.remove("hidden");
      resultDiv.className = "result success";
      resultDiv.textContent = "Sync state cleared. You can sync again.";
      // Uploaded markers are derived from the cleared state — re-render
      const source = isTag
        ? { libraryId, tag: select.value }
        : { collectionId: parseInt(select.value) };
      await previewItems(source);
    });

  document
    .getElementById("btn-extract")
    .addEventListener("click", handleExtractNotes);

  document
    .getElementById("btn-import")
    .addEventListener("click", handleImportNotes);

  document.getElementById("select-all").addEventListener("change", (e) => {
    const checked = e.target.checked;
    document
      .querySelectorAll('#notes-container input[type="checkbox"]')
      .forEach((cb) => {
        cb.checked = checked;
      });
  });
}

async function handleForwardSync() {
  const select = document.getElementById("collection-select");
  const libSel = document.getElementById("library-select");
  const libraryId = parseInt(libSel.value) || null;
  const selectedLibOpt = libSel.options[libSel.selectedIndex];
  const libraryName = selectedLibOpt?.dataset.libraryName || null;

  let collectionId;
  let collectionName;
  let tag = null;
  if (window._searchMode === "tag") {
    tag = select.value;
    collectionId = syntheticCollectionIdForTag(libraryId, tag);
    collectionName = `Tag: ${tag}`;
  } else {
    collectionId = parseInt(select.value);
    collectionName = select.options[select.selectedIndex]?.dataset.name || "";
  }

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
  if (cancelBtn) {
    cancelBtn.disabled = false;
    cancelBtn.textContent = "Cancel upload";
  }

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
    const selectedUnits = getSelectedUnits();
    const startResult = await sendMessage(
      {
        type: "n2z-forward-sync",
        collectionId,
        collectionName,
        selectedItemKeys: selectedItemKeys.length > 0 ? selectedItemKeys : null,
        selectedUnits: selectedUnits.length > 0 ? selectedUnits : null,
        libraryId,
        libraryName,
        tag,
      },
      10000,
    );

    if (!startResult || !startResult.started) {
      // Sync didn't start (validation error, already running, etc.)
      chrome.runtime.onMessage.removeListener(onProgress);
      resultDiv.classList.remove("hidden");
      resultDiv.className = "result error";
      resultDiv.textContent =
        (startResult && startResult.error) || "Could not start sync";
      btn.disabled = false;
      progress.classList.add("hidden");
      return;
    }

    syncTabId = startResult.tabId;
    window._n2zSyncTabId = syncTabId; // let the Cancel button target this sync

    // Fallback: if the popup misses the broadcast (e.g. was briefly closed),
    // poll every 1.5s to keep the UI up to date.
    const pollInterval = setInterval(async () => {
      const status = await sendMessage(
        { type: "n2z-sync-status", tabId: syncTabId },
        5000,
      );
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
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Cancel upload";
    }
    window._n2zSyncTabId = null;

    resultDiv.classList.remove("hidden");
    if (result && result.cancelled) {
      resultDiv.className = "result"; // neutral, not an error
      resultDiv.textContent = result.message; // "Sync cancelled — N of M uploaded…"
    } else if (result && result.success) {
      resultDiv.className = "result success";
      resultDiv.textContent = result.message;
    } else {
      resultDiv.className = "result error";
      resultDiv.textContent =
        (result && result.error) ||
        (result && result.message) ||
        "Sync failed — no error details returned";
    }

    btn.disabled = false;
    progress.classList.add("hidden");
    progressFill.style.width = "0%";
    const pf = document.getElementById("progress-files");
    if (pf) {
      pf.classList.add("hidden");
      pf.innerHTML = "";
    }
    await loadMappings(result?.mapping ? [result.mapping] : []);
    // Re-render so freshly uploaded items show the green check (read from the
    // now-updated Zotero mapping). Also do this on cancel — partial uploads
    // were recorded and should show their checks.
    if (result && (result.success || result.cancelled)) {
      const colSel = document.getElementById("collection-select");
      if (colSel.value) {
        const source = tag
          ? { libraryId, tag }
          : { collectionId: parseInt(colSel.value) };
        await previewItems(source);
      }
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
  const files =
    data.phase === "files" && Array.isArray(data.files) ? data.files : null;
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

    const preview = stripHtml(note.content || note.html || "").substring(
      0,
      120,
    );
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
  document
    .querySelectorAll('#notes-container input[type="checkbox"]:checked')
    .forEach((cb) => {
      checkedIds.add(cb.dataset.noteId);
    });
  const selectedNotes = allNotes.filter((n) => checkedIds.has(n.id));

  if (selectedNotes.length === 0) {
    alert("No notes selected. Please check at least one note.");
    return;
  }

  const customTags = _tagMultiSelect ? _tagMultiSelect.getSelectedTags() : [];

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
      resultDiv.textContent = (result && result.error) || "Import failed";
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
