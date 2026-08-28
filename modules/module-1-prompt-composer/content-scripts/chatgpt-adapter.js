// Edge Studio — ChatGPT page adapter (content script)
// Covers: M1-8 (injection engine), M2-1/M2-2 (response + selection capture)
//
// ChatGPT's input has changed shape more than once (plain textarea,
// then a contenteditable div). This uses a multi-strategy approach and
// should be expected to need small updates whenever OpenAI changes
// their DOM — that ongoing maintenance is the accepted tradeoff of the
// screen-scraping approach documented in the spec (§7).

function findChatGptInput() {
  // Current ChatGPT UI: contenteditable div, typically id="prompt-textarea"
  const editableDiv = document.querySelector(
    '#prompt-textarea, div[contenteditable="true"]'
  );
  if (editableDiv) return { el: editableDiv, kind: 'contenteditable' };

  // Older/alternate UI: plain textarea
  const textarea = document.querySelector('textarea');
  if (textarea) return { el: textarea, kind: 'textarea' };

  return null;
}

function insertIntoContentEditable(el, text) {
  el.focus();
  // execCommand is deprecated but remains the most reliable
  // cross-browser way to insert text into a contenteditable element
  // such that the host page's own React state picks up the change
  // correctly (a plain innerText assignment does not).
  document.execCommand('selectAll', false, undefined);
  document.execCommand('insertText', false, text);
}

function insertIntoTextarea(el, text) {
  // React-controlled inputs ignore a plain `.value =` assignment
  // because it bypasses React's own setter. Using the native
  // HTMLTextAreaElement setter and firing an 'input' event tricks
  // React into picking up the change as if the user had typed it.
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  ).set;
  nativeSetter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function injectPrompt(text) {
  const target = findChatGptInput();
  if (!target) {
    return {
      success: false,
      reason: 'Could not find a ChatGPT input field on this page.',
    };
  }

  try {
    if (target.kind === 'contenteditable') {
      insertIntoContentEditable(target.el, text);
    } else {
      insertIntoTextarea(target.el, text);
    }
    target.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return { success: true };
  } catch (error) {
    return { success: false, reason: error.message };
  }
}

// --- M2-1 / M2-2: Response and selection capture ---
//
// Reading responses back out has the same DOM-fragility as writing them
// in, and the same escape hatch: if OpenAI changes their markup, these
// two selector lists are what need updating. Both fall back to the
// generic conversation-turn container, which has survived more redesigns
// than the message-level attributes.

function findAssistantTurns() {
  const byRole = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (byRole.length) return [...byRole];

  // Fallback: whole conversation turns. Assistant turns are the
  // even-indexed ones in a normal alternating transcript, but rather
  // than assume that, take every turn that isn't marked as the user's.
  const turns = [...document.querySelectorAll('article[data-testid^="conversation-turn-"]')];
  return turns.filter((t) => !t.querySelector('[data-message-author-role="user"]'));
}

function captureLatestResponse() {
  const turns = findAssistantTurns();
  if (turns.length === 0) {
    return {
      success: false,
      reason: 'No assistant response found on this page yet.',
    };
  }

  const text = (turns[turns.length - 1].innerText || '').trim();
  if (!text) {
    return { success: false, reason: 'The latest response looks empty.' };
  }

  return {
    success: true,
    text,
    url: location.href,
    pageTitle: document.title,
    responseCount: turns.length,
  };
}

function captureSelection() {
  // Reads whatever Dan has highlighted in the page — this is what makes
  // "save just this section" (M2-2) work without building a selection UI
  // of our own.
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : '';
  if (!text) {
    return { success: false, reason: 'Nothing is selected in that tab.' };
  }

  return {
    success: true,
    text,
    url: location.href,
    pageTitle: document.title,
  };
}

// The background worker may inject this file programmatically into a tab
// that was already open before the extension loaded. If the manifest
// content script did run after all, that would register a second
// listener on the same page and both would answer the same message, so
// guard against registering twice.
if (!window.__edgeStudioAdapterListenerRegistered) {
  window.__edgeStudioAdapterListenerRegistered = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EDGE_STUDIO_INJECT_PROMPT') {
      sendResponse(injectPrompt(message.text));
    }

    if (message.type === 'EDGE_STUDIO_CAPTURE_RESPONSE') {
      sendResponse(captureLatestResponse());
    }

    if (message.type === 'EDGE_STUDIO_CAPTURE_SELECTION') {
      sendResponse(captureSelection());
    }
  });
}
