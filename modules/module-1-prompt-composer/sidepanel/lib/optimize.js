// Optimize (M1.5-2 / M1.5-3).
//
// Per spec decision #4 this never calls an LLM API directly. It writes
// an optimization request into a chat tab Dan already has open, waits
// for that chat to answer, scrapes the answer back out and hands it to
// him to approve, edit or discard.

import { state } from './state.js';
import { openModal } from './modal.js';
import { showToast, copyToClipboard } from './ui.js';
import { runRoundTrip, unfence } from './roundtrip.js';
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

export function cleanOptimizedPrompt(raw) {
  return unfence(raw);
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

  const reply = await runRoundTrip({
    tabId: workerTabId,
    tabName: workerName,
    text: buildOptimizationRequest(prompt, target),
    title: 'Waiting for the rewrite',
  });
  if (reply === null) return;

  await reviewOptimizedPrompt(cleanOptimizedPrompt(reply), target, workerName);
}

export function initOptimize() {
  document.getElementById('optimize-btn').addEventListener('click', runOptimize);
}
