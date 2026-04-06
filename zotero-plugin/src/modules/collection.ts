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
}

export interface FileData {
  base64: string;
  contentType: string;
  filename: string;
  fileSize: number;
  filePath: string;
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
  const exportable: ExportableItem[] = [];

  for (const item of items) {
    if (!item.isRegularItem()) continue;
    if (options?.tag && !item.getTags().some((t) => t.tag === options.tag)) {
      continue;
    }

    // Strategy 1: Look for a local file attachment (PDF, DOCX, etc.)
    let foundFile = false;
    const attachmentIDs = item.getAttachments();
    for (const attID of attachmentIDs) {
      const att = Zotero.Items.get(attID);
      if (!att) continue;

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

      const effectiveContentType =
        contentType || extToContentType(ext) || "application/octet-stream";

      exportable.push({
        itemId: item.id,
        title: item.getField("title") as string,
        attachmentId: att.id,
        attachmentTitle: att.getField("title") as string,
        contentType: effectiveContentType,
        filename,
        fileSize,
        itemKey: item.key,
        exportType: "file",
      });
      foundFile = true;
      break;
    }

    // Strategy 2: No local file — export as URL source for NotebookLM
    if (!foundFile) {
      const url = getItemUrl(item);
      if (url) {
        exportable.push({
          itemId: item.id,
          title: item.getField("title") as string,
          attachmentId: 0,
          attachmentTitle: "",
          contentType: "text/url",
          filename: "",
          fileSize: 0,
          itemKey: item.key,
          exportType: "url",
          url,
        });
      }
    }
  }

  return exportable;
}

/**
 * Gets the best URL for a Zotero item.
 * Prefers DOI > URL field > attachment URL.
 */
function getItemUrl(item: Zotero.Item): string | null {
  // Collect all candidate URLs, then pick the best one.
  // Goal: avoid bot-protected URLs (publishers, PubMed) and prefer
  // open-access archives (PMC, Europe PMC, bioRxiv, arXiv, etc.)
  const candidates: string[] = [];

  try {
    const url = item.getField("url") as string;
    if (url) candidates.push(url);
  } catch {}

  // Attachment URLs
  const attachmentIDs = item.getAttachments();
  for (const attID of attachmentIDs) {
    const att = Zotero.Items.get(attID);
    if (!att) continue;
    try {
      const attUrl = att.getField("url") as string;
      if (attUrl) candidates.push(attUrl);
    } catch {}
  }

  // DOI as last resort
  try {
    const doi = item.getField("DOI") as string;
    if (doi) {
      candidates.push(
        doi.startsWith("http") ? doi : `https://doi.org/${doi}`,
      );
    }
  } catch {}

  // Also try to construct a PMC link from PMCID if available
  try {
    const extra = item.getField("extra") as string;
    if (extra) {
      const pmcMatch = extra.match(/PMCID:\s*(PMC\d+)/i);
      if (pmcMatch) {
        candidates.push(`https://pmc.ncbi.nlm.nih.gov/articles/${pmcMatch[1]}/`);
      }
    }
  } catch {}

  if (candidates.length === 0) return null;

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

  candidates.sort((a, b) => rank(a) - rank(b));
  return candidates[0];
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
