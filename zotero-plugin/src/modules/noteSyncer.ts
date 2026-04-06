/**
 * Backward sync: receives notes from NotebookLM (via browser extension)
 * and creates corresponding Zotero note items with tags.
 */

import { addImportedNoteId, getMapping } from "./mappingStore";

export interface ImportNotePayload {
  collectionId: number;
  notebookId: string;
  noteTitle: string;
  noteContent: string;
  noteType: string;
  sourceUrl?: string;
  tags?: string[];
  timestamp: string;
  noteExternalId: string;
}

export interface ImportNoteResult {
  zoteroItemId: number;
  zoteroItemKey: string;
}

/**
 * Imports a single note from NotebookLM into a Zotero collection.
 * Returns the created Zotero item info or null if it was a duplicate.
 */
export async function importNote(
  payload: ImportNotePayload,
): Promise<ImportNoteResult | null> {
  const collection = Zotero.Collections.get(payload.collectionId);
  if (!collection) {
    throw new Error(`Collection ${payload.collectionId} not found`);
  }

  const mapping = getMapping(payload.collectionId);

  // Format note content
  const formattedHtml = formatNoteContent(payload);

  // Check if this note was previously imported — if so, update it
  const alreadyImported = mapping?.importedNoteIds.includes(payload.noteExternalId);
  if (alreadyImported) {
    // Find the existing parent document in this collection by title match
    const childItems = collection.getChildItems(false) as Zotero.Item[];
    for (const item of childItems) {
      if (item.itemType === "note") continue; // skip standalone notes
      const title = (item.getField("title") as string) || "";
      if (title === payload.noteTitle) {
        // Update the child note attached to this parent
        const noteIds = item.getNotes();
        if (noteIds.length > 0) {
          const childNote = Zotero.Items.get(noteIds[0]);
          if (childNote) {
            childNote.setNote(formattedHtml);
            await childNote.saveTx();
          }
        } else {
          // No child note exists, create one
          const childNote = new Zotero.Item("note");
          childNote.libraryID = collection.libraryID;
          childNote.parentID = item.id;
          childNote.setNote(formattedHtml);
          await childNote.saveTx();
        }
        return {
          zoteroItemId: item.id,
          zoteroItemKey: item.key,
        };
      }
    }
    // If we couldn't find the existing item, create a new one (fall through)
  }

  // Create a parent "document" item so the note has proper metadata
  // (standalone notes can't sync with tools like Notion that require a parent)
  const parent = new Zotero.Item("document");
  parent.libraryID = collection.libraryID;
  parent.setField("title", payload.noteTitle);
  parent.setField("abstractNote", `Imported from NotebookLM (${payload.noteType})`);
  if (payload.sourceUrl) {
    parent.setField("url", payload.sourceUrl);
  }
  parent.setField("date", new Date().toISOString().split("T")[0]);

  // Add default tags
  const defaultTags = getDefaultTags();
  for (const tag of defaultTags) {
    if (tag.trim()) {
      parent.addTag(tag.trim());
    }
  }

  // Add notebook name tag
  if (mapping?.collectionName) {
    parent.addTag(`notebook:${mapping.collectionName}`);
  }

  // Add note type tag
  parent.addTag(`n2z-type:${payload.noteType}`);

  // Add user-supplied custom tags
  if (payload.tags) {
    for (const tag of payload.tags) {
      if (tag.trim()) {
        parent.addTag(tag.trim());
      }
    }
  }

  // Add to collection BEFORE saving
  parent.addToCollection(collection.id);
  await parent.saveTx();

  // Create child note attached to the parent item
  const note = new Zotero.Item("note");
  note.libraryID = collection.libraryID;
  note.parentID = parent.id;
  note.setNote(formattedHtml);
  await note.saveTx();

  // Track imported note ID for deduplication
  if (mapping) {
    addImportedNoteId(payload.collectionId, payload.noteExternalId);
  }

  return {
    zoteroItemId: parent.id,
    zoteroItemKey: parent.key,
  };
}

/**
 * Imports multiple notes in a single transaction.
 */
export async function importNotes(
  payloads: ImportNotePayload[],
): Promise<(ImportNoteResult | null)[]> {
  const results: (ImportNoteResult | null)[] = [];
  for (const payload of payloads) {
    const result = await importNote(payload);
    results.push(result);
  }
  return results;
}

/**
 * Formats NotebookLM note content as clean Zotero note HTML.
 */
function formatNoteContent(payload: ImportNotePayload): string {
  const header = `<h1>${escapeHtml(payload.noteTitle)}</h1>`;

  const meta: string[] = [];
  meta.push(`<strong>Source:</strong> NotebookLM`);
  meta.push(`<strong>Type:</strong> ${escapeHtml(payload.noteType)}`);
  meta.push(`<strong>Imported:</strong> ${new Date().toISOString()}`);
  if (payload.sourceUrl) {
    meta.push(
      `<strong>URL:</strong> <a href="${escapeHtml(payload.sourceUrl)}">${escapeHtml(payload.sourceUrl)}</a>`,
    );
  }
  if (payload.timestamp) {
    meta.push(
      `<strong>Created in NotebookLM:</strong> ${escapeHtml(payload.timestamp)}`,
    );
  }

  const metaBlock = `<p style="color: #666; font-size: 0.9em;">${meta.join("<br/>")}</p>`;
  const separator = "<hr/>";

  // The content from NotebookLM extraction is a card summary.
  // Full note content requires opening each note individually.
  const body = payload.noteContent
    ? (payload.noteContent.startsWith("<")
        ? payload.noteContent
        : `<p>${escapeHtml(payload.noteContent)}</p>`)
    : `<p><em>Note imported from NotebookLM. Open the notebook to view full content.</em></p>`;

  return `${header}${metaBlock}${separator}${body}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getDefaultTags(): string[] {
  try {
    const tags = Zotero.Prefs.get(
      `${addon.data.config.prefsPrefix}.defaultTags`,
      true,
    ) as string;
    return (tags || "n2z,NotebookLM").split(",");
  } catch {
    return ["n2z", "NotebookLM"];
  }
}
