# NZBridge — NotebookLM Zotero Bridge

<a href="https://buymeacoffee.com/rafaeloliveira" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50">
</a>

**The maintenance and development of NZBridge depends on community support. If you find it useful, please consider buying me a coffee!**

---

NZBridge enables **bidirectional sync** between [Zotero](https://www.zotero.org/) and [Google NotebookLM](https://notebooklm.google.com/). Push your research library into NotebookLM for AI-powered analysis, then pull your generated notes back into Zotero — all without leaving your browser.

## Features

### Forward Sync (Zotero -> NotebookLM)
- **PDF upload** — Local PDF attachments are uploaded directly to NotebookLM as sources via drag-and-drop
- **URL sources** — Items without local files are synced as web sources using their best available URL
- **Batch processing** — Multiple URLs are pasted in a single operation
- **Auto-naming** — New notebooks are automatically named after the Zotero collection
- **Duplicate detection** — Already-synced items are skipped (per collection-notebook pair)
- **50-source limit** — Warns if a collection exceeds NotebookLM's per-notebook limit

### Backward Sync (NotebookLM -> Zotero)
- **Note extraction** — Scrapes saved notes from NotebookLM's Studio panel
- **Rich content** — Captures full note body text, not just titles
- **Smart navigation** — Clicks into each note's detail view, scrapes content, then navigates back
- **Parent items** — Creates proper Zotero document items (compatible with Notion sync using tools such as Notero)
- **Tags** — Automatically adds default tags (`n2z`, `NotebookLM`), notebook name, note type, and custom user tags
- **Overwrite support** — Re-importing updates existing notes instead of creating duplicates

### Robust UI
- **Collapsed layout support** — Works on both wide (3-column) and narrow/vertical (tabbed) NotebookLM layouts
- **Collection browser** — Hierarchical collection tree with item counts
- **Select/deselect notes** — Choose which notes to import
- **Mapping management** — View and manage collection-notebook mappings
- **Reset sync state** — Clear sync history to re-sync items

## Architecture

NZBridge consists of two components:

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Zotero Plugin** | Zotero 7/8 plugin (TypeScript) | HTTP server exposing collections, files, and note import API |
| **Browser Extension** | Chrome MV3 extension | UI popup + background service worker that orchestrates sync via DOM scripting |

The browser extension communicates with the Zotero plugin via `localhost:23119` (Zotero's built-in HTTP server).

## Installation

### Zotero Plugin

1. Open Zotero 7 or later
2. Go to **Tools > Add-ons**
3. Click the gear icon > **Install Add-on From File...**
4. Select the `.xpi` file from `zotero-plugin/.scaffold/build/`
5. Restart Zotero

To build from source:
```bash
cd zotero-plugin
npm install
npm run build
```

### Browser Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `browser-extension/` folder
5. Pin the NZBridge extension to your toolbar

## Usage

### Forward Sync (Push to NotebookLM)

1. Open a notebook in [NotebookLM](https://notebooklm.google.com/)
2. Click the NZBridge extension icon
3. In the **To NotebookLM** tab, select a Zotero collection
4. Review the item preview (PDFs and URLs)
5. Click **Sync to NotebookLM**
6. The notebook will be auto-named after your collection (if untitled)

### Backward Sync (Pull from NotebookLM)

1. Open a notebook in NotebookLM with saved notes in the Studio panel
2. Click the NZBridge extension icon
3. Go to the **To Zotero** tab
4. Select a target Zotero collection
5. Optionally add custom tags
6. Click **Find Text Notes** to scan for available notes
7. Select/deselect notes as needed
8. Click **Import Selected**

### Tips

- **Reset sync** if you need to re-upload sources that were previously synced
- NotebookLM supports a **maximum of 50 sources** per notebook — use sub-collections for larger libraries
- Imported notes appear as **Document** items in Zotero with attached child notes, making them compatible with other sync tools (e.g., Notion)
- The extension works on both **wide monitors** (3-column layout) and **narrow/vertical monitors** (collapsed tab layout)

## Permissions

### Browser Extension
- `activeTab` — Interact with the active NotebookLM tab
- `scripting` — Inject scripts for DOM automation
- `debugger` — Chrome DevTools Protocol for PDF file upload
- `storage` — Persist sync state and mappings

### Zotero Plugin
- Runs an HTTP server on `localhost:23119` (Zotero's built-in connector port)
- Read access to collections, items, and file attachments
- Write access to create/update note items

## Development

### Zotero Plugin
```bash
cd zotero-plugin
npm install
npm run start    # Dev mode with hot reload
npm run build    # Production build
```

### Browser Extension
No build step required — load `browser-extension/` directly as an unpacked extension. Edit files and reload the extension from `chrome://extensions/`.

## Requirements

- **Zotero** 7.0 or later
- **Chrome** 116 or later (Manifest V3 support)
- A [Google NotebookLM](https://notebooklm.google.com/) account

## License

AGPL-3.0-or-later

---

<a href="https://buymeacoffee.com/rafaeloliveira" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50">
</a>
