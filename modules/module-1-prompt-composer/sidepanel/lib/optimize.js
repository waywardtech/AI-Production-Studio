// Optimize (M1.5-2 / M1.5-3).
//
// Per spec decision #4 this never calls an LLM API directly. It writes
// an optimization request into a chat tab Dan already has open, waits
// for that chat to answer, scrapes the answer back out and hands it to
// him to approve, edit or discard.

import { state } from './state.js';
import { openModal } from './modal.js';
import { showToast, copyToClipboard } from './ui.js';
import { tabDisplayName, tabPlatform } from './targets.js';
import { assembledPrompt, setBuilderTo } from './builder.js';

// Per-platform guidance. Deliberately says "markdown headings" rather
// than XML-style tags: a rewritten prompt containing <context>-style
// tags would come back and be read as variable placeholders by the
// <angle bracket> syntax.
export const OPTIMIZE_TARGETS = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    guidance:
      'Lead with the role and the task. State the output format explicitly ' +
      'rather than implying it. Break multi-part work into numbered steps. ' +
      'Put the single most important instruction first.',
  },
  {
    id: 'claude',
    label: 'Claude',
    guidance:
      'Use clear section structure with markdown headings. State constraints ' +
      'explicitly, and say what to do rather than what to avoid. Put reference ' +
      'material before the instruction that acts on it.',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    guidance:
      'Be direct and concrete. Spell out the expected shape of the answer, ' +
      'and give a short example of the desired output where it helps. Keep ' +
      'instructions in one block rather than scattered.',
  },
];

const POLL_MS = 2000;
// Two unchanged polls before the answer counts as finished.
const STABLE_TICKS = 2;

export function buildOptimizationRequest(prompt, target) {
  return [
    `You are a prompt engineer. Rewrite the prompt below so it performs as well as possible on ${target.label}.`,
    '',
    `Guidance for ${target.label}: ${target.guidance}`,
    '',
    'Rules:',
    '- Preserve the intent and every constraint of the original.',
    '- Placeholder tokens written in <angle brackets> must survive exactly as written. Do not fill them in, rename them, or add new ones.',
    '- Use markdown headings for structure, never XML-style tags.',
    '- Do not answer or carry out the prompt. Return only the rewritten prompt.',
    '- Return it inside a single fenced code block, with no commentary before or after.',
    '',
    '--- PROMPT TO REWRITE ---',
    prompt,
    '--- END ---',
  ].join('\n');
}

// The request asks for a fenced block precisely so this stays simple.
// The preamble strip is a fallback for when the chat ignores that.
export function cleanOptimizedPrompt(raw) {
  const text = (raw || '').trim();
  const fenced = text.match(/```[a-zA-Z]*\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return text.replace(/^(here(?:'s| is)\b[^\n:]*:?\s*)/i, '').trim();
}

async function captureFromTab(tabId) {
  const result = await chrome.runtime.sendMessage({
    type: 'EDGE_STUDIO_CAPTURE_RESPONSE',
    tabId,
  });
  return result && result.success ? result.text : '';
}

// Polls the worker tab until its latest answer differs from the
// baseline and has stopped growing — a streaming answer would otherwise
// be scraped half-written.
function waitForOptimizedReply(tabId, baseline, intro) {
  let lastSeen = null;
  let stableTicks = 0;
  let captured = null;
  let timer = null;

  return openModal({
    title: 'Waiting for the reply',
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
      showToast('Optimization cancelled.', 'warning');
      return null;
    }
    // Either the poller settled it, or Dan forced it early.
    const text = captured || lastSeen || (await captureFromTab(tabId));
    if (!text || text === baseline) {
      showToast('No new reply found in that tab yet.', 'warning');
      return null;
    }
    return cleanOptimizedPrompt(text);
  });
}

async function reviewOptimizedPrompt(optimized, target, workerName) {
  const result = await openModal({
    title: `Optimized for ${target.label}`,
    hint: `Scraped from "${workerName}". Edit it here if you want, then replace the builder or copy it.`,
    fields: [
      { name: 'text', label: 'Rewritten prompt', type: 'textarea', rows: 12, value: optimized },
    ],
    confirmLabel: 'Replace builder',
    extraButtons: [
      {
        label: 'Copy',
        onClick: async ({ getValues }) => {
          const ok = await copyToClipboard(getValues().text);
          showToast(ok ? 'Copied to clipboard.' : 'Could not copy.', ok ? 'success' : 'warning');
        },
      },
    ],
  });
  if (result === null) return;

  const text = result.text.trim();
  if (!text) {
    showToast('Nothing to put in the builder.', 'warning');
    return;
  }

  setBuilderTo(text);
  showToast(`Builder replaced with the ${target.label} version.`);
}

async function runOptimize() {
  const prompt = assembledPrompt();
  if (!prompt) {
    showToast('Build a prompt first.', 'warning');
    return;
  }
  if (state.detectedTabs.length === 0) {
    showToast('Open a chat tab to run the optimization in, then Refresh.', 'warning');
    return;
  }

  const defaultWorkerId = String([...state.selectedTabIds][0] ?? state.detectedTabs[0].id);
  // Default the target to whatever the worker tab already is; Dan can
  // change it, since optimizing for Claude inside a ChatGPT tab is a
  // perfectly reasonable thing to want.
  const defaultTarget = tabPlatform(Number(defaultWorkerId)) || 'chatgpt';

  const setup = await openModal({
    title: 'Optimize prompt',
    hint: 'The optimization runs in a chat you already have open. Pick which chat does the work, and which system the result should be tuned for.',
    fields: [
      {
        name: 'workerTabId',
        label: 'Run it in',
        type: 'select',
        value: defaultWorkerId,
        options: state.detectedTabs.map((t) => ({
          value: String(t.id),
          label: tabDisplayName(t.id),
        })),
      },
      {
        name: 'target',
        label: 'Optimize for',
        type: 'select',
        value: OPTIMIZE_TARGETS.some((t) => t.id === defaultTarget) ? defaultTarget : 'chatgpt',
        options: OPTIMIZE_TARGETS.map((t) => ({ value: t.id, label: t.label })),
      },
    ],
    confirmLabel: 'Send',
  });
  if (setup === null) return;

  const workerTabId = Number(setup.workerTabId);
  const target = OPTIMIZE_TARGETS.find((t) => t.id === setup.target);
  const workerName = tabDisplayName(workerTabId);

  // Snapshot what's already on screen so a new answer can be told apart
  // from the one that was there before.
  const baseline = await captureFromTab(workerTabId);

  const request = buildOptimizationRequest(prompt, target);
  const sent = await chrome.runtime.sendMessage({
    type: 'EDGE_STUDIO_SEND_TO_TAB',
    tabId: workerTabId,
    text: request,
  });

  let intro;
  if (sent && sent.success) {
    // Injection fills the input but deliberately doesn't submit — the
    // extension never presses send in Dan's chat.
    intro = `Request written into "${workerName}". Press Enter there to send it.`;
  } else {
    const copied = await copyToClipboard(request);
    if (!copied) {
      showToast(
        `Couldn't write into "${workerName}" and the clipboard is unavailable. Optimization cancelled.`,
        'warning'
      );
      return;
    }
    intro = `Couldn't write into "${workerName}" — the request is on your clipboard. Paste and send it there.`;
  }

  const optimized = await waitForOptimizedReply(workerTabId, baseline, intro);
  if (optimized === null) return;

  await reviewOptimizedPrompt(optimized, target, workerName);
}

export function initOptimize() {
  document.getElementById('optimize-btn').addEventListener('click', runOptimize);
}
