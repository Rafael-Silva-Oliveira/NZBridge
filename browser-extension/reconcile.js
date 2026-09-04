/**
 * Pure helpers for reconciling NZBridge's upload markers against a
 * NotebookLM notebook's live sources. No chrome.*, no DOM — so the prune
 * decision is unit-testable (test/reconcile.check.cjs).
 *
 * Loaded by the service worker via importScripts; also require-able in node.
 */

// Normalizes a URL for exact comparison between a Zotero item's URL and the
// domain= value NotebookLM encodes in a source's favicon. Drops the scheme,
// "www.", any trailing slash, and lowercases — so http/https and www variants
// of the same source URL compare equal.
function normalizeSourceUrl(u) {
  return String(u || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

// Normalizes a source label / filename for fuzzy comparison: lowercase,
// strip a trailing extension, collapse non-alphanumerics. Lets a stored
// upload name ("Qi et al. - 2022 - Prognostic.pdf") match the label
// NotebookLM renders for the same source even with minor formatting drift.
function normalizeSourceName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\.(pdf|html?|docx?|txt|md)$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Returns true if `stored` (an upload-time name) appears among the live
// NotebookLM source labels. NotebookLM truncates long labels in the DOM
// (e.g. "Qi et al. - 2022 - Prognostic Implications of Mo…"), so exact
// equality rarely holds for PDFs. Matching strategy, most to least strict:
//   1. normalized equality
//   2. either string is a prefix of the other (handles end-truncation)
//   3. one string fully contains the other (handles mid-truncation / icons)
//   4. strong leading-token overlap (handles "…" mid-cut where tails differ)
function nameStillPresent(stored, liveNormalized) {
  const n = normalizeSourceName(stored);
  if (!n) return false;
  const nTokens = n.split(" ").filter(Boolean);

  for (const live of liveNormalized) {
    if (!live) continue;
    if (live === n) return true;

    const shorter = n.length <= live.length ? n : live;
    const longer = n.length <= live.length ? live : n;
    if (
      shorter.length >= 6 &&
      (longer.startsWith(shorter) || longer.includes(shorter))
    ) {
      return true;
    }

    // Leading-token overlap: NotebookLM may cut mid-word, so compare the first
    // several whitespace tokens. Strong overlap on the prefix is a confident
    // match for academic filenames ("Author - Year - Title…").
    const liveTokens = live.split(" ").filter(Boolean);
    const cmp = Math.min(nTokens.length, liveTokens.length, 6);
    if (cmp >= 3) {
      let same = 0;
      for (let i = 0; i < cmp; i++) if (nTokens[i] === liveTokens[i]) same++;
      if (same >= 3 && same === cmp) return true;
    }
  }
  return false;
}

/**
 * Decides which upload markers are for sources that no longer exist in the
 * notebook. Identity-driven: a name-bearing marker is kept only when one of
 * its identifiers still matches a live source, checked strongest first:
 *   1. favicon domain / stored URL  → exact, stable id for URL sources
 *   2. exact label                  → exact untruncated name captured at sync
 *   3. exact `name` vs live label   → PDF filename == NotebookLM's PDF label
 *   4. fuzzy name                   → last-resort for truncated labels
 *
 * Rails — return NO prune keys when the live read can't be trusted:
 *   - zero rows and no count (or count > 0): panel unreadable / misread
 *   - rows < count: NotebookLM virtualizes the list; the read is partial,
 *     so absent-looking markers may simply be off-screen
 *
 * Legacy markers (a bare timestamp, no name/url) can't be identity-matched
 * and are never pruned here — they predate name capture; the "Reset sync
 * state" button is the escape hatch for those.
 *
 * @param {Object} registry   key → marker ({at, name, label, url, faviconDomain} | number)
 * @param {Array}  liveSources [{label, faviconDomain}]
 * @param {number|null} liveCount authoritative source count from the panel's
 *                        "N sources" text, or null when unavailable
 * @returns {string[]} keys to prune (empty = keep everything)
 */
function computePruneKeys(registry, liveSources, liveCount) {
  const keys = Object.keys(registry);
  const nameBearing = keys.filter((k) => {
    const e = registry[k];
    return (
      e &&
      typeof e === "object" &&
      (e.label || e.name || e.url || e.faviconDomain)
    );
  });
  if (nameBearing.length === 0) return [];

  // Partial/unreadable reads prune nothing.
  if (liveSources.length === 0 && (liveCount == null || liveCount > 0)) {
    return [];
  }
  if (liveCount != null && liveCount > liveSources.length) {
    return [];
  }

  const liveLabels = new Set(
    liveSources.map((s) => String(s.label || "").trim()).filter(Boolean),
  );
  const liveDomains = new Set(
    liveSources.map((s) => normalizeSourceUrl(s.faviconDomain)).filter(Boolean),
  );
  const liveNormalized = liveSources
    .map((s) => normalizeSourceName(s.label))
    .filter(Boolean);

  const stillPresent = (e) => {
    const dom = normalizeSourceUrl(e.faviconDomain || e.url);
    if (dom && liveDomains.has(dom)) return true;
    if (e.label && liveLabels.has(String(e.label).trim())) return true;
    if (e.name && liveLabels.has(String(e.name).trim())) return true;
    if (e.name) return nameStillPresent(e.name, liveNormalized);
    return false;
  };

  return nameBearing.filter((k) => !stillPresent(registry[k]));
}

// Node (test) export; ignored in the service worker.
if (typeof module !== "undefined") {
  module.exports = {
    normalizeSourceUrl,
    normalizeSourceName,
    nameStillPresent,
    computePruneKeys,
  };
}