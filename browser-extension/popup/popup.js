/**
 * n2z Popup UI — Controls for forward and backward sync
 */

document.addEventListener("DOMContentLoaded", init);

async function init() {
  setupTabs();
  await checkConnection();
  await loadCollections();
  await loadNotebookInfo();
  await loadMappings();
  setupEventListeners();
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
    banner.classList.remove("hidden");
  }
}

// ─── Collection loading ──────────────────────────────────────────────

async function loadCollections() {
  const result = await sendMessage({ type: "n2z-get-collections" });

  const selects = [
    document.getElementById("collection-select"),
    document.getElementById("import-collection-select"),
  ];

  for (const select of selects) {
    select.innerHTML = "";

    if (!result.success || !result.data) {
      select.innerHTML = '<option value="">No collections found</option>';
      return;
    }

    select.innerHTML = '<option value="">Select a collection...</option>';
    populateCollectionOptions(select, result.data, 0);
  }
}

function populateCollectionOptions(select, collections, depth) {
  for (const col of collections) {
    const option = document.createElement("option");
    option.value = col.id;
    const indent = "\u00A0\u00A0".repeat(depth);
    const prefix = depth > 0 ? "└ " : "";
    option.textContent =
      indent + prefix + col.name + ` (${col.itemCount})`;
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

async function previewItems(collectionId) {
  const preview = document.getElementById("item-preview");
  const summary = document.getElementById("item-summary");
  const syncBtn = document.getElementById("btn-sync");
  const resetBtn = document.getElementById("btn-reset-sync");

  if (!collectionId) {
    preview.classList.add("hidden");
    syncBtn.disabled = true;
    resetBtn.disabled = true;
    return;
  }

  summary.textContent = "Loading items...";
  preview.classList.remove("hidden");

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
  const urlCount = items.filter((i) => i.exportType === "url").length;
  const fileCount = items.filter((i) => i.exportType === "file").length;
  const totalCount = items.length;

  if (totalCount === 0) {
    summary.innerHTML =
      '<span class="warn">No exportable items (no PDFs, URLs, or DOIs found)</span>';
    syncBtn.disabled = true;
    return;
  }

  let html = `<strong>${totalCount} items</strong> to sync: `;
  const parts = [];
  if (fileCount > 0) parts.push(`${fileCount} files (PDF)`);
  if (urlCount > 0) parts.push(`${urlCount} web URLs`);
  html += parts.join(", ");

  if (totalCount > 50) {
    html +=
      '<br/><span class="warn">NotebookLM supports max 50 sources per notebook. Please use a smaller sub-collection.</span>';
    syncBtn.disabled = true;
  } else {
    syncBtn.disabled = false;
  }
  resetBtn.disabled = false;

  summary.innerHTML = html;
}

// ─── Mappings ────────────────────────────────────────────────────────

async function loadMappings() {
  const result = await sendMessage({ type: "n2z-get-mappings" });
  const list = document.getElementById("mappings-list");

  if (!result.success || !result.data || result.data.length === 0) {
    list.innerHTML = '<p class="empty-state">No mappings yet.</p>';
    return;
  }

  list.innerHTML = "";
  for (const mapping of result.data) {
    const item = document.createElement("div");
    item.className = "mapping-item";

    const lastSync = mapping.lastSyncForward
      ? new Date(mapping.lastSyncForward).toLocaleDateString()
      : "Never";

    item.innerHTML = `
      <div class="mapping-info">
        <div class="mapping-collection">${escapeHtml(mapping.collectionName)}</div>
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

  btn.disabled = true;
  progress.classList.remove("hidden");
  resultDiv.classList.add("hidden");

  try {
    const result = await sendMessage({
      type: "n2z-forward-sync",
      collectionId,
      collectionName,
    });

    resultDiv.classList.remove("hidden");
    if (result && result.success) {
      resultDiv.className = "result success";
      resultDiv.textContent = result.message;
    } else {
      resultDiv.className = "result error";
      resultDiv.textContent =
        (result && result.error) || (result && result.message) || "Sync failed — no error details returned";
    }

    await loadMappings();
  } catch (e) {
    resultDiv.classList.remove("hidden");
    resultDiv.className = "result error";
    resultDiv.textContent = "Error: " + e.message;
  } finally {
    btn.disabled = false;
    progress.classList.add("hidden");
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
