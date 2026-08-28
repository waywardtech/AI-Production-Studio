// Insert (M1-8) with the clipboard fallback (M1-9), and the variable
// form that runs first (M1-11).

import { state } from './state.js';
import { extractVariableNames, applyVariableValues, unescapeAngleBrackets } from './variables.js';
import { getRememberedValues, saveRememberedValues } from './storage.js';
import { openModal } from './modal.js';
import { showToast, copyToClipboard } from './ui.js';
import { assembledPrompt } from './builder.js';

// Last-used values are remembered per variable name and prefilled the
// next time that name comes up. Most of Dan's variables (a client name,
// a session date) repeat across inserts, and retyping them every time
// was the main friction in using them at all.
async function rememberVariableValues(values) {
  const remembered = await getRememberedValues();
  for (const [name, value] of Object.entries(values)) {
    if (value !== '') remembered[name] = value;
  }
  await saveRememberedValues(remembered);
}

async function promptForVariables(names) {
  const remembered = await getRememberedValues();
  return openModal({
    title: 'Fill in variables',
    hint: 'Leave a field blank to keep the placeholder as-is.',
    fields: names.map((name) => ({
      name,
      label: name,
      mono: true,
      value: remembered[name] || '',
    })),
    confirmLabel: 'Insert',
  });
}

// Returns the text to send, or null if Dan cancelled the variable form.
export async function resolveVariables(text) {
  const names = extractVariableNames(text);
  if (names.length === 0) return unescapeAngleBrackets(text);

  const values = await promptForVariables(names);
  if (values === null) return null;

  await rememberVariableValues(values);
  return applyVariableValues(text, names, values);
}

async function runInsert() {
  const rawText = assembledPrompt();
  if (!rawText) {
    showToast('Nothing to insert — build a prompt first.', 'warning');
    return;
  }
  if (state.selectedTabIds.size === 0) {
    showToast('Tick at least one chat tab.', 'warning');
    return;
  }

  const text = await resolveVariables(rawText);
  if (text === null) {
    showToast('Insertion cancelled — a variable prompt was cancelled.', 'warning');
    return;
  }

  let successCount = 0;
  let fallbackCount = 0;

  for (const tabId of state.selectedTabIds) {
    const result = await chrome.runtime.sendMessage({
      type: 'EDGE_STUDIO_SEND_TO_TAB',
      tabId,
      text,
    });

    if (result && result.success) {
      successCount += 1;
    } else {
      // M1-9 fallback: copy to clipboard so Dan can paste manually.
      fallbackCount += 1;
      await copyToClipboard(text);
    }
  }

  if (successCount && !fallbackCount) {
    showToast(`Inserted into ${successCount} tab(s).`);
  } else if (successCount && fallbackCount) {
    showToast(
      `Inserted into ${successCount} tab(s). ${fallbackCount} couldn't auto-insert — copied to clipboard, paste manually.`,
      'warning'
    );
  } else {
    showToast('Could not auto-insert — copied to clipboard, paste manually.', 'warning');
  }
}

export function initInsert() {
  document.getElementById('insert-btn').addEventListener('click', runInsert);
}
