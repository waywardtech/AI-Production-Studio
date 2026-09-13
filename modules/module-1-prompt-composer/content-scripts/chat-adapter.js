// Edge Studio — chat page adapter (content script)
// Covers: M1-8 (injection), M1.5-4/M1.5-5 (Claude + Gemini adapters),
//         M2-1/M2-2 (response + selection capture),
//         M1-10/M1.5-8 (best-effort usage scrape)
//
// One adapter for all three platforms rather than three near-identical
// files: the message plumbing and the insertion strategies are the
// same everywhere, and only the selectors differ. Those live in
// PLATFORMS below, which is the single place a redesign lands.
//
// This is the accepted screen-scraping tradeoff documented in the spec
// (§8). The selector lists are ordered most-specific first and fall
// back to generic structure, so a renamed test id degrades to "still
// works via the contenteditable fallback" rather than "broken".

const PLATFORMS = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    inputSelectors: ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea'],
    assistantSelectors: ['[data-message-author-role="assistant"]'],
    // Whole conversation turns, minus the ones marked as the user's.
    assistantFallback: () =>
      [...document.querySelectorAll('article[data-testid^="conversation-turn-"]')].filter(
        (turn) => !turn.querySelector('[data-message-author-role="user"]')
      ),
  },
  {
    id: 'claude',
    label: 'Claude',
    hosts: ['claude.ai'],
    // Claude's composer is a ProseMirror contenteditable.
    inputSelectors: [
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"]',
      'textarea',
    ],
    assistantSelectors: [
      '[data-testid="assistant-message"]',
      '.font-claude-message',
      'div[data-is-streaming]',
    ],
    assistantFallback: null,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    hosts: ['gemini.google.com'],
    // Gemini's composer is a Quill editor inside <rich-textarea>.
    inputSelectors: [
      'rich-textarea .ql-editor',
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"]',
      'textarea',
    ],
    assistantSelectors: ['model-response', 'message-content.model-response-text', '.model-response-text'],
    assistantFallback: null,
  },

  // Generator pages. They take a prompt but there's no conversation to
  // read back, so they're only ever an Insert / Produce destination —
  // never somewhere Optimize, Fill blanks or Refine can run. Their input
  // selectors are generic and unverified against the live sites; if
  // nothing is found, Insert falls back to the clipboard as usual.
  {
    id: 'sora',
    label: 'Sora',
    kind: 'generator',
    hosts: ['sora.chatgpt.com'],
    inputSelectors: ['textarea', 'div[contenteditable="true"]'],
    assistantSelectors: [],
    assistantFallback: null,
  },
  {
    id: 'flow',
    label: 'Flow',
    kind: 'generator',
    hosts: ['labs.google'],
    inputSelectors: ['textarea', 'div[contenteditable="true"]'],
    assistantSelectors: [],
    assistantFallback: null,
  },
];

// An exact host wins over a parent-domain match: sora.chatgpt.com is
// Sora, not ChatGPT, even though it sits under chatgpt.com.
function currentPlatform() {
  const host = location.hostname.replace(/^www\./, '');
  return (
    PLATFORMS.find((p) => p.hosts.includes(host)) ||
    PLATFORMS.find((p) => p.hosts.some((h) => host.endsWith(`.${h}`))) ||
    null
  );
}

// ---------- M1-8 / M1.5-4 / M1.5-5: injection ----------

function findInput(platform) {
  for (const selector of platform.inputSelectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const kind = el.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable';
    return { el, kind };
  }
  return null;
}

function insertIntoContentEditable(el, text) {
  el.focus();
  // execCommand is deprecated but remains the most reliable way to put
  // text into a contenteditable such that the host page's own editor
  // state picks the change up — true for ChatGPT's editor, Claude's
  // ProseMirror and Gemini's Quill alike. Assigning innerText does not.
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
  const platform = currentPlatform();
  if (!platform) {
    return { success: false, reason: 'Edge Studio does not handle this site.' };
  }

  const target = findInput(platform);
  if (!target) {
    return {
      success: false,
      reason: `Could not find the ${platform.label} input field on this page.`,
    };
  }

  try {
    if (target.kind === 'contenteditable') insertIntoContentEditable(target.el, text);
    else insertIntoTextarea(target.el, text);
    target.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return { success: true, platform: platform.id, platformLabel: platform.label };
  } catch (error) {
    return { success: false, reason: error.message };
  }
}

// ---------- M2-1 / M2-2: response and selection capture ----------

function findAssistantTurns(platform) {
  for (const selector of platform.assistantSelectors) {
    const found = document.querySelectorAll(selector);
    if (found.length) return [...found];
  }
  return platform.assistantFallback ? platform.assistantFallback() : [];
}

function captureLatestResponse() {
  const platform = currentPlatform();
  if (!platform) {
    return { success: false, reason: 'Edge Studio does not handle this site.' };
  }

  if (platform.kind === 'generator') {
    return {
      success: false,
      reason: `${platform.label} is a generator page — there's no reply there to capture.`,
    };
  }

  const turns = findAssistantTurns(platform);
  if (turns.length === 0) {
    return {
      success: false,
      reason: `No ${platform.label} reply found on this page yet.`,
    };
  }

  const text = (turns[turns.length - 1].innerText || '').trim();
  if (!text) {
    return { success: false, reason: 'The latest reply looks empty.' };
  }

  return {
    success: true,
    text,
    url: location.href,
    pageTitle: document.title,
    platform: platform.id,
    platformLabel: platform.label,
    responseCount: turns.length,
  };
}

function captureSelection() {
  const platform = currentPlatform();
  // Reads whatever Dan has highlighted in the page — this is what makes
  // "save just this section" (M2-2) work without building a selection
  // UI of our own.
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
    platform: platform?.id || null,
    platformLabel: platform?.label || null,
  };
}

// ---------- M1-10 / M1.5-8: best-effort usage scrape ----------
//
// None of these platforms publishes a usage API, and none of them
// reliably renders a quota either — what's on screen depends on plan,
// model and how close to a limit you are. So this looks for the
// phrasings they use *when* they show something, and returns a plain
// "nothing here" the rest of the time. Manual entry in the Usage tab is
// the primary path; this is a convenience on top of it.

const USAGE_PATTERNS = [
  // "12 messages remaining", "3 prompts left"
  {
    re: /(\d[\d,]*)\s+(?:messages?|prompts?|requests?)\s+(?:remaining|left)/i,
    read: (m) => ({ remaining: num(m[1]) }),
  },
  // "12 of 40 messages", "12/40 messages"
  {
    re: /(\d[\d,]*)\s*(?:of|\/)\s*(\d[\d,]*)\s+(?:messages?|prompts?|requests?)/i,
    read: (m) => ({ used: num(m[1]), limit: num(m[2]) }),
  },
  // "You've used 18 of your 40 messages"
  {
    re: /used\s+(\d[\d,]*)\s+of\s+(?:your\s+)?(\d[\d,]*)/i,
    read: (m) => ({ used: num(m[1]), limit: num(m[2]) }),
  },
];

function num(raw) {
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function captureUsage() {
  const platform = currentPlatform();
  if (!platform) {
    return { success: false, reason: 'Edge Studio does not handle this site.' };
  }

  // Scan visible text only. innerText already skips hidden nodes, which
  // keeps this away from markup that isn't actually on screen.
  const haystack = (document.body?.innerText || '').slice(0, 20000);

  for (const pattern of USAGE_PATTERNS) {
    const match = haystack.match(pattern.re);
    if (!match) continue;

    const read = pattern.read(match);
    // A "remaining" reading only becomes used/limit once a limit is
    // known, so pass it through and let the panel keep its own limit.
    const result = {
      success: true,
      raw: match[0].trim(),
      platform: platform.id,
      platformLabel: platform.label,
      used: read.used ?? null,
      limit: read.limit ?? null,
      remaining: read.remaining ?? null,
    };
    return result;
  }

  return {
    success: false,
    reason: `No usage figure shown on this ${platform.label} page.`,
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

    if (message.type === 'EDGE_STUDIO_CAPTURE_USAGE') {
      sendResponse(captureUsage());
    }
  });
}
