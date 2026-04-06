/**
 * Persistent storage for collection-to-notebook mappings.
 * Stored as JSON in Zotero preferences.
 */

export interface CollectionMapping {
  collectionId: number;
  collectionName: string;
  notebookId: string;
  notebookUrl: string;
  lastSyncForward: string | null;
  lastSyncBackward: string | null;
  syncedItemHashes: Record<string, string>;
  importedNoteIds: string[];
}

const PREF_KEY = "mappings";

function readMappings(): CollectionMapping[] {
  try {
    const json = Zotero.Prefs.get(
      `${addon.data.config.prefsPrefix}.${PREF_KEY}`,
      true,
    ) as string;
    return JSON.parse(json || "[]");
  } catch {
    return [];
  }
}

function writeMappings(mappings: CollectionMapping[]): void {
  Zotero.Prefs.set(
    `${addon.data.config.prefsPrefix}.${PREF_KEY}`,
    JSON.stringify(mappings),
    true,
  );
}

export function getMappings(): CollectionMapping[] {
  return readMappings();
}

export function getMapping(
  collectionId: number,
): CollectionMapping | null {
  return readMappings().find((m) => m.collectionId === collectionId) ?? null;
}

export function setMapping(mapping: CollectionMapping): void {
  const mappings = readMappings();
  const idx = mappings.findIndex(
    (m) => m.collectionId === mapping.collectionId,
  );
  if (idx >= 0) {
    mappings[idx] = mapping;
  } else {
    mappings.push(mapping);
  }
  writeMappings(mappings);
}

export function removeMapping(collectionId: number): void {
  const mappings = readMappings().filter(
    (m) => m.collectionId !== collectionId,
  );
  writeMappings(mappings);
}

export function updateSyncTimestamp(
  collectionId: number,
  direction: "forward" | "backward",
): void {
  const mappings = readMappings();
  const mapping = mappings.find((m) => m.collectionId === collectionId);
  if (mapping) {
    const now = new Date().toISOString();
    if (direction === "forward") {
      mapping.lastSyncForward = now;
    } else {
      mapping.lastSyncBackward = now;
    }
    writeMappings(mappings);
  }
}

export function addSyncedItemHash(
  collectionId: number,
  itemKey: string,
  hash: string,
): void {
  const mappings = readMappings();
  const mapping = mappings.find((m) => m.collectionId === collectionId);
  if (mapping) {
    mapping.syncedItemHashes[itemKey] = hash;
    writeMappings(mappings);
  }
}

export function addImportedNoteId(
  collectionId: number,
  noteId: string,
): void {
  const mappings = readMappings();
  const mapping = mappings.find((m) => m.collectionId === collectionId);
  if (mapping && !mapping.importedNoteIds.includes(noteId)) {
    mapping.importedNoteIds.push(noteId);
    writeMappings(mappings);
  }
}
