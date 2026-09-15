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
    fileInputSelectors: ['input[type="file"][multiple]', 'input[type="file"]'],
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
    fileInputSelectors: ['input[type="file"][data-testid*="file"]', 'input[type="file"]'],
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
    fileInputSelectors: ['input[type="file"]'],
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
    fileInputSelectors: ['input[type="file"]'],
    assistantSelectors: [],
    assistantFallback: null,
  },
  {
    id: 'flow',
    label: 'Flow',
    kind: 'generator',
    hosts: ['labs.google'],
    inputSelectors: ['textarea', 'div[contenteditable="true"]'],
    fileInputSelectors: ['input[type="file"]'],
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

// ---------- M5-4: attaching files ----------
//
// A prompt that talks about a reference the chat can't see is only half
// the message, so Produce and Insert can hand the files over too. Three
// ways in, tried in order, because no two of these sites agree:
//
//   1. the page's own <input type="file"> — the closest thing to the
//      user having clicked the paperclip, and what React reads from
//   2. a paste onto the composer — what most of them support for
//      screenshots
//   3. a drop onto the composer — the last resort
//
// None of this presses send. The files land in the composer next to the
// prompt and wait, exactly as the text does.
//
// Bytes arrive in chunks: one message per few megabytes, because Chrome's
// message passing is not built for handing over a whole video at once.
// A transfer is assembled here and only turned into Files at commit.

const transfers = new Map();

function beginTransfer(transferId, files) {
  transfers.set(transferId, {
    startedAt: Date.now(),
    files: (files || []).map((file) => ({ name: file.name, type: file.type, parts: [] })),
  });
  return { success: true };
}

function addChunk(transferId, index, base64) {
  const transfer = transfers.get(transferId);
  if (!transfer) return { success: false, reason: 'That transfer is not open.' };
  const file = transfer.files[index];
  if (!file) return { success: false, reason: `No file at index ${index}.` };
  file.parts.push(base64ToBytes(base64));
  return { success: true };
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function commitTransfer(transferId) {
  const transfer = transfers.get(transferId);
  transfers.delete(transferId);
  if (!transfer) return { success: false, reason: 'That transfer is not open.' };

  const files = transfer.files.map(
    (file) => new File([new Blob(file.parts, { type: file.type })], file.name, { type: file.type })
  );
  return attachFiles(files);
}

function buildDataTransfer(files) {
  const data = new DataTransfer();
  files.forEach((file) => data.items.add(file));
  return data;
}

// Assigning to .files is what a real pick does, and is what React's
// onChange reads; dispatching input as well covers listeners that watch
// for either.
function attachViaFileInput(platform, files) {
  const selectors = platform.fileInputSelectors || ['input[type="file"]'];
  for (const selector of selectors) {
    const inputs = [...document.querySelectorAll(selector)].filter((el) => !el.disabled);
    for (const input of inputs) {
      try {
        input.files = buildDataTransfer(files).files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, method: 'file-input' };
      } catch {
        // Some inputs refuse assignment (accept mismatch, detached
        // node); try the next one rather than giving up on the page.
      }
    }
  }
  return null;
}

function attachViaPaste(platform, files) {
  const target = findInput(platform);
  if (!target) return null;
  try {
    target.el.focus();
    const event = new ClipboardEvent('paste', {
      clipboardData: buildDataTransfer(files),
      bubbles: true,
      cancelable: true,
    });
    target.el.dispatchEvent(event);
    return { success: true, method: 'paste' };
  } catch {
    return null;
  }
}

function attachViaDrop(platform, files) {
  const target = findInput(platform);
  if (!target) return null;
  try {
    const data = buildDataTransfer(files);
    const fire = (type) =>
      target.el.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    fire('dragenter');
    fire('dragover');
    fire('drop');
    return { success: true, method: 'drop' };
  } catch {
    return null;
  }
}

function attachFiles(files) {
  const platform = currentPlatform();
  if (!platform) return { success: false, reason: 'Edge Studio does not handle this site.' };
  if (!files.length) return { success: false, reason: 'No files to attach.' };

  const attempt = attachViaFileInput(platform, files) || attachViaPaste(platform, files) || attachViaDrop(platform, files);

  if (!attempt) {
    return {
      success: false,
      reason: `Could not find anywhere on ${platform.label} to attach a file. Attach it by hand — the prompt is already in the box.`,
    };
  }

  // The page was handed the files; whether it accepted them is its own
  // business and not something we can read back, so say which way it
  // went in and let Dan see the result on screen.
  return { ...attempt, platform: platform.id, platformLabel: platform.label, count: files.length };
}

// ---------- M5-5: the page check ----------
//
// Every selector in this file is a guess about somebody else's markup,
// and the only way to know is to look. Rather than asking Dan to read
// the source and poke at devtools on five sites, this reports what each
// strategy would actually find on the page in front of him.
//
// It reuses findInput and the platform's own selector lists, so the
// report can't drift away from what Insert and Attach really do — if
// this says "file input found", that is the element they would use.

function describeElement(el) {
  if (!el) return null;
  const attr = (name) => (typeof el.getAttribute === 'function' ? el.getAttribute(name) : null);
  return {
    tag: (el.tagName || '').toLowerCase() || null,
    id: el.id || null,
    disabled: !!el.disabled,
    accept: attr('accept'),
    multiple: el.multiple === true || attr('multiple') !== null,
  };
}

function countFor(selector) {
  try {
    return document.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

function probePage() {
  const platform = currentPlatform();
  if (!platform) {
    return { success: false, reason: 'Edge Studio does not handle this site.', url: location.href };
  }

  const inputTried = platform.inputSelectors.map((selector) => ({ selector, count: countFor(selector) }));
  const target = findInput(platform);
  const input = target
    ? { selector: inputTried.find((t) => t.count > 0)?.selector || null, kind: target.kind, element: describeElement(target.el) }
    : null;

  const fileSelectors = platform.fileInputSelectors || ['input[type="file"]'];
  const fileTried = fileSelectors.map((selector) => {
    let elements = [];
    try {
      elements = [...document.querySelectorAll(selector)];
    } catch {
      elements = [];
    }
    const usable = elements.filter((el) => !el.disabled);
    return {
      selector,
      count: elements.length,
      usable: usable.length,
      first: describeElement(usable[0] || elements[0]),
    };
  });

  const firstUsableFile = fileTried.find((entry) => entry.usable > 0) || null;

  // The same order attachFiles tries, reported without touching anything.
  let attachPlan = 'none';
  if (firstUsableFile) attachPlan = 'file-input';
  else if (target) attachPlan = 'paste';

  const assistantTried =
    platform.assistantSelectors.map((selector) => ({ selector, count: countFor(selector) }));
  const fallbackCount = platform.assistantFallback ? platform.assistantFallback().length : null;

  const usage = captureUsage();

  return {
    success: true,
    at: new Date().toISOString(),
    url: location.href,
    title: document.title,
    platform: { id: platform.id, label: platform.label, kind: platform.kind || 'chat' },
    input,
    inputTried,
    fileTried,
    fileInput: firstUsableFile,
    attachPlan,
    assistantTried,
    assistantFallback: fallbackCount,
    assistantFound: assistantTried.some((t) => t.count > 0) || (fallbackCount || 0) > 0,
    usage: usage.success ? { found: true, raw: usage.raw } : { found: false },
  };
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

    if (message.type === 'EDGE_STUDIO_ATTACH_BEGIN') {
      sendResponse(beginTransfer(message.transferId, message.files));
    }

    if (message.type === 'EDGE_STUDIO_ATTACH_CHUNK') {
      sendResponse(addChunk(message.transferId, message.index, message.base64));
    }

    if (message.type === 'EDGE_STUDIO_ATTACH_COMMIT') {
      sendResponse(commitTransfer(message.transferId));
    }

    if (message.type === 'EDGE_STUDIO_PROBE') {
      sendResponse(probePage());
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
