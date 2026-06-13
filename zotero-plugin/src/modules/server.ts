/**
 * HTTP server endpoints for communication with the browser extension.
 * Registers on Zotero's built-in HTTP server (port 23119).
 */

import {
  getCollectionTree,
  getAllLibrariesTree,
  getExportableItems,
  getExportableItemsByTag,
  getTagsForLibrary,
  getFileAsBase64,
  debugCollectionItems,
} from "./collection";
import {
  getMappings,
  getMapping,
  setMapping,
  removeMapping,
  type CollectionMapping,
} from "./mappingStore";
import { importNote, importNotes, type ImportNotePayload } from "./noteSyncer";

function sendJson(
  sendResponseCallback: Function,
  statusCode: number,
  data: any,
) {
  sendResponseCallback(statusCode, "application/json", JSON.stringify(data));
}

function success(sendResponseCallback: Function, data?: any) {
  sendJson(sendResponseCallback, 200, { success: true, data });
}

function error(
  sendResponseCallback: Function,
  statusCode: number,
  message: string,
) {
  sendJson(sendResponseCallback, statusCode, {
    success: false,
    error: message,
  });
}

/**
 * GET /n2z/status — Health check and plugin version
 */
class StatusEndpoint {
  supportedMethods = ["GET"];
  supportedDataTypes = ["application/json"];
  permitBookmarklet = false;

  init(_urlObj: any, _data: any, sendResponseCallback: Function) {
    success(sendResponseCallback, {
      version: addon.data.config.addonName + " v" + __env__,
      alive: addon.data.alive,
    });
  }
}

/**
 * POST /n2z/collections — List all collections as a tree
 * Body: { libraryId?: number }
 */
class CollectionsEndpoint {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];
  permitBookmarklet = false;

  init(_urlObj: any, data: any, sendResponseCallback: Function) {
    try {
      const body = typeof data === "string" ? JSON.parse(data) : data;
      const tree = getCollectionTree(body?.libraryId);
      success(sendResponseCallback, tree);
    } catch (e: any) {
      error(sendResponseCallback, 500, e.message);
    }
  }
}

/**
 * POST /n2z/libraries — List all locally-synced libraries (user + groups) with their collection trees
 */
class LibrariesEndpoint {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];
  permitBookmarklet = false;

  init(_urlObj: any, _data: any, sendResponseCallback: Function) {
    try {
      const tree = getAllLibrariesTree();
      success(sendResponseCallback, tree);
    } catch (e: any) {
      error(sendResponseCallback, 500, e.message);
    }
  }
}

/**
 * POST /n2z/tags — List all tags in a library
 * Body: { libraryId?: number }
 */
class TagsEndpoint {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];
  permitBookmarklet = false;

  async init(_urlObj: any, data: any, sendResponseCallback: Function) {
    try {
      const body = typeof data === "string" ? JSON.parse(data) : data;
      ztoolkit.log(
        `[n2z] /n2z/tags requested for libraryId=${body?.libraryId}`,
      );
      const tags = await getTagsForLibrary(body?.libraryId);
      ztoolkit.log(`[n2z] /n2z/tags returning ${tags.length} tag(s)`);
      success(sendResponseCallback, tags);
    } catch (e: any) {
      ztoolkit.log(`[n2z] /n2z/tags error: ${e.message}`);
      error(sendResponseCallback, 500, e.message);
    }
  }
}

/**
 * POST /n2z/list — List exportable items from a collection or by tag across a library
 * Body: { collectionId: number } | { libraryId: number, tag: string }
 */
class ListEndpoint {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];
  permitBookmarklet = false;

  async init(_urlObj: any, data: any, sendResponseCallback: Function) {
    try {
      const body = typeof data === "string" ? JSON.parse(data) : data;
      let items;
      if (body?.tag && body?.libraryId != null) {
        items = await getExportableItemsByTag(body.libraryId, body.tag);
      } else if (body?.collectionId) {
        items = await getExportableItems(body.collectionId, {
          tag: body.tag,
        });
      } else {
        error(
          sendResponseCallback,
          400,
          "Either collectionId or (libraryId + tag) is required",
        );
        return;
      }
      success(sendResponseCallback, items);
    } catch (e: any) {
      error(sendResponseCallback, 500, e.message);
    }
  }
}

/**
 * POST /n2z/file — Serve a single attachment as base64
 * Body: { attachmentId: number }
 */
class FileEndpoint {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];
  permitBookmarklet = false;

  async init(_urlObj: any, data: any, sendResponseCallback: Function) {
    try {
      const body = typeof data === "string" ? JSON.parse(data) : data;
      if (!body?.attachmentId) {
        error(sendResponseCallback, 400, "attachmentId is required");
        return;
      }

      // Check max file size preference
      const maxSizeMB =
        (Zotero.Prefs.get(
          `${addon.data.config.prefsPrefix}.maxFileSize`,
          true,
        ) as number) || 200;

      const fileData = await getFileAsBase64(body.attachmentId);
      const fileSizeMB = fileData.fileSize / (1024 * 1024);
      if (fileSizeMB > maxSizeMB) {
        error(
          sendResponseCallback,
          413,
          `File size (${fileSizeMB.toFixed(1)}MB) exceeds maximum (${maxSizeMB}MB)`,
        );
        return;
      }

      success(sendResponseCallback, fileData);
    } catch (e: any) {
      error(sendResponseCallback, 500, e.message);
    }
  }
}

/**
 * POST /n2z/mapping — Get or set collection-notebook mappings
 * Body: { action: "get" | "getAll" | "set" | "remove", ...params }
 */
class MappingEndpoint {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];
  permitBookmarklet = false;

  init(_urlObj: any, data: any, sendResponseCallback: Function) {
    try {
      const body = typeof data === "string" ? JSON.parse(data) : data;

      switch (body?.action) {
        case "getAll":
          success(sendResponseCallback, getMappings());
          break;

        case "get":
          if (!body.collectionId) {
            error(sendResponseCallback, 400, "collectionId is required");
            return;
          }
          success(sendResponseCallback, getMapping(body.collectionId));
          break;

        case "set":
          if (!body.mapping) {
            error(sendResponseCallback, 400, "mapping object is required");
            return;
          }
          setMapping(body.mapping as CollectionMapping);
          success(sendResponseCallback);
          break;

        case "remove":
          if (!body.collectionId) {
            error(sendResponseCallback, 400, "collectionId is required");
            return;
          }
          removeMapping(body.collectionId);
          success(sendResponseCallback);
          break;

        default:
          error(
            sendResponseCallback,
            400,
            "Invalid action. Use: get, getAll, set, remove",
          );
      }
    } catch (e: any) {
      error(sendResponseCallback, 500, e.message);
    }
  }
}

/**
 * POST /n2z/import-notes — Receive notes from NotebookLM for backward sync
 * Body: ImportNotePayload | ImportNotePayload[]
 */
class ImportNotesEndpoint {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];
  permitBookmarklet = false;

  async init(_urlObj: any, data: any, sendResponseCallback: Function) {
    try {
      const body = typeof data === "string" ? JSON.parse(data) : data;

      if (Array.isArray(body)) {
        const results = await importNotes(body as ImportNotePayload[]);
        success(sendResponseCallback, results);
      } else {
        const result = await importNote(body as ImportNotePayload);
        success(sendResponseCallback, result);
      }
    } catch (e: any) {
      error(sendResponseCallback, 500, e.message);
    }
  }
}

/**
 * POST /n2z/debug — Debug endpoint to inspect collection items and attachments
 * Body: { collectionId: number }
 */
class DebugEndpoint {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];
  permitBookmarklet = false;

  async init(_urlObj: any, data: any, sendResponseCallback: Function) {
    try {
      const body = typeof data === "string" ? JSON.parse(data) : data;
      if (!body?.collectionId) {
        error(sendResponseCallback, 400, "collectionId is required");
        return;
      }
      const items = await debugCollectionItems(body.collectionId);
      success(sendResponseCallback, items);
    } catch (e: any) {
      error(sendResponseCallback, 500, e.message);
    }
  }
}

/**
 * POST /n2z/debug-collections — Raw collection data for debugging tree issues
 */
class DebugCollectionsEndpoint {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];
  permitBookmarklet = false;

  init(_urlObj: any, _data: any, sendResponseCallback: Function) {
    try {
      const libID = Zotero.Libraries.userLibraryID;
      const collections = Zotero.Collections.getByLibrary(libID);
      const raw = collections.map((col: any) => ({
        id: col.id,
        name: col.name,
        parentID: col.parentID,
        parentIDType: typeof col.parentID,
        childCollections: col.getChildCollections?.()?.length ?? "N/A",
      }));
      success(sendResponseCallback, raw);
    } catch (e: any) {
      error(sendResponseCallback, 500, e.message);
    }
  }
}

// Endpoint registry
const endpoints: Record<string, any> = {
  "/n2z/status": StatusEndpoint,
  "/n2z/libraries": LibrariesEndpoint,
  "/n2z/collections": CollectionsEndpoint,
  "/n2z/tags": TagsEndpoint,
  "/n2z/list": ListEndpoint,
  "/n2z/file": FileEndpoint,
  "/n2z/mapping": MappingEndpoint,
  "/n2z/import-notes": ImportNotesEndpoint,
  "/n2z/debug": DebugEndpoint,
  "/n2z/debug-collections": DebugCollectionsEndpoint,
};

/**
 * Register all HTTP endpoints on Zotero's server.
 */
export function registerServer(): void {
  for (const [path, EndpointClass] of Object.entries(endpoints)) {
    Zotero.Server.Endpoints[path] = EndpointClass;
  }
  ztoolkit.log("n2z HTTP endpoints registered");
}

/**
 * Unregister all HTTP endpoints.
 */
export function unregisterServer(): void {
  for (const path of Object.keys(endpoints)) {
    delete Zotero.Server.Endpoints[path];
  }
  ztoolkit.log("n2z HTTP endpoints unregistered");
}
