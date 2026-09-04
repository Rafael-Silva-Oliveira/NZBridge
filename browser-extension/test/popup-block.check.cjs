/**
 * Standalone sanity check for the popup's expandable item block
 * (issue #12 follow-up: the ▸ toggle must actually expand). No browser
 * needed:
 *
 *   node test/popup-block.check.cjs
 *
 * Loads browser-extension/popup/popup.js in a VM sandbox with a tiny DOM
 * shim, builds a multi-attachment item block, and drives the toggle's click
 * handler the way a user click would.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "..", "popup", "popup.js");

// ─── Minimal DOM shim (only what makeItemBlock touches) ───────────────
function makeEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    dataset: {},
    attrs: {},
    handlers: {},
    title: "",
    textContent: "",
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
  };
  // className ↔ classList stay in sync, like a real DOM element
  const classes = new Set();
  Object.defineProperty(el, "className", {
    get: () => [...classes].join(" "),
    set: (v) => {
      classes.clear();
      String(v)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classes.add(c));
    },
  });
  el.classList = {
    add(...c) {
      c.forEach((x) => classes.add(x));
    },
    remove(...c) {
      c.forEach((x) => classes.delete(x));
    },
    toggle(c, force) {
      const has = classes.has(c);
      const want = force === undefined ? !has : !!force;
      want ? classes.add(c) : classes.delete(c);
      return want;
    },
    contains(c) {
      return classes.has(c);
    },
  };
  return el;
}

function click(el) {
  assert.ok(el.handlers.click, "expected a click listener on the toggle");
  for (const fn of el.handlers.click) {
    fn({ preventDefault() {}, stopPropagation() {} });
  }
}

// ─── Load popup.js in a sandbox ───────────────────────────────────────
const sandbox = {
  document: { addEventListener() {}, createElement: makeEl },
  window: {},
  console,
};
const exportedFns = {};
sandbox.__export = (name, fn) => (exportedFns[name] = fn);

const src = fs.readFileSync(SRC, "utf8");
vm.runInNewContext(
  src +
    "\n;__export('makeItemBlock', makeItemBlock);__export('resolveUploadedUnits', resolveUploadedUnits);__export('preservedChecked', preservedChecked);",
  sandbox,
  {
    filename: "popup.js",
  },
);
const makeItemBlock = exportedFns.makeItemBlock;
const resolveUploadedUnits = exportedFns.resolveUploadedUnits;
const preservedChecked = exportedFns.preservedChecked;
assert.strictEqual(typeof makeItemBlock, "function", "makeItemBlock not exported");
assert.strictEqual(
  typeof resolveUploadedUnits,
  "function",
  "resolveUploadedUnits not exported",
);
assert.strictEqual(
  typeof preservedChecked,
  "function",
  "preservedChecked not exported",
);

// The group select-all checkboxes live inside #item-list too — the per-unit
// onchange wiring must stay scoped to item/sub-row checkboxes, or it clobbers
// the select-all handlers ("select all" silently stops selecting).
assert.ok(
  src.includes(
    '\u0027.item-row-main input[type="checkbox"], .item-subrow input[type="checkbox"]\u0027',
  ),
  "per-unit onchange wiring must be scoped (no bare #item-list input selector)",
);
// Selection keys must be EXPLICIT (itemKey::unitId, incl. the default) and
// scoped to .item-block — the bare-itemKey form let the background re-derive
// "the default" at sync time and upload a different file than the UI showed.
assert.ok(
  src.includes(
    "'#item-list .item-block input[type=\"checkbox\"]:checked'",
  ),
  "getSelectedUnits must be scoped to .item-block checkboxes",
);

// ─── Build a main + supplementary PDF item ────────────────────────────
const item = {
  itemKey: "ITEMAA1",
  title: "Paper One",
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
  ],
};

const block = makeItemBlock(item, new Map());

// Structure: block > row(div) > [main label + toggle]. For multi-attachment
// items the ITEM ROW carries no checkbox — the main attachment lives in the
// expanded list as a row of its own (the issue's request: every attachment
// shown like the non-main ones, main pre-ticked).
const row = block.children[0];
assert.ok(row.className.includes("item-row"));
assert.ok(row.className.includes("has-attachments"));

const main = row.children[0];
assert.ok(main.className.includes("item-row-main"));
// The main attachment has TWO synced checkboxes: the item-row one (visible
// when collapsed) and the expanded "Main ·" row. Both carry data-default.
assert.strictEqual(main.children[0].type, "checkbox");
assert.strictEqual(main.children[0].dataset.default, "1");
assert.strictEqual(main.children[0].dataset.unitId, "att-5");
assert.strictEqual(main.children[0].checked, true, "main checkbox defaults ON");
assert.ok(
  main.children[1].title.includes("Main attachment: main.pdf"),
  "main row tooltip names the main attachment file",
);

const toggle = row.children[1];
assert.ok(toggle.className.includes("item-attachments"), "toggle button present");
assert.strictEqual(toggle.children[0].className, "item-extra-count");
assert.strictEqual(toggle.children[0].textContent, "+1");
assert.strictEqual(toggle.children[1].className, "item-expander");

// THE regression: clicking the toggle must expand (used to throw because
// `subrows` was declared in a sibling block scope the handler couldn't see)
const subrows = block.children[1];
assert.ok(subrows.className.includes("item-subrows"));
click(toggle);
assert.ok(subrows.classList.contains("open"), "toggle must expand sub-rows");
assert.ok(toggle.classList.contains("open"), "toggle reflects open state");
click(toggle);
assert.ok(!subrows.classList.contains("open"), "second click collapses again");

// Expansion content: the MAIN attachment as a real checkbox row + extras
click(toggle);
const mainRow = subrows.children[0];
assert.ok(mainRow.className.includes("item-main-row"), "main is a row now");
assert.strictEqual(mainRow.children[0].dataset.default, "1");
assert.strictEqual(mainRow.children[0].dataset.unitId, "att-5");
assert.strictEqual(mainRow.children[0].dataset.itemKey, "ITEMAA1");
// Main checkbox defaults ON (user-requested) — and it's DE-SELECTABLE here,
// which was the whole point: untick the main without touching anything else.
assert.strictEqual(mainRow.children[0].checked, true, "main row defaults ON");
assert.ok(mainRow.children[1].textContent.includes("Main · main.pdf"));
assert.ok(
  mainRow.children[1].title.includes("Main attachment: main.pdf"),
  "Main row tooltip names the full file",
);
assert.ok(
  mainRow.children[1].title.includes("untick this"),
  "Main row tooltip explains how to skip the main attachment",
);
const sub = subrows.children[1];
assert.ok(sub.className.includes("item-subrow"));
assert.strictEqual(sub.children[0].dataset.unitId, "att-6");
assert.strictEqual(sub.children[0].dataset.itemKey, "ITEMAA1");
assert.strictEqual(sub.children[0].checked, false, "extras default OFF");
assert.ok(!sub.dataset || !sub.children[0].dataset.default, "extra is not a main");

// ─── Single-unit items stay plain (no toggle at all) ──────────────────
const single = makeItemBlock(
  {
    itemKey: "ITEMBB2",
    title: "Solo",
    exportType: "file",
    attachmentId: 9,
    attachmentTitle: "PDF",
    contentType: "application/pdf",
    filename: "solo.pdf",
    fileSize: 1,
    url: "",
    units: undefined, // legacy shape → single synthesized default unit
  },
  new Map(),
);
const singleRow = single.children[0];
assert.strictEqual(singleRow.children.length, 1, "no toggle for single-unit items");

// ─── Legacy wrong-file marker (issue #12 report) ──────────────────────
// NZBridge ≤ 0.4 stored ONE marker per item (bare itemKey) no matter which
// attachment was actually uploaded. A DOCX uploaded by 0.4 must show its ✓
// on the DOCX row — not pretend the main PDF is up — so the main stays
// selectable and the user can upload it.
{
  const multi = {
    ...item,
    units: [
      ...item.units,
      { unitId: "att-7", kind: "file", attachmentId: 7, title: "Supplement", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "supplement.docx", fileSize: 999, isDefault: false },
    ],
  };
  const markers = new Map([
    ["ITEMAA1", { at: 1700000000000, name: "supplement.docx" }], // v0.4 marker
  ]);

  // Resolution: the bare marker belongs to the DOCX unit, not the default.
  const resolved = resolveUploadedUnits(multi, markers);
  const docxUnit = multi.units.find((u) => u.unitId === "att-7");
  const mainUnit = multi.units.find((u) => u.isDefault);
  assert.ok(resolved.has(docxUnit), "legacy marker attributed to the DOCX unit");
  assert.ok(!resolved.has(mainUnit), "main PDF stays selectable");

  // Render: ✓ on the DOCX sub-row; item-row checkbox remains (main not
  // uploaded), pre-ticked, synced with the expanded Main row.
  const b2 = makeItemBlock(multi, markers);
  const r2 = b2.children[0];
  assert.strictEqual(
    r2.children[0].children[0].type,
    "checkbox",
    "item-row checkbox present while the main is not uploaded",
  );
  assert.strictEqual(
    r2.children[0].children[0].checked,
    true,
    "main checkbox defaults ON when the main is not uploaded",
  );
  const subs2 = b2.children[1];
  const docxMarkedRow = subs2.children.find(
    (s) => s.children[1] && /supplement/i.test(String(s.children[1].textContent)),
  );
  assert.ok(docxMarkedRow, "DOCX sub-row found");
  assert.ok(
    docxMarkedRow.className.includes("uploaded"),
    "the ✓ lands on the DOCX row",
  );
  assert.ok(
    docxMarkedRow.title.includes("supplement.docx"),
    "✓ tooltip names the actually-uploaded source",
  );
}

// Marker for the default unit (normal v0.5 case): main row shows ✓ with the
// uploaded source name in its tooltip.
{
  const markers = new Map([
    ["ITEMAA1", { at: 1700000000000, name: "main.pdf" }],
  ]);
  const resolved = resolveUploadedUnits(item, markers);
  assert.ok(resolved.has(item.units[0]), "default marker stays on the default");
  assert.ok(!resolved.has(item.units[1]), "extra stays selectable");

  const b3 = makeItemBlock(item, markers);
  const mainLabel = b3.children[0].children[0];
  assert.strictEqual(
    mainLabel.children[0].className,
    "item-check",
    "item row shows ✓ when its own marker exists",
  );
  assert.ok(
    mainLabel.title.includes("main.pdf"),
    "✓ tooltip names the uploaded source",
  );
  // The expanded Main row shows ✓ too (it's the same unit).
  const mainRow3 = b3.children[1].children[0];
  assert.strictEqual(
    mainRow3.className.includes("uploaded"),
    true,
    "expanded Main row is marked uploaded",
  );
  assert.ok(
    mainRow3.title.includes("main.pdf"),
    "expanded Main ✓ tooltip names the uploaded source",
  );
}

console.log("popup-block.check: toggle, structure, selection scoping, legacy markers OK");

// ─── Selection preservation across re-renders (user report) ───────────
// After a sync or "Check notebook" the popup re-renders; the user's tick
// state must be restored exactly, not reset to the all-mains default.
{
  sandbox.window._userSelection = null;
  assert.strictEqual(
    preservedChecked(item, item.units[0]),
    true,
    "no user interaction yet → main defaults ON",
  );
  assert.strictEqual(
    preservedChecked(item, item.units[1]),
    false,
    "no user interaction yet → extra defaults OFF",
  );

  sandbox.window._userSelection = new Set(["ITEMAA1::att-6"]); // user ticked ONLY the extra
  assert.strictEqual(
    preservedChecked(item, item.units[0]),
    false,
    "preserved selection: main stays unticked",
  );
  assert.strictEqual(
    preservedChecked(item, item.units[1]),
    true,
    "preserved selection: extra stays ticked",
  );
}