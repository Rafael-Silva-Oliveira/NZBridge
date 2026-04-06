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
 * Handler: user requests forward sync on a collection.
 * Shows a notification since actual sync is driven by the browser extension.
 */
function onSyncToNotebookLM(): void {
  const zoteroPane = Zotero.getActiveZoteroPane();
  const collection = zoteroPane.getSelectedCollection();

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
  const zoteroPane = Zotero.getActiveZoteroPane();
  const collection = zoteroPane.getSelectedCollection();

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
