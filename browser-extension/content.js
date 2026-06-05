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
  const addSourceLabels = [
    "add source", "add sources", "add a source",
    "添加来源", "添加源", "新增来源", "加入来源",
    "添加來源", "新增來源", "加入來源",
    "ソースを追加", "情報源を追加",
    "소스 추가", "출처 추가",
    "añadir fuente", "añadir fuentes", "agregar fuente", "agregar fuentes",
    "ajouter une source", "ajouter des sources",
    "quelle hinzufügen", "quellen hinzufügen",
    "adicionar fonte", "adicionar fontes",
    "aggiungi fonte", "aggiungi fonti",
    "bron toevoegen", "bronnen toevoegen",
    "tambahkan sumber",
  ];
  const uploadLabels = [
    "upload files", "upload file", "upload",
    "上传文件", "上传", "上傳檔案", "上傳文件", "上傳",
    "ファイルをアップロード", "アップロード",
    "파일 업로드", "업로드",
    "subir archivos", "subir archivo", "subir",
    "téléverser des fichiers", "téléverser", "importer des fichiers",
    "dateien hochladen", "datei hochladen", "hochladen",
    "carregar arquivos", "carregar ficheiros", "carregar",
    "carica file", "carica",
    "bestanden uploaden", "uploaden",
    "unggah file", "unggah",
  ];
  const hasAny = (text, labels) => labels.some((label) => text.includes(label));

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
    '[aria-label*="添加来源" i]',
    '[aria-label*="上传" i]',
    '[aria-label*="新增來源" i]',
    '[aria-label*="上傳" i]',
    '[aria-label*="ソースを追加" i]',
    '[aria-label*="アップロード" i]',
    '[aria-label*="소스 추가" i]',
    '[aria-label*="업로드" i]',
    '[aria-label*="añadir fuente" i]',
    '[aria-label*="subir" i]',
    '[aria-label*="ajouter" i]',
    '[aria-label*="téléverser" i]',
    '[aria-label*="hinzufügen" i]',
    '[aria-label*="hochladen" i]',
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
      hasAny(text, addSourceLabels) ||
      hasAny(text, uploadLabels) ||
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
    if (hasAny(text, uploadLabels) || text.includes("file") || text.includes("文件") || text.includes("檔案")) {
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
      "Could not find the upload dialog. Please open the Add Source/添加来源 dialog manually.",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
