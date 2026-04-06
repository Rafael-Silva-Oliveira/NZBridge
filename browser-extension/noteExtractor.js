/**
 * n2z Content Script — Backward Sync: Note Extraction from NotebookLM
 *
 * Scrapes saved notes, pinned notes, and chat responses from the NotebookLM UI.
 * Uses multiple selector strategies for resilience against UI changes.
 */

// Listen for extraction requests from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "n2z-extract-notes") {
    extractAllNotes()
      .then((notes) => sendResponse(notes))
      .catch((e) => {
        console.error("n2z: Note extraction failed:", e);
        sendResponse([]);
      });
    return true;
  }
});

/**
 * Extracts all available notes from the current NotebookLM notebook page.
 */
async function extractAllNotes() {
  const notes = [];

  // Extract saved/pinned notes
  const savedNotes = await extractSavedNotes();
  notes.push(...savedNotes);

  // Extract chat responses that have been saved
  const chatNotes = await extractSavedChatResponses();
  notes.push(...chatNotes);

  return notes;
}

/**
 * Extracts saved/pinned notes from the NotebookLM notes panel.
 */
async function extractSavedNotes() {
  const notes = [];

  // Try to find the notes panel / saved notes section
  // Multiple selector strategies for resilience
  const panelSelectors = [
    '[data-panel="notes"]',
    '[aria-label*="Notes" i]',
    '[aria-label*="Saved" i]',
    '.notes-panel',
    '.saved-notes',
  ];

  let notesPanel = null;
  for (const selector of panelSelectors) {
    notesPanel = document.querySelector(selector);
    if (notesPanel) break;
  }

  // Try clicking on "Notes" tab/button if panel not visible
  if (!notesPanel) {
    const tabButtons = document.querySelectorAll(
      '[role="tab"], button, [role="button"]',
    );
    for (const btn of tabButtons) {
      const text = (btn.textContent || "").toLowerCase().trim();
      if (text === "notes" || text === "saved notes" || text === "my notes") {
        btn.click();
        await sleep(1000);
        // Re-try finding the panel
        for (const selector of panelSelectors) {
          notesPanel = document.querySelector(selector);
          if (notesPanel) break;
        }
        break;
      }
    }
  }

  // Find note cards within the panel or the whole document
  const searchRoot = notesPanel || document;
  const noteCardSelectors = [
    '[data-type="note"]',
    '[class*="note-card"]',
    '[class*="NoteCard"]',
    '[class*="saved-note"]',
    '.note-item',
    '[role="article"]',
  ];

  let noteCards = [];
  for (const selector of noteCardSelectors) {
    noteCards = searchRoot.querySelectorAll(selector);
    if (noteCards.length > 0) break;
  }

  // Fallback: look for note-like structures with title + content
  if (noteCards.length === 0) {
    noteCards = findNotesByStructure(searchRoot);
  }

  for (const card of noteCards) {
    const note = extractNoteFromCard(card, "saved-note");
    if (note) {
      notes.push(note);
    }
  }

  return notes;
}

/**
 * Extracts saved chat responses (pinned messages).
 */
async function extractSavedChatResponses() {
  const notes = [];

  // Look for pinned/saved chat messages
  const pinnedSelectors = [
    '[data-pinned="true"]',
    '[class*="pinned"]',
    '[class*="saved-response"]',
    '[aria-label*="Pinned" i]',
  ];

  let pinnedItems = [];
  for (const selector of pinnedSelectors) {
    pinnedItems = document.querySelectorAll(selector);
    if (pinnedItems.length > 0) break;
  }

  for (const item of pinnedItems) {
    const note = extractNoteFromCard(item, "chat-response");
    if (note) {
      notes.push(note);
    }
  }

  return notes;
}

/**
 * Extracts note data from a DOM element (card/container).
 */
function extractNoteFromCard(element, type) {
  // Extract title
  const titleSelectors = [
    "h1",
    "h2",
    "h3",
    '[class*="title"]',
    '[class*="Title"]',
    '[role="heading"]',
    "strong:first-child",
  ];

  let title = "";
  for (const selector of titleSelectors) {
    const titleEl = element.querySelector(selector);
    if (titleEl) {
      title = titleEl.textContent.trim();
      break;
    }
  }

  // Extract content
  const contentSelectors = [
    '[class*="content"]',
    '[class*="Content"]',
    '[class*="body"]',
    '[class*="Body"]',
    "p",
    '[class*="text"]',
  ];

  let content = "";
  for (const selector of contentSelectors) {
    const contentEls = element.querySelectorAll(selector);
    if (contentEls.length > 0) {
      content = Array.from(contentEls)
        .map((el) => el.innerHTML)
        .join("");
      break;
    }
  }

  // Fallback: use entire element's innerHTML (stripped of title)
  if (!content && element.innerHTML) {
    content = element.innerHTML;
  }

  if (!title && !content) return null;

  // Generate a stable ID from content hash
  const id = generateNoteId(title + content);

  // Try to extract timestamp
  const timestamp = extractTimestamp(element);

  return {
    id,
    title: title || "Untitled Note",
    content,
    type,
    timestamp: timestamp || new Date().toISOString(),
    sourceReferences: extractSourceReferences(element),
  };
}

/**
 * Fallback: finds note-like structures based on DOM patterns.
 */
function findNotesByStructure(root) {
  const candidates = [];

  // Look for containers that have both a heading and content
  const containers = root.querySelectorAll("div, section, article");
  for (const container of containers) {
    const hasHeading = container.querySelector("h1, h2, h3, [role='heading']");
    const hasContent = container.querySelector("p, [class*='content']");
    const isSmallEnough = container.children.length < 20;
    const isLargeEnough = container.textContent.trim().length > 50;

    if (hasHeading && hasContent && isSmallEnough && isLargeEnough) {
      candidates.push(container);
    }
  }

  return candidates;
}

/**
 * Extracts source references (citations) from a note element.
 */
function extractSourceReferences(element) {
  const refs = [];
  const citationSelectors = [
    '[class*="citation"]',
    '[class*="Citation"]',
    '[class*="source-ref"]',
    '[class*="reference"]',
    "a[href*='source']",
    "sup",
  ];

  for (const selector of citationSelectors) {
    const citations = element.querySelectorAll(selector);
    for (const cite of citations) {
      refs.push(cite.textContent.trim());
    }
    if (refs.length > 0) break;
  }

  return refs;
}

/**
 * Tries to extract a timestamp from a note element.
 */
function extractTimestamp(element) {
  const timeSelectors = [
    "time",
    '[datetime]',
    '[class*="date"]',
    '[class*="time"]',
    '[class*="Date"]',
    '[class*="Time"]',
  ];

  for (const selector of timeSelectors) {
    const timeEl = element.querySelector(selector);
    if (timeEl) {
      return (
        timeEl.getAttribute("datetime") || timeEl.textContent.trim() || null
      );
    }
  }

  return null;
}

/**
 * Generates a stable ID from content using a simple hash.
 */
function generateNoteId(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return "nlm-note-" + Math.abs(hash).toString(36);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
