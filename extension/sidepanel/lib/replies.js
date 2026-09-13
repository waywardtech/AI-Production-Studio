// The Replies tab: capture (M2-1), save (M2-2), and reuse (M2-3).

import { state } from './state.js';
import { listReplies, saveReply, deleteReply } from './storage.js';
import { newReply } from '../../shared/model.js';
import { openModal } from '../../shared/modal.js';
import { showToast, copyToClipboard, selectedTextOf } from '../../shared/ui.js';
import { tabDisplayName, tabPlatform } from './targets.js';
import { appendTextToBuilder, startPromptFrom } from './builder.js';

const captureListEl = document.getElementById('capture-list');
const responseListEl = document.getElementById('response-list');
const responseFilterEl = document.getElementById('response-filter-input');

// ---------- M2-1: capture ----------
// Captures are staged in the panel before they're saved. The staged
// text sits in an editable textarea on purpose: trimming a captured
// response down to the part worth keeping is the same action as M2-2's
// "save just this section", so it doesn't need a second mechanism.

async function captureFrom(kind) {
  if (state.selectedTabIds.size === 0) {
    showToast('Tick a chat tab above to capture from.', 'warning');
    return;
  }

  const type =
    kind === 'selection' ? 'EDGE_STUDIO_CAPTURE_SELECTION' : 'EDGE_STUDIO_CAPTURE_RESPONSE';

  const captured = [];
  const failures = [];

  for (const tabId of state.selectedTabIds) {
    const label = tabDisplayName(tabId);
    const result = await chrome.runtime.sendMessage({ type, tabId });

    if (result && result.success) {
      captured.push({
        id: `capture-${tabId}-${Date.now()}`,
        tabId,
        label,
        kind,
        platform: result.platformLabel || tabPlatform(tabId) || 'ChatGPT',
        text: result.text,
        url: result.url,
        capturedAt: new Date().toISOString(),
      });
    } else {
      failures.push(`${label}: ${result?.reason || 'unreachable'}`);
    }
  }

  state.captures = captured;
  renderCaptures();

  if (captured.length && !failures.length) {
    showToast(`Captured from ${captured.length} tab(s).`);
  } else if (captured.length) {
    showToast(`Captured ${captured.length}. Skipped — ${failures.join('; ')}`, 'warning');
  } else {
    showToast(`Nothing captured. ${failures.join('; ')}`, 'warning');
  }
}

export function renderCaptures() {
  captureListEl.innerHTML = '';

  if (state.captures.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Nothing captured yet.';
    captureListEl.appendChild(empty);
    return;
  }

  state.captures.forEach((capture) => {
    const card = document.createElement('div');
    card.className = 'capture-card';

    const head = document.createElement('div');
    head.className = 'capture-head';

    const who = document.createElement('span');
    who.className = 'capture-label';
    who.textContent = capture.label;
    head.appendChild(who);

    const kind = document.createElement('span');
    kind.className = 'capture-kind';
    kind.textContent = capture.kind === 'selection' ? 'selection' : 'response';
    head.appendChild(kind);

    const drop = document.createElement('span');
    drop.className = 'remove-block';
    drop.textContent = '✕';
    drop.title = 'Discard this capture';
    drop.addEventListener('click', () => {
      state.captures = state.captures.filter((c) => c.id !== capture.id);
      renderCaptures();
    });
    head.appendChild(drop);

    card.appendChild(head);

    const textarea = document.createElement('textarea');
    textarea.value = capture.text;
    textarea.addEventListener('input', (e) => {
      capture.text = e.target.value;
    });
    card.appendChild(textarea);

    const row = document.createElement('div');
    row.className = 'row';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => saveCapture(capture));
    row.appendChild(saveBtn);

    const appendBtn = document.createElement('button');
    appendBtn.className = 'secondary';
    appendBtn.textContent = 'To builder';
    appendBtn.title = 'Append the highlighted text (or all of it) to the current prompt';
    appendBtn.addEventListener('click', () => appendTextToBuilder(selectedTextOf(textarea)));
    row.appendChild(appendBtn);

    const newBtn = document.createElement('button');
    newBtn.className = 'secondary';
    newBtn.textContent = 'New prompt';
    newBtn.title = 'Start a new prompt from the highlighted text (or all of it)';
    newBtn.addEventListener('click', () => startPromptFrom(selectedTextOf(textarea)));
    row.appendChild(newBtn);

    card.appendChild(row);
    captureListEl.appendChild(card);
  });
}

// ---------- M2-2: save a capture to the repository ----------

async function saveCapture(capture) {
  const text = capture.text.trim();
  if (!text) {
    showToast('Nothing to save — the capture is empty.', 'warning');
    return;
  }

  const suggested = `${capture.label} — ${new Date(capture.capturedAt).toLocaleDateString()}`;
  const result = await openModal({
    title: 'Save reply',
    fields: [{ name: 'title', label: 'Name this reply', value: suggested }],
    confirmLabel: 'Save',
  });
  if (result === null) return;

  const title = result.title.trim();
  if (!title) {
    showToast('Give the reply a name to save it.', 'warning');
    return;
  }

  await saveReply(
    newReply({
      projectId: state.projectId,
      title,
      text,
      source: {
        platform: capture.platform || 'ChatGPT',
        tabLabel: capture.label,
        url: capture.url,
        kind: capture.kind,
      },
      capturedAt: capture.capturedAt,
    })
  );

  state.captures = state.captures.filter((c) => c.id !== capture.id);
  renderCaptures();
  showToast(`Saved "${title}".`);
  await renderResponses();
}

// ---------- Saved replies ----------

export function toMarkdown(item) {
  const when = new Date(item.createdAt).toLocaleString();
  return [
    `# ${item.title}`,
    '',
    `*${item.source.platform} — ${item.source.tabLabel} — ${when}*`,
    item.source.url ? `*Source: ${item.source.url}*` : '',
    '',
    item.text,
    '',
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');
}

export async function renderResponses() {
  const responses = await listReplies(state.projectId);
  const q = responseFilterEl.value.trim().toLowerCase();
  const filtered = q
    ? responses.filter(
        (item) =>
          item.title.toLowerCase().includes(q) ||
          item.text.toLowerCase().includes(q) ||
          (item.source?.tabLabel || '').toLowerCase().includes(q)
      )
    : responses;

  responseListEl.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = q ? 'No matches.' : `No saved replies in ${state.projectName} yet.`;
    responseListEl.appendChild(empty);
    return;
  }

  filtered.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'response-item';

    const head = document.createElement('div');
    head.className = 'response-head';

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.title;
    head.appendChild(title);

    const status = document.createElement('span');
    status.className = 'status-tag';
    status.textContent = item.status || 'Draft';
    head.appendChild(status);

    li.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'response-meta';
    meta.textContent = `${item.source?.platform || 'ChatGPT'} · ${
      item.source?.tabLabel || 'unknown tab'
    } · ${new Date(item.createdAt).toLocaleDateString()}`;
    li.appendChild(meta);

    // Read-only, but a real textarea so a part of it can be highlighted
    // and turned straight into a prompt.
    const body = document.createElement('textarea');
    body.className = 'response-body';
    body.readOnly = true;
    body.value = item.text;
    li.appendChild(body);

    const row = document.createElement('div');
    row.className = 'row';

    const append = document.createElement('button');
    append.className = 'secondary';
    append.textContent = 'To builder';
    append.title = 'Append the highlighted text (or all of it) to the current prompt';
    append.addEventListener('click', () => appendTextToBuilder(selectedTextOf(body)));
    row.appendChild(append);

    const newPrompt = document.createElement('button');
    newPrompt.className = 'secondary';
    newPrompt.textContent = 'New prompt';
    newPrompt.title = 'Start a new prompt from the highlighted text (or all of it)';
    newPrompt.addEventListener('click', () => startPromptFrom(selectedTextOf(body)));
    row.appendChild(newPrompt);

    // M2-7, minimal form: Markdown to the clipboard. Writing an actual
    // .md file belongs with the Drive work in CORE-4/M2-5.
    const copy = document.createElement('button');
    copy.className = 'secondary';
    copy.textContent = 'Copy MD';
    copy.addEventListener('click', async () => {
      const ok = await copyToClipboard(toMarkdown(item));
      showToast(
        ok ? 'Copied as Markdown.' : 'Could not copy to the clipboard.',
        ok ? 'success' : 'warning'
      );
    });
    row.appendChild(copy);

    const del = document.createElement('button');
    del.className = 'secondary';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      const confirmed = await openModal({
        title: 'Delete reply',
        body: `Delete "${item.title}"? This can't be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (confirmed === null) return;

      await deleteReply(item.id);
      showToast(`Deleted "${item.title}".`);
      await renderResponses();
    });
    row.appendChild(del);

    li.appendChild(row);
    responseListEl.appendChild(li);
  });
}

export function initReplies() {
  document
    .getElementById('capture-latest-btn')
    .addEventListener('click', () => captureFrom('latest'));
  document
    .getElementById('capture-selection-btn')
    .addEventListener('click', () => captureFrom('selection'));
  responseFilterEl.addEventListener('input', () => renderResponses());
}
