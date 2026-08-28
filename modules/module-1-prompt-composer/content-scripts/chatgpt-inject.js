// Far Edge Studio — ChatGPT injection content script
// Covers: M1-8 (injection engine)
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

// The background worker may inject this file programmatically into a tab
// that was already open before the extension loaded. If the manifest
// content script did run after all, that would register a second
// listener on the same page and both would answer the same message, so
// guard against registering twice.
if (!window.__farEdgeInjectListenerRegistered) {
  window.__farEdgeInjectListenerRegistered = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'FAR_EDGE_INJECT_PROMPT') {
      sendResponse(injectPrompt(message.text));
    }
  });
}
