// Edge Studio — side panel logic
// Covers: M1-2 (builder), M1-3 (library, local-storage stand-in for
// CORE-4 until Drive OAuth is wired), M1-4 (filter + flat list),
// M1-6 (tab labeling), M1-7 (destination picker), M1-9 (clipboard
// fallback), M1-11 (variable placeholders), M2-1 (capture panel),
// M2-2 (save capture), M2-3 (send to prompt)

const BLOCK_LABELS = {
  scenario: 'Scenario',
  expertise: 'Expertise',
  ask: 'Ask',
  format: 'Format',
};

let canvasBlocks = []; // { id, type, text }
let detectedTabs = []; // { id, title, url, windowId }
let tabLabels = {}; // { [tabId]: label }
let selectedTabIds = new Set();
let captures = []; // staged, unsaved captures: { id, tabId, label, kind, text, url, capturedAt }

const canvasEl = document.getElementById('canvas');
const previewEl = document.getElementById('preview');
const libraryListEl = document.getElementById('library-list');
const filterInputEl = document.getElementById('filter-input');
const tabListEl = document.getElementById('tab-list');
const toastEl = document.getElementById('toast');
const modalEl = document.getElementById('modal');
const modalTitleEl = document.getElementById('modal-title');
const modalBodyEl = document.getElementById('modal-body');
const modalFieldsEl = document.getElementById('modal-fields');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalConfirmBtn = document.getElementById('modal-confirm-btn');
const captureListEl = document.getElementById('capture-list');
const responseListEl = document.getElementById('response-list');
const responseFilterEl = document.getElementById('response-filter-input');

// ---------- Storage helpers (M1-3 local stand-in for CORE-4) ----------

async function getLibrary() {
  const { library } = await chrome.storage.local.get('library');
  return library || [];
}

async function saveLibrary(library) {
  await chrome.storage.local.set({ library });
}

// Tab labels live in storage.session, not storage.local, and that's
// deliberate. They're keyed by Chrome tab ID, and tab IDs are only
// unique within a single browser session — Chrome hands the same IDs
// out again after a restart. Persisting them to storage.local meant a
// label saved against tab 42 today would reappear on an unrelated tab
// 42 tomorrow, quietly mislabelling a destination. storage.session is
// cleared when the browser closes, which matches M1-6's "labels persist
// per tab session" acceptance criterion exactly and makes the ID reuse
// unreachable. (Labels that survive a restart would need a stable key
// such as the conversation URL — that's a feature, not this fix.)

async function getTabLabels() {
  const { tabLabels: stored } = await chrome.storage.session.get('tabLabels');
  return stored || {};
}

async function saveTabLabels(labels) {
  await chrome.storage.session.set({ tabLabels: labels });
}

// ---------- Variable placeholders ----------
// Syntax: a token inside <angle brackets>, optionally preceded by a
// literal prefix with no space, e.g. "w<current-week>" or
// "<session-date>". On Insert, each unique variable name is prompted
// for once and substituted everywhere it appears. The template itself
// (canvas + saved library entries) always keeps the raw <placeholder>
// form — substitution only happens on the text actually sent/copied.
//
// A name must look like an identifier: it starts with a letter or
// underscore and continues with letters, digits, hyphens or
// underscores. That deliberately excludes things that merely happen to
// sit inside angle brackets — </closing> tags, <dan@thefaredge.com>,
// <https://example.com>, Map<string,int> — none of which are variables
// and none of which Dan should be asked to fill in.
//
// Tags like <li> or Array<string> still match the identifier shape and
// can't be told apart from a real variable by pattern alone, so two
// things keep them harmless:
//   1. \<li\> escapes the brackets and is never treated as a variable.
//   2. Leaving a field blank leaves the token exactly as it is rather
//      than deleting it, so an unwanted match passes through untouched.
const VARIABLE_PATTERN = /(?<!\\)<([A-Za-z_][A-Za-z0-9_-]*)>/g;

function extractVariableNames(text) {
  const matches = [...text.matchAll(VARIABLE_PATTERN)];
  return [...new Set(matches.map((m) => m[1]))];
}

// Replaces \< and \> with bare angle brackets. Runs once, after
// substitution, so an escaped token reaches the target as literal text.
function unescapeAngleBrackets(text) {
  return text.replace(/\\([<>])/g, '$1');
}

function applyVariableValues(text, names, values) {
  let result = text;
  names.forEach((name) => {
    const value = values[name];
    // Blank (or missing) means "leave this one alone" — see the note
    // above about tokens that were never variables to begin with.
    if (value === undefined || value === '') return;
    // The replacement is a function, not a string, so a value containing
    // $&, $1 or $` is inserted literally instead of being interpreted as
    // a replacement pattern.
    result = result.replace(new RegExp(`(?<!\\\\)<${name}>`, 'g'), () => value);
  });
  return unescapeAngleBrackets(result);
}

async function resolveVariables(text) {
  const names = extractVariableNames(text);
  if (names.length === 0) return unescapeAngleBrackets(text);

  const values = await promptForVariables(names);
  if (values === null) return null; // user cancelled — abort the insert

  await rememberVariableValues(values);
  return applyVariableValues(text, names, values);
}

// Last-used values are remembered per variable name and prefilled the
// next time that name comes up. Most of Dan's variables (a client name,
// a session date) repeat across inserts, and retyping them every time
// was the main friction in using them at all.
async function getRememberedValues() {
  const { variableValues } = await chrome.storage.local.get('variableValues');
  return variableValues || {};
}

async function rememberVariableValues(values) {
  const remembered = await getRememberedValues();
  for (const [name, value] of Object.entries(values)) {
    if (value !== '') remembered[name] = value;
  }
  await chrome.storage.local.set({ variableValues: remembered });
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

// ---------- Generic in-panel modal ----------
// Side panels are extension pages, where native window.prompt/confirm
// are unreliable and visually inconsistent with the panel. Every dialog
// — variables, the save-prompt title, the delete confirmation — goes
// through this one function instead.
//
// Resolves to an object of field values keyed by field name, or null if
// Dan cancels. A modal with no fields resolves to {} on confirm, which
// is what makes it usable as a confirmation dialog.

function openModal({ title, body = null, hint = null, fields = [], confirmLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    modalTitleEl.textContent = title;

    if (body) {
      modalBodyEl.textContent = body;
      modalBodyEl.classList.remove('hidden');
    } else {
      modalBodyEl.classList.add('hidden');
    }

    modalFieldsEl.innerHTML = '';
    const inputs = {};

    if (hint) {
      const hintEl = document.createElement('p');
      hintEl.className = 'modal-hint';
      hintEl.textContent = hint;
      modalFieldsEl.appendChild(hintEl);
    }

    fields.forEach((field) => {
      const wrapper = document.createElement('div');
      wrapper.className = field.mono ? 'variable-field mono' : 'variable-field';

      const label = document.createElement('label');
      label.textContent = field.label;
      wrapper.appendChild(label);

      const input = document.createElement('input');
      input.type = 'text';
      input.value = field.value || '';
      inputs[field.name] = input;
      wrapper.appendChild(input);

      modalFieldsEl.appendChild(wrapper);
    });

    modalConfirmBtn.textContent = confirmLabel;
    modalConfirmBtn.classList.toggle('danger', danger);
    modalEl.classList.remove('hidden');

    const firstInput = fields.length ? inputs[fields[0].name] : null;
    if (firstInput) {
      firstInput.focus();
      firstInput.select(); // a prefilled value should be easy to replace
    }
    else modalConfirmBtn.focus();

    function cleanup() {
      modalEl.classList.add('hidden');
      modalConfirmBtn.removeEventListener('click', onConfirm);
      modalCancelBtn.removeEventListener('click', onCancel);
      modalEl.removeEventListener('keydown', onKeydown);
    }

    function onConfirm() {
      const values = {};
      fields.forEach((field) => {
        values[field.name] = inputs[field.name].value;
      });
      cleanup();
      resolve(values);
    }

    function onCancel() {
      cleanup();
      resolve(null);
    }

    function onKeydown(e) {
      if (e.key === 'Escape') onCancel();
      // Enter submits from any single-line input, but not from the
      // buttons themselves (they handle their own click).
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') onConfirm();
    }

    modalConfirmBtn.addEventListener('click', onConfirm);
    modalCancelBtn.addEventListener('click', onCancel);
    modalEl.addEventListener('keydown', onKeydown);
  });
}

// ---------- Toast ----------

let toastTimer = null;
function showToast(message, kind = 'success') {
  toastEl.textContent = message;
  toastEl.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 4500);
}

// ---------- M1-2: Builder canvas ----------

function renderCanvas() {
  canvasEl.innerHTML = '';

  if (canvasBlocks.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = 'Drag blocks here to build a prompt.';
    canvasEl.appendChild(hint);
  }

  canvasBlocks.forEach((block) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'canvas-block';
    wrapper.dataset.blockType = block.type;
    wrapper.dataset.blockId = block.id;

    const label = document.createElement('div');
    label.className = 'block-label';

    const labelText = document.createElement('span');
    labelText.textContent = BLOCK_LABELS[block.type] || block.type;
    label.appendChild(labelText);

    const remove = document.createElement('span');
    remove.className = 'remove-block';
    remove.textContent = '✕';
    remove.title = 'Remove block';
    remove.addEventListener('click', () => {
      canvasBlocks = canvasBlocks.filter((b) => b.id !== block.id);
      renderCanvas();
      updatePreview();
    });
    label.appendChild(remove);

    wrapper.appendChild(label);

    const textarea = document.createElement('textarea');
    textarea.value = block.text || '';
    textarea.placeholder = `Enter ${BLOCK_LABELS[block.type] || block.type} text...`;
    textarea.addEventListener('input', (e) => {
      block.text = e.target.value;
      updatePreview();
    });
    wrapper.appendChild(textarea);

    canvasEl.appendChild(wrapper);
  });
}

function updatePreview() {
  const assembled = canvasBlocks
    .map((b) => (b.text || '').trim())
    .filter(Boolean)
    .join('\n\n');
  previewEl.value = assembled;
}

function addBlock(type) {
  canvasBlocks.push({
    id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    text: '',
  });
  renderCanvas();
  updatePreview();
}

// Drag from palette chips into the canvas drop zone.
document.querySelectorAll('.block-chip').forEach((chip) => {
  chip.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/block-type', chip.dataset.blockType);
  });
});

canvasEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  canvasEl.classList.add('drag-over');
});

canvasEl.addEventListener('dragleave', () => {
  canvasEl.classList.remove('drag-over');
});

canvasEl.addEventListener('drop', (e) => {
  e.preventDefault();
  canvasEl.classList.remove('drag-over');
  const blockType = e.dataTransfer.getData('text/block-type');
  if (blockType) addBlock(blockType);
});

document.getElementById('clear-canvas-btn').addEventListener('click', () => {
  canvasBlocks = [];
  renderCanvas();
  updatePreview();
});

// ---------- M1-3 / M1-4: Save + filterable flat list ----------

document.getElementById('save-prompt-btn').addEventListener('click', async () => {
  if (canvasBlocks.length === 0) {
    showToast('Nothing to save — add a block first.', 'warning');
    return;
  }
  const result = await openModal({
    title: 'Save prompt',
    fields: [{ name: 'title', label: 'Name this prompt' }],
    confirmLabel: 'Save',
  });
  if (result === null) return;

  const title = result.title.trim();
  if (!title) {
    showToast('Give the prompt a name to save it.', 'warning');
    return;
  }

  const library = await getLibrary();
  library.unshift({
    id: `prompt-${Date.now()}`,
    title,
    blocks: canvasBlocks,
    status: 'Draft', // CORE-5 standard system tag
    createdAt: new Date().toISOString(),
  });
  await saveLibrary(library);
  showToast(`Saved "${title}" to your library.`);
  renderLibrary(filterInputEl.value);
});

async function renderLibrary(filterText = '') {
  const library = await getLibrary();
  const q = filterText.trim().toLowerCase();
  const filtered = q
    ? library.filter(
        (item) =>
          item.title.toLowerCase().includes(q) ||
          (item.status || '').toLowerCase().includes(q)
      )
    : library;

  libraryListEl.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = q ? 'No matches.' : 'No saved prompts yet.';
    libraryListEl.appendChild(empty);
    return;
  }

  filtered.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'library-item';

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.title;
    title.addEventListener('click', () => {
      canvasBlocks = item.blocks.map((b) => ({ ...b, id: `${b.type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }));
      renderCanvas();
      updatePreview();
      showToast(`Loaded "${item.title}" into the builder.`);
    });
    li.appendChild(title);

    const status = document.createElement('span');
    status.className = 'status-tag';
    status.textContent = item.status || 'Draft';
    li.appendChild(status);

    const del = document.createElement('span');
    del.className = 'delete-item';
    del.textContent = '✕';
    del.title = 'Delete';
    del.addEventListener('click', async () => {
      // The library is the only copy of a saved prompt until CORE-4
      // backs it with Drive, so a stray click here is unrecoverable.
      const confirmed = await openModal({
        title: 'Delete prompt',
        body: `Delete "${item.title}"? This can't be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (confirmed === null) return;

      const lib = await getLibrary();
      await saveLibrary(lib.filter((x) => x.id !== item.id));
      showToast(`Deleted "${item.title}".`);
      renderLibrary(filterInputEl.value);
    });
    li.appendChild(del);

    libraryListEl.appendChild(li);
  });
}

filterInputEl.addEventListener('input', (e) => renderLibrary(e.target.value));

// ---------- M1-5 / M1-6 / M1-7: Tab detection, labeling, destination picker ----------

async function refreshTabs() {
  detectedTabs = await chrome.runtime.sendMessage({ type: 'EDGE_STUDIO_GET_TABS' });
  tabLabels = await getTabLabels();

  // Drop anything referring to a tab that no longer exists. Without
  // this, closing a selected tab left its ID in selectedTabIds with no
  // row in the list to unselect — Insert would then try to reach a dead
  // tab and report a failure for something Dan couldn't see. Labels get
  // the same treatment so the map doesn't grow for the whole session.
  const liveTabIds = new Set(detectedTabs.map((tab) => tab.id));

  for (const tabId of selectedTabIds) {
    if (!liveTabIds.has(tabId)) selectedTabIds.delete(tabId);
  }

  const liveLabels = {};
  let droppedLabel = false;
  for (const [tabId, label] of Object.entries(tabLabels)) {
    if (liveTabIds.has(Number(tabId))) liveLabels[tabId] = label;
    else droppedLabel = true;
  }
  if (droppedLabel) {
    tabLabels = liveLabels;
    await saveTabLabels(tabLabels);
  }

  renderTabList();
}

// The destination picker, the capture cards and the insert toasts must
// all call a tab the same thing, so they all resolve its name here.
function tabDisplayName(tabId) {
  const tab = detectedTabs.find((t) => t.id === tabId);
  return tabLabels[tabId] || tab?.title || `Tab ${tabId}`;
}

function renderTabList() {
  tabListEl.innerHTML = '';

  if (!detectedTabs || detectedTabs.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = 'No open ChatGPT tabs found. Open one, then refresh.';
    tabListEl.appendChild(empty);
    return;
  }

  detectedTabs.forEach((tab) => {
    const li = document.createElement('li');
    li.className = 'tab-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedTabIds.has(tab.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedTabIds.add(tab.id);
      else selectedTabIds.delete(tab.id);
    });
    li.appendChild(checkbox);

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = tabDisplayName(tab.id);
    labelInput.addEventListener('change', async () => {
      tabLabels[tab.id] = labelInput.value;
      await saveTabLabels(tabLabels);
    });
    li.appendChild(labelInput);

    tabListEl.appendChild(li);
  });
}

document.getElementById('refresh-tabs-btn').addEventListener('click', refreshTabs);

// ---------- M1-8 / M1-9: Insert with clipboard fallback ----------

document.getElementById('insert-btn').addEventListener('click', async () => {
  const rawText = previewEl.value.trim();
  if (!rawText) {
    showToast('Nothing to insert — build a prompt first.', 'warning');
    return;
  }
  if (selectedTabIds.size === 0) {
    showToast('Select at least one destination tab.', 'warning');
    return;
  }

  const text = await resolveVariables(rawText);
  if (text === null) {
    showToast('Insertion cancelled — a variable prompt was cancelled.', 'warning');
    return;
  }

  let successCount = 0;
  let fallbackCount = 0;

  for (const tabId of selectedTabIds) {
    const label = tabDisplayName(tabId);
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
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.error('[Edge Studio] Clipboard write failed:', err);
      }
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
});

// ---------- M2-1: Response + selection capture ----------
// Captures are staged in the panel before they're saved. The staged text
// sits in an editable textarea on purpose: trimming a captured response
// down to the part worth keeping is the same action as M2-2's "save just
// this section", so it doesn't need a second mechanism.

async function captureFrom(kind) {
  if (selectedTabIds.size === 0) {
    showToast('Tick a tab above to capture from.', 'warning');
    return;
  }

  const type = kind === 'selection'
    ? 'EDGE_STUDIO_CAPTURE_SELECTION'
    : 'EDGE_STUDIO_CAPTURE_RESPONSE';

  const captured = [];
  const failures = [];

  for (const tabId of selectedTabIds) {
    const label = tabDisplayName(tabId);
    const result = await chrome.runtime.sendMessage({ type, tabId });

    if (result && result.success) {
      captured.push({
        id: `capture-${tabId}-${Date.now()}`,
        tabId,
        label,
        kind,
        text: result.text,
        url: result.url,
        capturedAt: new Date().toISOString(),
      });
    } else {
      failures.push(`${label}: ${result?.reason || 'unreachable'}`);
    }
  }

  captures = captured;
  renderCaptures();

  if (captured.length && !failures.length) {
    showToast(`Captured from ${captured.length} tab(s).`);
  } else if (captured.length) {
    showToast(`Captured ${captured.length}. Skipped — ${failures.join('; ')}`, 'warning');
  } else {
    showToast(`Nothing captured. ${failures.join('; ')}`, 'warning');
  }
}

function renderCaptures() {
  captureListEl.innerHTML = '';

  if (captures.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Nothing captured yet.';
    captureListEl.appendChild(empty);
    return;
  }

  captures.forEach((capture) => {
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
      captures = captures.filter((c) => c.id !== capture.id);
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

    const toPromptBtn = document.createElement('button');
    toPromptBtn.className = 'secondary';
    toPromptBtn.textContent = 'To prompt';
    toPromptBtn.title = 'Add this text to the builder as a Scenario block';
    toPromptBtn.addEventListener('click', () => sendTextToPrompt(capture.text));
    row.appendChild(toPromptBtn);

    card.appendChild(row);
    captureListEl.appendChild(card);
  });
}

// ---------- M2-2: Save a capture to the repository ----------

async function getResponses() {
  const { responses } = await chrome.storage.local.get('responses');
  return responses || [];
}

async function saveResponses(responses) {
  await chrome.storage.local.set({ responses });
}

async function saveCapture(capture) {
  const text = capture.text.trim();
  if (!text) {
    showToast('Nothing to save — the capture is empty.', 'warning');
    return;
  }

  const suggested = `${capture.label} — ${new Date(capture.capturedAt).toLocaleDateString()}`;
  const result = await openModal({
    title: 'Save response',
    fields: [{ name: 'title', label: 'Name this response', value: suggested }],
    confirmLabel: 'Save',
  });
  if (result === null) return;

  const title = result.title.trim();
  if (!title) {
    showToast('Give the response a name to save it.', 'warning');
    return;
  }

  const responses = await getResponses();
  responses.unshift({
    id: `response-${Date.now()}`,
    title,
    text,
    status: 'Draft', // CORE-5 standard system tag
    // Per CORE-4 the item points back at where it came from rather than
    // pretending to be the original.
    source: {
      platform: 'ChatGPT',
      tabLabel: capture.label,
      url: capture.url,
      kind: capture.kind,
    },
    capturedAt: capture.capturedAt,
    savedAt: new Date().toISOString(),
  });
  await saveResponses(responses);

  captures = captures.filter((c) => c.id !== capture.id);
  renderCaptures();
  showToast(`Saved "${title}".`);
  renderResponses(responseFilterEl.value);
}

// ---------- M2-3: Send a response back into the composer ----------

function sendTextToPrompt(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    showToast('Nothing to send — that capture is empty.', 'warning');
    return;
  }

  // A response used as input to the next prompt is context, so it lands
  // as a Scenario block. Dan can retype it as another block type or edit
  // it down once it's in the builder.
  canvasBlocks.push({
    id: `scenario-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'scenario',
    text: trimmed,
  });
  renderCanvas();
  updatePreview();
  showToast('Added to the builder as a Scenario block.');
  canvasEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ---------- Saved responses list ----------

function toMarkdown(item) {
  const when = new Date(item.savedAt).toLocaleString();
  return [
    `# ${item.title}`,
    '',
    `*${item.source.platform} — ${item.source.tabLabel} — ${when}*`,
    item.source.url ? `*Source: ${item.source.url}*` : '',
    '',
    item.text,
    '',
  ].filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n');
}

async function renderResponses(filterText = '') {
  const responses = await getResponses();
  const q = filterText.trim().toLowerCase();
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
    empty.textContent = q ? 'No matches.' : 'No saved responses yet.';
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
    meta.textContent = `${item.source?.tabLabel || 'unknown tab'} · ${new Date(item.savedAt).toLocaleDateString()}`;
    li.appendChild(meta);

    const excerpt = document.createElement('p');
    excerpt.className = 'response-excerpt';
    excerpt.textContent = item.text.length > 180 ? `${item.text.slice(0, 180)}…` : item.text;
    li.appendChild(excerpt);

    const row = document.createElement('div');
    row.className = 'row';

    const toPrompt = document.createElement('button');
    toPrompt.className = 'secondary';
    toPrompt.textContent = 'To prompt';
    toPrompt.addEventListener('click', () => sendTextToPrompt(item.text));
    row.appendChild(toPrompt);

    // M2-7, minimal form: Markdown to the clipboard. Writing an actual
    // .md file belongs with the Drive work in CORE-4/M2-5 rather than a
    // one-off download here.
    const copy = document.createElement('button');
    copy.className = 'secondary';
    copy.textContent = 'Copy MD';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(toMarkdown(item));
        showToast('Copied as Markdown.');
      } catch (err) {
        console.error('[Edge Studio] Clipboard write failed:', err);
        showToast('Could not copy to the clipboard.', 'warning');
      }
    });
    row.appendChild(copy);

    const del = document.createElement('button');
    del.className = 'secondary';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      const confirmed = await openModal({
        title: 'Delete response',
        body: `Delete "${item.title}"? This can't be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (confirmed === null) return;

      const all = await getResponses();
      await saveResponses(all.filter((x) => x.id !== item.id));
      showToast(`Deleted "${item.title}".`);
      renderResponses(responseFilterEl.value);
    });
    row.appendChild(del);

    li.appendChild(row);
    responseListEl.appendChild(li);
  });
}

document.getElementById('capture-latest-btn').addEventListener('click', () => captureFrom('latest'));
document.getElementById('capture-selection-btn').addEventListener('click', () => captureFrom('selection'));
responseFilterEl.addEventListener('input', (e) => renderResponses(e.target.value));

// ---------- Init ----------

renderCanvas();
updatePreview();
renderLibrary();
renderCaptures();
renderResponses();
refreshTabs();
