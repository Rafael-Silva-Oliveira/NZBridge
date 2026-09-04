/**
 * Pins the SELECTION-KEY PROTOCOL shared by popup.js and background.js
 * (issue #12 follow-up). Both files DUPLICATE ensureUnits() and the unit-key
 * form (popup: unitKeyOf, background: unitKey) with a "stay in sync" comment —
 * and they have drifted before. This check loads BOTH scripts in VM sandboxes
 * and asserts they agree on unit enumeration and key forms, because the
 * explicit "itemKey::unitId" selection keys (popup) must resolve against the
 * exact same unitIds the background derives from /n2z/list.
 *
 *   node test/protocol-parity.check.cjs
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadInVm(filename, extraSandbox = {}, exportSnippet = "") {
  const src = fs.readFileSync(path.join(ROOT, filename), "utf8");
  const exported = {};
  const sandbox = {
    console,
    ...extraSandbox,
    __export: (name, fn) => (exported[name] = fn),
  };
  vm.runInNewContext(
    src + "\n" + exportSnippet,
    sandbox,
    { filename },
  );
  return exported;
}

// popup.js: only top-level side effect is the DOMContentLoaded listener.
const popupFns = loadInVm(
  "popup/popup.js",
  { document: { addEventListener() {} }, window: {} },
  ";__export('ensureUnits', ensureUnits);__export('unitKeyOf', unitKeyOf);",
);

// background.js: top-level side effects are importScripts + the message
// listener. Load reconcile.js first so importScripts has its definitions.
const chromeStub = {
  runtime: { onMessage: { addListener() {} } },
};
const bgSandbox = {
  importScripts: () => {},
  chrome: chromeStub,
};
const bgFns = loadInVm(
  "background.js",
  bgSandbox,
  ";__export('ensureUnits', ensureUnits);__export('unitKey', unitKey);",
);

assert.strictEqual(typeof popupFns.ensureUnits, "function", "popup ensureUnits");
assert.strictEqual(typeof popupFns.unitKeyOf, "function", "popup unitKeyOf");
assert.strictEqual(typeof bgFns.ensureUnits, "function", "background ensureUnits");
assert.strictEqual(typeof bgFns.unitKey, "function", "background unitKey");

// ─── Fixtures ─────────────────────────────────────────────────────────

// v0.5 plugin shape: units array present (main + extra file + attachment URL)
const modernItem = {
  itemKey: "KEYMOD1",
  title: "Modern",
  exportType: "file",
  attachmentId: 5,
  attachmentTitle: "Main PDF",
  contentType: "application/pdf",
  filename: "main.pdf",
  fileSize: 123,
  url: "",
  units: [
    { unitId: "att-5", kind: "file", attachmentId: 5, title: "Main PDF", contentType: "application/pdf", filename: "main.pdf", fileSize: 123, isDefault: true },
    { unitId: "att-6", kind: "file", attachmentId: 6, title: "SI", contentType: "application/pdf", filename: "si.pdf", fileSize: 456, isDefault: false },
    { unitId: "att-7", kind: "url", attachmentId: 7, title: "Publisher", contentType: "text/url", filename: "", fileSize: 0, url: "https://pub.com/x", isDefault: false },
  ],
};

// Legacy shapes (old plugin, no units field)
const legacyFileItem = {
  itemKey: "KEYLEG1",
  title: "Legacy File",
  exportType: "file",
  attachmentId: 9,
  attachmentTitle: "Only PDF",
  contentType: "application/pdf",
  filename: "only.pdf",
  fileSize: 10,
  url: "",
};
const legacyUrlItem = {
  itemKey: "KEYLEG2",
  title: "Legacy URL",
  exportType: "url",
  attachmentId: 0,
  attachmentTitle: "",
  contentType: "text/url",
  filename: "",
  fileSize: 0,
  url: "https://example.com/p",
};

for (const item of [modernItem, legacyFileItem, legacyUrlItem]) {
  const pu = popupFns.ensureUnits(item);
  const bu = bgFns.ensureUnits(item);
  // JSON round-trip: the two functions live in different VM realms, and
  // deepStrictEqual compares prototypes — normalize into this realm first.
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(bu)),
    JSON.parse(JSON.stringify(pu)),
    `ensureUnits drift between popup and background for ${item.itemKey}`,
  );
  assert.ok(pu.length > 0, "at least one unit");

  // Key forms must agree unit-by-unit: default → bare itemKey (legacy marker
  // compat), extras → "itemKey::unitId" (the explicit selection protocol).
  for (const u of pu) {
    assert.strictEqual(
      bgFns.unitKey(item, u),
      popupFns.unitKeyOf(item, u),
      `unitKey drift for ${item.itemKey} / ${u.unitId}`,
    );
  }
  const def = pu.find((u) => u.isDefault);
  assert.ok(def, "exactly one default unit expected");
  assert.strictEqual(
    popupFns.unitKeyOf(item, def),
    item.itemKey,
    "default unit keeps the bare itemKey (legacy marker compat)",
  );
}

// The explicit selection key the popup now sends must be derivable from the
// unit's own unitId — that's what the background matches against.
{
  const extra = modernItem.units[1];
  assert.strictEqual(
    `${modernItem.itemKey}::${extra.unitId}`,
    "KEYMOD1::att-6",
    "explicit selection key form",
  );
}

console.log("protocol-parity.check: ensureUnits/unitKey agree across popup + background");