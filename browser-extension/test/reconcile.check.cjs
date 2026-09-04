/**
 * Standalone sanity check for the reconcile prune decision in
 * reconcile.js (issue #12 follow-up). No chrome needed:
 *
 *   node test/reconcile.check.cjs
 *
 * Covers the reported bug: markers for sources deleted in NotebookLM were
 * never pruned (or pruned arbitrarily) because the old count-shortfall
 * heuristic compared marker count against the notebook's TOTAL source count.
 */

const assert = require("node:assert");
const path = require("node:path");
const {
  computePruneKeys,
  normalizeSourceUrl,
  nameStillPresent,
} = require(path.join(__dirname, "..", "reconcile.js"));

function marker(name, extra = {}) {
  return { at: Date.now(), name, ...extra };
}

// ─── computePruneKeys ────────────────────────────────────────────────

// 1. Deleted source is pruned even when the notebook has plenty of OTHER
//    sources (old heuristic: 12 live > 3 markers → shortfall ≤ 0 → kept).
{
  const registry = {
    ITEM1: marker("one.pdf"),
    ITEM2: marker("two.pdf"),
    ITEM3: marker("three.pdf"),
  };
  const live = [
    { label: "one.pdf", faviconDomain: null },
    { label: "three.pdf", faviconDomain: null },
    // + 10 unrelated manual sources → liveCount far above marker count
    ...Array.from({ length: 10 }, (_, i) => ({
      label: `manual source ${i}`,
      faviconDomain: `example${i}.com/somepage`,
    })),
  ];
  const prune = computePruneKeys(registry, live, live.length);
  assert.deepStrictEqual(prune, ["ITEM2"], "only the deleted source's marker is pruned");
}

// 2. Multiple deletions all pruned in one pass (old code capped at shortfall
//    and pruned insertion-order, which could clear the WRONG marker).
{
  const registry = {
    ITEM1: marker("one.pdf"),
    ITEM2: marker("two.pdf"),
    ITEM3: marker("three.pdf"),
  };
  const live = [{ label: "two.pdf", faviconDomain: null }];
  const prune = computePruneKeys(registry, live, 1);
  assert.deepStrictEqual(
    [...prune].sort(),
    ["ITEM1", "ITEM3"],
    "all absent markers pruned, independent of insertion order",
  );
}

// 3. Nothing deleted → nothing pruned (exact and fuzzy name matching hold).
{
  const registry = {
    ITEM1: marker("one.pdf", { label: "one.pdf" }),
    ITEM2: { at: Date.now(), url: "https://www.example.com/paper/" },
  };
  const live = [
    { label: "one.pdf", faviconDomain: null },
    { label: "Example.com — Paper page", faviconDomain: "https://example.com/paper" },
  ];
  const prune = computePruneKeys(registry, live, 2);
  assert.deepStrictEqual(prune, [], "present markers kept (exact label + URL domain)");
}

// 4. Legacy markers (bare timestamp) are never pruned — they predate name
//    capture; "Reset sync state" is their escape hatch.
{
  const registry = { LEGACY: 1700000000000, ITEM2: marker("two.pdf") };
  const live = [{ label: "gone-from-notebook.pdf", faviconDomain: null }];
  const prune = computePruneKeys(registry, live, 1);
  assert.deepStrictEqual(prune, ["ITEM2"], "legacy bare-timestamp marker kept");
}

// 5. Rails: partial read (rows < count, virtualized list) prunes nothing.
{
  const registry = { ITEM1: marker("one.pdf"), ITEM2: marker("two.pdf") };
  const rows = [{ label: "one.pdf", faviconDomain: null }]; // two.pdf off-screen
  const prune = computePruneKeys(registry, rows, 2);
  assert.deepStrictEqual(prune, [], "partial read → no prune");
}

// 6. Rail: unreadable/misread panel (zero rows, unknown or nonzero count).
{
  const registry = { ITEM1: marker("one.pdf") };
  assert.deepStrictEqual(computePruneKeys(registry, [], null), [], "0 rows + no count → no prune");
  assert.deepStrictEqual(computePruneKeys(registry, [], 5), [], "0 rows + count>0 → no prune");
}

// 7. Notebook genuinely emptied → everything pruned (count 0, 0 rows).
{
  const registry = { ITEM1: marker("one.pdf"), ITEM2: marker("two.pdf") };
  assert.deepStrictEqual(
    [...computePruneKeys(registry, [], 0)].sort(),
    ["ITEM1", "ITEM2"],
    "empty notebook → all markers pruned",
  );
}

// 8. Truncated NotebookLM label still counts as present (fuzzy match).
{
  const registry = {
    ITEM1: marker("Qi et al. - 2022 - Prognostic Implications of Molecular Subtypes.pdf"),
  };
  const live = [
    { label: "Qi et al. - 2022 - Prognostic Implications of Mo…", faviconDomain: null },
  ];
  const prune = computePruneKeys(registry, live, 1);
  assert.deepStrictEqual(prune, [], "truncated label → marker kept");
}

// 9. Sibling filenames (user report: main + secondary of the same paper):
//    deleting ONE sibling must clear only its own marker, even though the
//    survivor's label is a PREFIX of the deleted one — the old fuzzy matcher
//    treated both as the same source, so the deleted sibling stayed ✓.
{
  const registry = {
    M1: marker("Hamilton - 2024 - Overcoming resistance in small-cell lung cancer.pdf", {
      label: "Hamilton - 2024 - Overcoming resistance in small-cell lung cancer",
    }),
    M2: marker("Hamilton - 2024 - Overcoming resistance in small-cell lung cancer 1.pdf", {
      label: "Hamilton - 2024 - Overcoming resistance in small-cell lung cancer 1",
    }),
  };
  // Secondary deleted, main still in the notebook (label ≈ filename minus ext).
  const live = [{ label: "Hamilton - 2024 - Overcoming resistance in small-cell lung cancer", faviconDomain: null }];
  assert.deepStrictEqual(
    computePruneKeys(registry, live, 1),
    ["M2"],
    "deleted secondary pruned, main kept (no prefix cross-match)",
  );
  // Both still present → nothing pruned.
  const liveBoth = [
    { label: "Hamilton - 2024 - Overcoming resistance in small-cell lung cancer 1", faviconDomain: null },
    { label: "Hamilton - 2024 - Overcoming resistance in small-cell lung cancer", faviconDomain: null },
  ];
  assert.deepStrictEqual(computePruneKeys(registry, liveBoth, 2), []);
  // Main deleted, secondary alive → only the main's marker is pruned.
  const liveOnlySecondary = [
    { label: "Hamilton - 2024 - Overcoming resistance in small-cell lung cancer 1", faviconDomain: null },
  ];
  assert.deepStrictEqual(
    computePruneKeys(registry, liveOnlySecondary, 1),
    ["M1"],
    "deleted main pruned; secondary kept",
  );
}

// 10. Label-less legacy filename markers also resolve via normalized
//     comparison (NotebookLM metadata-title naming).
{
  const registry = { M1: marker("Smith - 2020 - Paper.pdf") };
  const live = [{ label: "Smith - 2020 - Paper", faviconDomain: null }];
  assert.deepStrictEqual(
    computePruneKeys(registry, live, 1),
    [],
    "filename vs metadata-title label matches normalized",
  );
}

// 11. Mid-ingestion protection: while the notebook is busy, markers uploaded
//     within the skip window are kept (their source may show a placeholder
//     label), but older deletions prune normally.
{
  const now = Date.now();
  const registry = {
    M_NEW: { at: now - 10_000, name: "new.pdf", label: "new.pdf" },
    M_OLD: { at: now - 600_000, name: "old.pdf", label: "old.pdf" },
  };
  // new.pdf is still ingesting — NotebookLM shows a placeholder row; old.pdf
  // was deleted by the user.
  const live = [{ label: "Processing…", faviconDomain: null }];
  const prune = computePruneKeys(registry, live, 1, { skipRecentMs: 60_000 });
  assert.deepStrictEqual(
    prune,
    ["M_OLD"],
    "recent upload protected while busy; old deletion pruned",
  );
  // Without the busy flag the same read prunes both (old behavior).
  assert.deepStrictEqual(
    [...computePruneKeys(registry, live, 1)].sort(),
    ["M_NEW", "M_OLD"],
  );
}

// ─── helpers (regression: moved from background.js, must behave the same) ──

assert.strictEqual(
  normalizeSourceUrl("https://www.Example.com/paper/"),
  "example.com/paper",
  "URL normalization: scheme/www/trailing-slash/case",
);
assert.strictEqual(
  nameStillPresent("Smith - 2020 - Paper.pdf", [
    "smith 2020 paper",
  ]),
  true,
  "fuzzy name match survives extension strip + punctuation collapse",
);
assert.strictEqual(
  nameStillPresent("Smith - 2020 - Paper.pdf", ["jones 2019 other"]),
  false,
  "fuzzy name match does not hit unrelated labels",
);

console.log("reconcile.check: all scenarios passed");