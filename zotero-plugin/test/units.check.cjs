/**
 * Standalone sanity check for the attachment-unit enumeration in
 * src/modules/collection.ts (issue #12 feature). No Zotero needed:
 *
 *   node test/units.check.cjs
 *
 * Not part of `npm test` (that runs inside Zotero via zotero-plugin test).
 * Transpiles collection.ts with the repo's esbuild and drives
 * getExportableItems() against a mocked Zotero environment.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const SRC = path.join(__dirname, "..", "src", "modules", "collection.ts");

async function main() {
  const ts = fs.readFileSync(SRC, "utf8");
  const { code } = esbuild.transformSync(ts, { loader: "ts", format: "esm" });
  const mod = await import(
    "data:text/javascript;base64," + Buffer.from(code).toString("base64")
  );

  // ─── Mock Zotero environment ───────────────────────────────────────
  const itemsById = new Map();
  const existsByPath = new Map();
  let collectionItems = [];

  globalThis.Zotero = {
    Collections: {
      get: () => ({ getChildItems: () => collectionItems }),
    },
    Items: { get: (id) => itemsById.get(id) ?? null },
  };
  globalThis.IOUtils = {
    exists: async (p) => existsByPath.get(p) === true,
    stat: async () => ({ size: 2048 }),
  };

  function att({
    id,
    title = "",
    contentType = "application/pdf",
    url = "",
    isFile = true,
    path = null,
    exists = true,
  }) {
    const a = {
      id,
      attachmentContentType: contentType,
      isFileAttachment: () => isFile,
      isImportedAttachment: () => isFile,
      isLinkedFileAttachment: () => false,
      isStoredFileAttachment: () => isFile,
      getField: (f) => (f === "title" ? title : f === "url" ? url : ""),
      getFilePathAsync: async () => path,
    };
    itemsById.set(id, a);
    if (path) existsByPath.set(path, exists);
    return a;
  }

  function item({ id, key, title, atts, best = null, fields = {} }) {
    const it = {
      id,
      key,
      itemType: "journalArticle",
      isRegularItem: () => true,
      getAttachments: () => atts.map((a) => a.id),
      getField: (f) => (f === "title" ? title : (fields[f] ?? "")),
      getTags: () => [],
      getBestAttachment: async () => best,
    };
    return it;
  }

  async function run(items) {
    collectionItems = items;
    return mod.getExportableItems(1);
  }

  // ─── T1: two PDFs, Zotero's best = the second → default is the best ──
  {
    const a1 = att({ id: 101, title: "Main PDF", path: "C:/lib/main.pdf" });
    const a2 = att({ id: 102, title: "SI", path: "C:/lib/si.pdf" });
    const res = await run([
      item({
        id: 11,
        key: "ITEMAA1",
        title: "Paper One",
        atts: [a1, a2],
        best: a2,
      }),
    ]);
    assert.strictEqual(res.length, 1);
    const it = res[0];
    assert.strictEqual(it.exportType, "file");
    // Top-level fields describe the DEFAULT unit (the best attachment)
    assert.strictEqual(it.attachmentId, 102);
    assert.strictEqual(it.filename, "si.pdf");
    assert.strictEqual(it.attachmentTitle, "SI");
    assert.strictEqual(it.fileSize, 2048);
    // units: default first, then the other file
    assert.strictEqual(it.units.length, 2);
    assert.ok(it.units[0].isDefault && !it.units[1].isDefault);
    assert.strictEqual(it.units[0].unitId, "att-102");
    assert.strictEqual(it.units[1].unitId, "att-101");
    assert.strictEqual(it.units[0].kind, "file");
    console.log("T1 ok — default = Zotero best attachment, units ordered");
  }

  // ─── T2: PDF + linked-URL attachment → link becomes a selectable unit ──
  {
    const a1 = att({ id: 201, path: "C:/lib/p.pdf" });
    const a2 = att({
      id: 202,
      title: "Publisher page",
      isFile: false,
      url: "https://nature.com/x",
    });
    const res = await run([
      item({
        id: 21,
        key: "ITEMAA2",
        title: "Paper Two",
        atts: [a1, a2],
        best: a1,
      }),
    ]);
    const it = res[0];
    assert.strictEqual(it.exportType, "file"); // still a PDF-group item
    assert.strictEqual(it.units.length, 2);
    const link = it.units[1];
    assert.strictEqual(link.kind, "url");
    assert.strictEqual(link.unitId, "att-202");
    assert.strictEqual(link.url, "https://nature.com/x");
    assert.strictEqual(link.title, "Publisher page");
    console.log("T2 ok — linked-URL attachment listed as url unit");
  }

  // ─── T3: URL item — ranking, dedupe, metadata URL adopts attachment id ──
  {
    const aA = att({
      id: 301,
      title: "Europe PMC",
      isFile: false,
      url: "https://europepmc.org/articles/x",
    });
    const res = await run([
      item({
        id: 31,
        key: "ITEMAA3",
        title: "Paper Three",
        atts: [aA],
        fields: {
          url: "https://europepmc.org/articles/x/", // same URL, trailing slash
          DOI: "10.1038/x",
          extra: "PMCID: PMC9",
        },
      }),
    ]);
    const it = res[0];
    assert.strictEqual(it.exportType, "url");
    // Ranked: europepmc (0) + pmc (0) ahead of doi.org (7); deduped to 3
    assert.strictEqual(it.units.length, 3);
    const d = it.units[0];
    assert.ok(d.isDefault);
    assert.strictEqual(d.url, "https://europepmc.org/articles/x/");
    // The metadata URL adopted the attachment's identity (stable att-<id> key)
    assert.strictEqual(d.unitId, "att-301");
    assert.ok(it.units.every((u) => u.kind === "url" && !u.filename));
    assert.ok(it.units[1].url.includes("pmc.ncbi.nlm.nih.gov"));
    assert.ok(it.units[2].url.includes("doi.org"));
    console.log(
      "T3 ok — URL candidates ranked/deduped, attachment identity adopted",
    );
  }

  // ─── T4: nothing exportable (zip only, no URLs) → item excluded ──
  {
    const a1 = att({
      id: 401,
      contentType: "application/zip",
      path: "C:/lib/d.zip",
    });
    const res = await run([
      item({ id: 41, key: "ITEMAA4", title: "Paper Four", atts: [a1] }),
    ]);
    assert.deepStrictEqual(res, []);
    console.log("T4 ok — non-exportable-only item excluded");
  }

  // ─── T5: best attachment is a non-exportable zip → default = the PDF ──
  {
    const a1 = att({
      id: 501,
      contentType: "application/zip",
      path: "C:/lib/d.zip",
    });
    const a2 = att({ id: 502, path: "C:/lib/p.pdf" });
    const res = await run([
      item({
        id: 51,
        key: "ITEMAA5",
        title: "Paper Five",
        atts: [a1, a2],
        best: a1,
      }),
    ]);
    const it = res[0];
    assert.strictEqual(it.attachmentId, 502);
    assert.strictEqual(it.units.length, 1); // single unit → no expander in UI
    assert.ok(it.units[0].isDefault);
    console.log(
      "T5 ok — non-exportable best attachment falls back to first file",
    );
  }

  // ─── T6: best attachment's file is missing on disk → fallback ──
  {
    const a1 = att({ id: 601, path: "C:/lib/missing.pdf", exists: false });
    const a2 = att({ id: 602, path: "C:/lib/present.pdf" });
    const res = await run([
      item({
        id: 61,
        key: "ITEMAA6",
        title: "Paper Six",
        atts: [a1, a2],
        best: a1,
      }),
    ]);
    assert.strictEqual(res[0].attachmentId, 602);
    assert.strictEqual(res[0].units.length, 1);
    console.log("T6 ok — missing best file falls back to existing file");
  }

  console.log("\nAll unit-enumeration checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
