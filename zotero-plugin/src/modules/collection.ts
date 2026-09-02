/**
 * Collection traversal and file export for n2z.
 * Provides APIs to list collections, get exportable items, and serve files as base64.
 */

const EXPORTABLE_CONTENT_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export interface CollectionInfo {
  id: number;
  name: string;
  parentID: number | false;
  children: CollectionInfo[];
  itemCount: number;
  libraryId?: number;
  libraryName?: string;
}

export interface LibraryTree {
  libraryId: number;
  libraryName: string;
  libraryType: "user" | "group";
  collections: CollectionInfo[];
}

export interface ExportableItem {
  itemId: number;
  title: string;
  attachmentId: number;
  attachmentTitle: string;
  contentType: string;
  filename: string;
  fileSize: number;
  itemKey: string;
  exportType: "file" | "url";
  url?: string;
  // All selectable upload units for this item (default unit first).
  // Top-level fields above always describe the DEFAULT unit, so older
  // extensions that ignore this field keep working unchanged.
  units?: AttachmentUnit[];
}

export interface AttachmentUnit {
  // "att-<attachmentId>" for real attachments,
  // "url-<hash>" for metadata-derived URLs (item URL / DOI / PMCID)
  unitId: string;
  kind: "file" | "url";
  attachmentId: number; // 0 for metadata-URL units
  title: string;
  contentType: string; // file MIME or "text/url"
  filename: string; // files only
  fileSize: number; // files only
  url?: string; // url units only
  isDefault: boolean;
}

export interface FileData {
  base64: string;
  contentType: string;
  filename: string;
  fileSize: number;
  filePath: string;
}

export interface TagInfo {
  tag: string;
  itemCount?: number;
}

export interface DebugItemInfo {
  itemId: number;
  title: string;
  itemType: string;
  isRegularItem: boolean;
  attachments: {
    id: number;
    title: string;
    contentType: string;
    isFileAttachment: boolean;
    isImportedAttachment: boolean;
    isLinkedFileAttachment: boolean;
    isStoredFileAttachment: boolean;
    linkMode: number;
    filePath: string | false;
    fileExists: boolean;
  }[];
}

/**
 * Returns trees for all locally-synced libraries (user + every group).
 * Skips libraries that have no collections.
 */
export function getAllLibrariesTree(): LibraryTree[] {
  const result: LibraryTree[] = [];

  const userLibID = Zotero.Libraries.userLibraryID;
  result.push({
    libraryId: userLibID,
    libraryName: "My Library",
    libraryType: "user",
    collections: getCollectionTree(userLibID),
  });

  for (const group of Zotero.Groups.getAll()) {
    const libID = group.libraryID;
    result.push({
      libraryId: libID,
      libraryName: group.name,
      libraryType: "group",
      collections: getCollectionTree(libID),
    });
  }

  return result;
}

/**
 * Returns the full collection hierarchy for a given library.
 * Uses recursive traversal to correctly build the tree.
 */
export function getCollectionTree(libraryID?: number): CollectionInfo[] {
  const libID = libraryID ?? Zotero.Libraries.userLibraryID;

  // Build tree recursively using getChildCollections() which is reliable
  // across all Zotero 7/8 versions
  function buildNode(col: any): CollectionInfo {
    const children: CollectionInfo[] = [];
    const childCols = col.getChildCollections(false) || [];
    for (const child of childCols) {
      children.push(buildNode(child));
    }
    children.sort((a, b) => a.name.localeCompare(b.name));

    return {
      id: col.id,
      name: col.name,
      parentID: col.parentID || false,
      children,
      itemCount: col.getChildItems(false).length,
    };
  }

  // Get top-level collections only (no recursive flag)
  const topLevel = Zotero.Collections.getByLibrary(libID);
  const roots: CollectionInfo[] = [];

  for (const col of topLevel) {
    roots.push(buildNode(col));
  }

  roots.sort((a, b) => a.name.localeCompare(b.name));
  return roots;
}

/**
 * Debug: returns detailed info about all items in a collection,
 * including their attachments, content types, and file paths.
 */
export async function debugCollectionItems(
  collectionId: number,
): Promise<DebugItemInfo[]> {
  const collection = Zotero.Collections.get(collectionId);
  if (!collection) {
    throw new Error(`Collection ${collectionId} not found`);
  }

  const items = collection.getChildItems(false) as Zotero.Item[];
  const debugItems: DebugItemInfo[] = [];

  for (const item of items) {
    const attachmentIDs = item.getAttachments();
    const attachments = [];

    for (const attID of attachmentIDs) {
      const att = Zotero.Items.get(attID);
      if (!att) continue;

      let filePath: string | false = false;
      let fileExists = false;
      try {
        filePath = await att.getFilePathAsync();
        if (filePath) {
          fileExists = await IOUtils.exists(filePath);
        }
      } catch {
        // ignore
      }

      attachments.push({
        id: att.id,
        title: (att.getField("title") as string) || "",
        contentType: att.attachmentContentType || "unknown",
        isFileAttachment: att.isFileAttachment(),
        isImportedAttachment: att.isImportedAttachment(),
        isLinkedFileAttachment: att.isLinkedFileAttachment?.() ?? false,
        isStoredFileAttachment: att.isStoredFileAttachment?.() ?? false,
        linkMode: att.attachmentLinkMode,
        filePath,
        fileExists,
      });
    }

    debugItems.push({
      itemId: item.id,
      title: (item.getField("title") as string) || "",
      itemType: item.itemType,
      isRegularItem: item.isRegularItem(),
      attachments,
    });
  }

  return debugItems;
}

/**
 * Returns exportable items from a collection.
 * Tries local files first (PDF, DOCX, etc.), falls back to URLs
 * (article URL, DOI link) that NotebookLM can import as web sources.
 */
export async function getExportableItems(
  collectionId: number,
  options?: { tag?: string },
): Promise<ExportableItem[]> {
  const collection = Zotero.Collections.get(collectionId);
  if (!collection) {
    throw new Error(`Collection ${collectionId} not found`);
  }

  const items = collection.getChildItems(false) as Zotero.Item[];
  return buildExportableList(items, options?.tag);
}

/**
 * Returns all tags present in a library, optionally with per-tag item counts.
 * Handles several observed tag object shapes from different Zotero versions.
 */
export async function getTagsForLibrary(
  libraryID?: number,
): Promise<TagInfo[]> {
  const libID = libraryID ?? Zotero.Libraries.userLibraryID;
  let tags: any[] = [];
  try {
    tags = (await Zotero.Tags.getAll(libID)) || [];
    ztoolkit.log(
      `[n2z] Zotero.Tags.getAll(${libID}) returned ${tags.length} raw tag(s)`,
    );
  } catch (e: any) {
    ztoolkit.log(`[n2z] getTagsForLibrary(${libID}) failed: ${e.message}`);
  }

  // Fallback: if the official API returns nothing, collect tags from every
  // regular item in the library. This is slower but works around versions
  // where getAll behaves unexpectedly.
  if (tags.length === 0) {
    try {
      const s = new Zotero.Search() as any;
      s.libraryID = libID;
      s.addCondition("itemType", "isNot", "note");
      const itemIDs = await s.search();
      const items = (await Zotero.Items.getAsync(
        itemIDs,
      )) as unknown as Zotero.Item[];
      const fallback: TagInfo[] = [];
      for (const item of items) {
        for (const t of item.getTags()) {
          if (t.tag) fallback.push({ tag: t.tag });
        }
      }
      ztoolkit.log(
        `[n2z] tag fallback scan found ${fallback.length} tag occurrence(s) in ${items.length} item(s)`,
      );
      return dedupeAndSortTags(fallback);
    } catch (fallbackErr: any) {
      ztoolkit.log(`[n2z] tag fallback scan failed: ${fallbackErr.message}`);
    }
  }

  const tagInfos: TagInfo[] = [];
  for (const tag of tags) {
    let name: string | undefined;
    if (typeof tag === "string") {
      name = tag;
    } else if (tag && typeof tag === "object") {
      name = tag.tag || tag.name || tag.tagName;
    }
    if (!name || typeof name !== "string") continue;
    tagInfos.push({ tag: name });
  }

  return dedupeAndSortTags(tagInfos);
}

function dedupeAndSortTags(tagInfos: TagInfo[]): TagInfo[] {
  const seen = new Set<string>();
  const unique = tagInfos.filter((t) => {
    if (seen.has(t.tag)) return false;
    seen.add(t.tag);
    return true;
  });
  unique.sort((a, b) => a.tag.localeCompare(b.tag));
  ztoolkit.log(`[n2z] tags: ${tagInfos.length} raw → ${unique.length} unique`);
  return unique;
}

/**
 * Returns exportable items across a library that have a specific tag.
 */
export async function getExportableItemsByTag(
  libraryID: number,
  tag: string,
): Promise<ExportableItem[]> {
  const s = new Zotero.Search() as any;
  s.libraryID = libraryID;
  s.addCondition("tag", "is", tag);
  const itemIDs = await s.search();
  const items = (await Zotero.Items.getAsync(
    itemIDs,
  )) as unknown as Zotero.Item[];
  return buildExportableList(items);
}

/**
 * Builds an exportable-item list from a raw item array. When `tagFilter` is
 * supplied, only items carrying that exact tag are considered.
 */
async function buildExportableList(
  items: Zotero.Item[],
  tagFilter?: string,
): Promise<ExportableItem[]> {
  const exportable: ExportableItem[] = [];

  for (const item of items) {
    if (!item.isRegularItem()) continue;
    if (tagFilter && !item.getTags().some((t) => t.tag === tagFilter)) {
      continue;
    }

    const exported = await exportSingleItem(item);
    if (exported) {
      exportable.push(exported);
    }
  }

  return exportable;
}

/**
 * URL candidate for NotebookLM web-source export.
 * `attachmentId` is set when the URL comes from an attachment (stable
 * `att-<id>` unit key); 0 for metadata-derived URLs.
 */
interface UrlCandidate {
  url: string;
  attachmentId: number;
  title: string;
}

/**
 * Collects every distinct URL candidate for an item, ranked best-first
 * (open-access archives preferred, bot-protected publishers last).
 * Collection order mirrors the historical getItemUrl order so the
 * best-ranked pick is identical to previous versions; a metadata URL that
 * duplicates an attachment URL adopts that attachment's identity.
 */
function getItemUrlCandidates(
  item: Zotero.Item,
  atts: Zotero.Item[],
): UrlCandidate[] {
  const seen = new Set<string>();
  const candidates: UrlCandidate[] = [];

  const norm = (url: string) => url.toLowerCase().replace(/\/+$/, "");
  const domainOf = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };
  const push = (url: string, attachmentId = 0, title = "") => {
    const key = norm(url);
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push({ url, attachmentId, title: title || domainOf(url) });
  };

  try {
    const url = item.getField("url") as string;
    if (url) push(url);
  } catch {
    /* ignore */
  }

  // Attachment URLs
  for (const att of atts) {
    try {
      const attUrl = att.getField("url") as string;
      if (attUrl) push(attUrl, att.id, (att.getField("title") as string) || "");
    } catch {
      /* ignore */
    }
  }

  // DOI as last resort
  try {
    const doi = item.getField("DOI") as string;
    if (doi) {
      push(doi.startsWith("http") ? doi : `https://doi.org/${doi}`);
    }
  } catch {
    /* ignore */
  }

  // Also try to construct a PMC link from PMCID if available
  try {
    const extra = item.getField("extra") as string;
    if (extra) {
      const pmcMatch = extra.match(/PMCID:\s*(PMC\d+)/i);
      if (pmcMatch) {
        push(`https://pmc.ncbi.nlm.nih.gov/articles/${pmcMatch[1]}/`);
      }
    }
  } catch {
    /* ignore */
  }

  if (candidates.length === 0) return [];

  // Rank URLs: prefer open-access / crawler-friendly sources
  const rank = (url: string): number => {
    const u = url.toLowerCase();
    // Best: open archives with no bot protection
    if (u.includes("pmc.ncbi.nlm.nih.gov")) return 0;
    if (u.includes("europepmc.org")) return 0;
    if (u.includes("arxiv.org")) return 1;
    if (u.includes("biorxiv.org")) return 1;
    if (u.includes("medrxiv.org")) return 1;
    if (u.includes("ncbi.nlm.nih.gov/pmc")) return 1;
    // Decent: repositories and preprint servers
    if (u.includes("semanticscholar.org")) return 2;
    if (u.includes("researchgate.net")) return 3;
    // Avoid: PubMed abstract pages (reCAPTCHA)
    if (u.includes("pubmed.ncbi.nlm.nih.gov")) return 6;
    // Avoid: DOI redirects (Cloudflare on publishers)
    if (u.includes("doi.org/")) return 7;
    // Avoid: known bot-protected publishers
    if (u.includes("science.org")) return 8;
    if (u.includes("nature.com")) return 8;
    if (u.includes("springer.com")) return 8;
    if (u.includes("wiley.com")) return 8;
    if (u.includes("elsevier.com") || u.includes("sciencedirect.com")) return 8;
    if (u.includes("cell.com")) return 8;
    if (u.includes("oup.com")) return 8;
    if (u.includes("tandfonline.com")) return 8;
    // Everything else: middle ground
    return 5;
  };

  // Stable sort keeps today's collection-order tie-break, so the default
  // pick (first candidate) is unchanged from previous versions.
  candidates.sort((a, b) => rank(a.url) - rank(b.url));

  // A metadata URL identical to an attachment URL adopts the attachment's
  // identity (stable att-<id> unit key + attachment title).
  for (const c of candidates) {
    if (c.attachmentId !== 0) continue;
    const key = norm(c.url);
    const att = atts.find(
      (a) => a.getField("url") && norm(a.getField("url") as string) === key,
    );
    if (att) {
      c.attachmentId = att.id;
      c.title = (att.getField("title") as string) || c.title;
    }
  }

  return candidates;
}

/** Compact stable id for a metadata-derived URL unit. */
function urlUnitId(url: string): string {
  let hash = 5381;
  const s = url.toLowerCase().replace(/\/+$/, "");
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) + hash + s.charCodeAt(i);
    hash |= 0;
  }
  return `url-${Math.abs(hash)}`;
}

function candidateToUnit(c: UrlCandidate, isDefault: boolean): AttachmentUnit {
  return {
    unitId: c.attachmentId ? `att-${c.attachmentId}` : urlUnitId(c.url),
    kind: "url",
    attachmentId: c.attachmentId,
    title: c.title || c.url,
    contentType: "text/url",
    filename: "",
    fileSize: 0,
    url: c.url,
    isDefault,
  };
}

/**
 * Turns one Zotero item into an exportable payload listing ALL selectable
 * attachments. The default unit is Zotero's best attachment (the one opened
 * on click) when it is an exportable file, else the first exportable file
 * attachment, else the best-ranked URL. Items without any file attachment
 * or URL candidate are excluded (null).
 */
async function exportSingleItem(
  item: Zotero.Item,
): Promise<ExportableItem | null> {
  const attachmentIDs = item.getAttachments();
  const atts: Zotero.Item[] = [];
  const fileUnits: AttachmentUnit[] = [];

  for (const attID of attachmentIDs) {
    const att = Zotero.Items.get(attID);
    if (!att) continue;
    atts.push(att);

    const isFile =
      att.isFileAttachment() ||
      att.isImportedAttachment() ||
      (att.isLinkedFileAttachment?.() ?? false) ||
      (att.isStoredFileAttachment?.() ?? false);

    if (!isFile) continue;

    const contentType = att.attachmentContentType || "";
    let filePath: string | false = false;
    try {
      filePath = await att.getFilePathAsync();
    } catch {
      continue;
    }
    if (!filePath) continue;

    const filename = filePath.split(/[/\\]/).pop() || "unknown";
    const ext = filename.split(".").pop()?.toLowerCase() || "";

    const isExportableType =
      EXPORTABLE_CONTENT_TYPES.includes(contentType) ||
      ["pdf", "txt", "md", "markdown", "docx"].includes(ext);

    if (!isExportableType) continue;

    let fileExists = false;
    let fileSize = 0;
    try {
      fileExists = await IOUtils.exists(filePath);
      if (fileExists) {
        const stat = await IOUtils.stat(filePath);
        fileSize = stat.size ?? 0;
      }
    } catch {
      // fall through
    }
    if (!fileExists) continue;

    fileUnits.push({
      unitId: `att-${att.id}`,
      kind: "file",
      attachmentId: att.id,
      title: (att.getField("title") as string) || filename,
      contentType:
        contentType || extToContentType(ext) || "application/octet-stream",
      filename,
      fileSize,
      isDefault: false,
    });
  }

  const candidates = getItemUrlCandidates(item, atts);

  // File item: default = Zotero's best attachment (the one opened on click)
  // when it is among the exportable file units; else the first file unit.
  if (fileUnits.length > 0) {
    let defaultIdx = 0;
    try {
      const best = await item.getBestAttachment();
      if (best) {
        const idx = fileUnits.findIndex((u) => u.attachmentId === best.id);
        if (idx !== -1) defaultIdx = idx;
      }
    } catch {
      // fall back to the first file unit
    }

    const defaultUnit = fileUnits[defaultIdx];
    defaultUnit.isDefault = true;
    const otherFiles = fileUnits.filter((_, i) => i !== defaultIdx);
    // Extra units for file items: remaining files + attachment-sourced URLs
    // (linked-URL attachments, snapshot source URLs, file-attachment URLs).
    const urlUnits = candidates
      .filter((c) => c.attachmentId !== 0)
      .map((c) => candidateToUnit(c, false));

    return {
      itemId: item.id,
      title: item.getField("title") as string,
      attachmentId: defaultUnit.attachmentId,
      attachmentTitle: defaultUnit.title,
      contentType: defaultUnit.contentType,
      filename: defaultUnit.filename,
      fileSize: defaultUnit.fileSize,
      itemKey: item.key,
      exportType: "file",
      units: [defaultUnit, ...otherFiles, ...urlUnits],
    };
  }

  // No local file — URL item: default = best-ranked candidate (today's pick)
  if (candidates.length === 0) return null;
  const units = candidates.map((c, i) => candidateToUnit(c, i === 0));
  const defaultUnit = units[0];

  return {
    itemId: item.id,
    title: item.getField("title") as string,
    attachmentId: 0,
    attachmentTitle: "",
    contentType: "text/url",
    filename: "",
    fileSize: 0,
    itemKey: item.key,
    exportType: "url",
    url: defaultUnit.url,
    units,
  };
}

function extToContentType(ext: string): string | null {
  const map: Record<string, string> = {
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return map[ext] || null;
}

/**
 * Reads an attachment file and returns it as base64-encoded data.
 */
export async function getFileAsBase64(attachmentId: number): Promise<FileData> {
  const att = Zotero.Items.get(attachmentId);
  if (!att) {
    throw new Error(`Attachment ${attachmentId} not found`);
  }

  let filePath: string | false = false;
  try {
    filePath = await att.getFilePathAsync();
  } catch {
    throw new Error(`Could not get file path for attachment ${attachmentId}`);
  }

  if (!filePath) {
    throw new Error(`No file path for attachment ${attachmentId}`);
  }

  const data = await IOUtils.read(filePath);
  const bytes = new Uint8Array(data);

  // Build binary string in chunks to avoid call stack limits with String.fromCharCode
  let binaryString = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binaryString += String.fromCharCode(...slice);
  }
  const base64 = btoa(binaryString);

  const filename = filePath.split(/[/\\]/).pop() || "unknown";

  return {
    base64,
    contentType: att.attachmentContentType || "application/pdf",
    filename,
    fileSize: bytes.byteLength,
    filePath: filePath as string,
  };
}
