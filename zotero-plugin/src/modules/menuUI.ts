/**
 * Right-click context menus on Zotero collections for n2z sync actions.
 */

import { getLocaleID } from "../utils/locale";

/**
 * Registers context menu items on collections.
 */
export function registerMenus(): void {
  const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;

  // "Sync to NotebookLM" on collection right-click
  ztoolkit.Menu.register("collection", {
    tag: "menuitem",
    id: "n2z-sync-to-notebooklm",
    label: "Sync to NotebookLM",
    commandListener: (_ev) => {
      onSyncToNotebookLM();
    },
    icon: menuIcon,
  });

  // "Import Notes from NotebookLM" on collection right-click
  ztoolkit.Menu.register("collection", {
    tag: "menuitem",
    id: "n2z-import-from-notebooklm",
    label: "Import Notes from NotebookLM",
    commandListener: (_ev) => {
      onImportFromNotebookLM();
    },
    icon: menuIcon,
  });
}

/**
 * Returns the currently selected collection, or null if none is selected.
 *
 * Zotero 10 added multi-selection and removed the singular getters:
 * `getSelectedCollection()` now throws, naming `getSelectedCollections()`
 * as its replacement. We prefer the plural API where it exists and fall
 * back to the singular one on Zotero 7-9, so a single build works across
 * every supported version.
 *
 * n2z acts on one collection at a time, so when several are selected we
 * take the first — matching the pre-10 behaviour the handlers expect.
 */
function getSelectedCollection(): Zotero.Collection | null {
  const zoteroPane = Zotero.getActiveZoteroPane() as any;

  if (typeof zoteroPane.getSelectedCollections === "function") {
    const collections = zoteroPane.getSelectedCollections();
    return collections?.length ? collections[0] : null;
  }

  return zoteroPane.getSelectedCollection() || null;
}

/**
 * Handler: user requests forward sync on a collection.
 * Shows a notification since actual sync is driven by the browser extension.
 */
function onSyncToNotebookLM(): void {
  const collection = getSelectedCollection();

  if (!collection) {
    showNotification("Please select a collection first.", "default");
    return;
  }

  showNotification(
    `Ready to sync "${collection.name}" to NotebookLM. Open the n2z browser extension to start.`,
    "default",
  );
}

/**
 * Handler: user requests backward sync (import notes from NotebookLM).
 * Shows a notification since actual import is driven by the browser extension.
 */
function onImportFromNotebookLM(): void {
  const collection = getSelectedCollection();

  if (!collection) {
    showNotification("Please select a collection first.", "default");
    return;
  }

  showNotification(
    `Ready to import notes into "${collection.name}". Open the n2z browser extension to start.`,
    "default",
  );
}

function showNotification(
  text: string,
  type: "default" | "success" | "error",
): void {
  new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: 5000,
  })
    .createLine({ text, type })
    .show();
}
