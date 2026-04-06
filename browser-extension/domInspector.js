/**
 * Temporary DOM inspector — run this via chrome.scripting.executeScript
 * on a NotebookLM page to discover the actual DOM structure for notes.
 *
 * Usage from extension console:
 *   chrome.tabs.query({url: "https://notebooklm.google.com/*"}, tabs => {
 *     chrome.scripting.executeScript({target: {tabId: tabs[0].id}, files: ["domInspector.js"]});
 *   });
 */

(function () {
  const results = {
    url: location.href,
    title: document.title,
    noteElements: [],
    ariaLabels: [],
    roleArticles: [],
    allTextBlocks: [],
  };

  // Find elements with note-related aria labels
  document.querySelectorAll("[aria-label]").forEach((el) => {
    const label = el.getAttribute("aria-label");
    if (
      label.toLowerCase().includes("note") ||
      label.toLowerCase().includes("save") ||
      label.toLowerCase().includes("pin")
    ) {
      results.ariaLabels.push({
        tag: el.tagName,
        ariaLabel: label,
        classes: el.className,
        text: el.textContent?.substring(0, 100),
        childCount: el.children.length,
      });
    }
  });

  // Find role="article" elements
  document.querySelectorAll('[role="article"]').forEach((el) => {
    results.roleArticles.push({
      tag: el.tagName,
      classes: el.className,
      text: el.textContent?.substring(0, 200),
      childCount: el.children.length,
    });
  });

  // Look for text blocks that contain note-like content (titles with timestamps)
  // The notes in the screenshot show: "Title\nExplainer · 1 source · 5d ago"
  document.querySelectorAll("*").forEach((el) => {
    const text = el.textContent?.trim() || "";
    if (
      text.length > 20 &&
      text.length < 500 &&
      (text.includes("ago") || text.includes("source")) &&
      el.children.length < 10
    ) {
      // Check if this is a leaf-ish container (not body/html/main)
      if (
        el.tagName !== "BODY" &&
        el.tagName !== "HTML" &&
        el.tagName !== "MAIN" &&
        !el.tagName.includes("APP")
      ) {
        results.allTextBlocks.push({
          tag: el.tagName,
          classes: el.className?.substring(0, 100),
          text: text.substring(0, 200),
          parentTag: el.parentElement?.tagName,
          parentClass: el.parentElement?.className?.substring(0, 80),
          childCount: el.children.length,
          dataset: JSON.stringify(el.dataset),
        });
      }
    }
  });

  console.log("=== N2Z DOM INSPECTOR RESULTS ===");
  console.log(JSON.stringify(results, null, 2));

  // Also copy to clipboard for easy extraction
  const output = JSON.stringify(results, null, 2);
  navigator.clipboard?.writeText(output);

  return results;
})();
