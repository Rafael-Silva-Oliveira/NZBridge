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
let exported = null;
sandbox.__export = (fn) => (exported = fn);

const src = fs.readFileSync(SRC, "utf8");
vm.runInNewContext(src + "\n;__export(makeItemBlock);", sandbox, {
  filename: "popup.js",
});
assert.strictEqual(typeof exported, "function", "makeItemBlock not exported");

// The group select-all checkboxes live inside #item-list too — the per-unit
// onchange wiring must stay scoped to item/sub-row checkboxes, or it clobbers
// the select-all handlers ("select all" silently stops selecting).
assert.ok(
  src.includes(
    '\u0027.item-row-main input[type="checkbox"], .item-subrow input[type="checkbox"]\u0027',
  ),
  "per-unit onchange wiring must be scoped (no bare #item-list input selector)",
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

const block = exported(item, new Set());

// Structure: block > row(div) > [main label (checkbox = default unit), toggle]
const row = block.children[0];
assert.ok(row.className.includes("item-row"));
assert.ok(row.className.includes("has-attachments"));

const main = row.children[0];
assert.ok(main.className.includes("item-row-main"));
assert.strictEqual(main.children[0].dataset.default, "1");
assert.strictEqual(main.children[0].dataset.unitId, "att-5");

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

// Expansion content: Main info row + one selectable row per extra
click(toggle);
assert.ok(subrows.children[0].className.includes("item-main-info"));
assert.ok(subrows.children[0].textContent.includes("main.pdf"));
const sub = subrows.children[1];
assert.ok(sub.className.includes("item-subrow"));
assert.strictEqual(sub.children[0].dataset.unitId, "att-6");
assert.strictEqual(sub.children[0].dataset.itemKey, "ITEMAA1");

// ─── Single-unit items stay plain (no toggle at all) ──────────────────
const single = exported(
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
  new Set(),
);
const singleRow = single.children[0];
assert.strictEqual(singleRow.children.length, 1, "no toggle for single-unit items");

console.log("popup-block.check: toggle expands/collapses, structure + selectors OK");