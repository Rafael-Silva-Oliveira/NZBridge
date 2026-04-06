/**
 * n2z Content Script — Forward Sync UI Automation
 *
 * Runs on notebooklm.google.com to prepare the page for file injection.
 * Handles opening the "Add Source" dialog and locating the file upload input.
 */

// Listen for messages from the background service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "n2z-ping") {
    sendResponse({ alive: true });
    return;
  }
  if (message.type === "n2z-prepare-upload") {
    prepareUploadDialog()
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }
});

/**
 * Attempts to open the "Add Source" upload dialog in NotebookLM.
 * Uses multiple selector strategies for resilience.
 */
async function prepareUploadDialog() {
  // Strategy 1: Look for an existing file input
  let fileInput = document.querySelector('input[type="file"]');
  if (fileInput) {
    return { success: true, method: "existing-input" };
  }

  // Strategy 2: Find and click the "Add source" / "Upload" button
  const buttonSelectors = [
    // Aria labels
    '[aria-label*="Add source" i]',
    '[aria-label*="Upload" i]',
    '[aria-label*="add source" i]',
    // Data attributes
    '[data-action*="upload" i]',
    '[data-action*="add-source" i]',
  ];

  for (const selector of buttonSelectors) {
    const btn = document.querySelector(selector);
    if (btn) {
      btn.click();
      await sleep(800);
      fileInput = document.querySelector('input[type="file"]');
      if (fileInput) {
        return { success: true, method: "button-click:" + selector };
      }
    }
  }

  // Strategy 3: Text-based button search
  const allButtons = document.querySelectorAll(
    'button, [role="button"], [tabindex="0"]',
  );
  for (const btn of allButtons) {
    const text = (btn.textContent || "").toLowerCase().trim();
    if (
      text.includes("add source") ||
      text.includes("upload") ||
      text === "+" ||
      text.includes("add a source")
    ) {
      btn.click();
      await sleep(800);
      fileInput = document.querySelector('input[type="file"]');
      if (fileInput) {
        return { success: true, method: "text-search" };
      }
    }
  }

  // Strategy 4: Look for the upload option in a dialog/menu that may have opened
  const uploadOptions = document.querySelectorAll(
    '[role="menuitem"], [role="option"], .mat-mdc-menu-item',
  );
  for (const opt of uploadOptions) {
    const text = (opt.textContent || "").toLowerCase();
    if (text.includes("upload") || text.includes("file")) {
      opt.click();
      await sleep(800);
      fileInput = document.querySelector('input[type="file"]');
      if (fileInput) {
        return { success: true, method: "menu-option" };
      }
    }
  }

  return {
    success: false,
    error:
      "Could not find the upload dialog. Please open the Add Source dialog manually.",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
