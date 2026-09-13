// One round trip through a chat tab Dan already has open: write a
// request into it, wait for the answer, hand the answer back.
//
// Optimize (M1.5-2) established this pattern under spec decision #4 —
// no bundled API key, no direct model call, the extension never presses
// send. The video pipeline's scene expansion, refine and script
// breakdown (M4-10/M4-11/M4-12) all need exactly the same trip, so it
// lives here once instead of being copied per caller.

import { openModal } from './modal.js';
import { showToast, copyToClipboard } from './ui.js';

const POLL_MS = 2000;
// Two unchanged polls before the answer counts as finished.
const STABLE_TICKS = 2;

// Tabs come with their session labels from shared/tabs.js, so a picker
// here names a tab exactly as the side panel does.
export { listChatTabs } from './tabs.js';

export async function captureFromTab(tabId) {
  const result = await chrome.runtime.sendMessage({
    type: 'EDGE_STUDIO_CAPTURE_RESPONSE',
    tabId,
  });
  return result && result.success ? result.text : '';
}

export async function sendToTab(tabId, text) {
  const sent = await chrome.runtime.sendMessage({
    type: 'EDGE_STUDIO_SEND_TO_TAB',
    tabId,
    text,
  });
  return !!(sent && sent.success);
}

// Polls the worker tab until its latest answer differs from the
// baseline and has stopped growing — a streaming answer would otherwise
// be scraped half-written.
export function waitForReply(tabId, baseline, intro, title = 'Waiting for the reply') {
  let lastSeen = null;
  let stableTicks = 0;
  let captured = null;
  let timer = null;

  return openModal({
    title,
    body: `${intro}\n\nWatching for the answer…`,
    confirmLabel: 'Use latest now',
    onOpen: (api) => {
      timer = setInterval(async () => {
        const text = await captureFromTab(tabId);
        if (!text || text === baseline) return;

        if (text === lastSeen) {
          stableTicks += 1;
          if (stableTicks >= STABLE_TICKS) {
            captured = text;
            clearInterval(timer);
            api.confirm();
          }
        } else {
          lastSeen = text;
          stableTicks = 0;
          api.setBody(`${intro}\n\nAnswer arriving — waiting for it to finish…`);
        }
      }, POLL_MS);
      // However the dialog closes — poller, "Use latest now", Cancel or
      // Escape — the interval is cleared in the .then() below.
    },
  }).then(async (result) => {
    clearInterval(timer);
    if (result === null) {
      showToast('Cancelled.', 'warning');
      return null;
    }
    // Either the poller settled it, or Dan forced it early.
    const text = captured || lastSeen || (await captureFromTab(tabId));
    if (!text || text === baseline) {
      showToast('No new reply found in that tab yet.', 'warning');
      return null;
    }
    return text;
  });
}

// Write `text` into the tab, then wait for its answer. Resolves to the
// raw reply, or null if it was cancelled or nothing came back.
//
// Injection deliberately doesn't submit: filling the input and letting
// Dan press Enter is the whole point of the hands-off rule.
export async function runRoundTrip({ tabId, tabName, text, title }) {
  // Snapshot what's already on screen so a new answer can be told apart
  // from the one that was there before.
  const baseline = await captureFromTab(tabId);

  const sent = await sendToTab(tabId, text);

  let intro;
  if (sent) {
    intro = `Request written into "${tabName}". Press Enter there to send it.`;
  } else {
    const copied = await copyToClipboard(text);
    if (!copied) {
      showToast(
        `Couldn't write into "${tabName}" and the clipboard is unavailable.`,
        'warning'
      );
      return null;
    }
    intro = `Couldn't write into "${tabName}" — the request is on your clipboard. Paste and send it there.`;
  }

  return waitForReply(tabId, baseline, intro, title);
}

// The requests built on top of this all ask for a single fenced block,
// precisely so pulling the payload back out stays this simple. The
// preamble strip is a fallback for when the chat ignores that.
export function unfence(raw, { language = null } = {}) {
  const text = (raw || '').trim();
  const pattern = language
    ? new RegExp('```(?:' + language + ')?\\s*\\n([\\s\\S]*?)```', 'i')
    : /```[a-zA-Z]*\s*\n([\s\S]*?)```/;
  const fenced = text.match(pattern);
  if (fenced) return fenced[1].trim();
  return text.replace(/^(here(?:'s| is)\b[^\n:]*:?\s*)/i, '').trim();
}
