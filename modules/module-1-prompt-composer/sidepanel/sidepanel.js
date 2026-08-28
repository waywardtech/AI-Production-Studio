// Edge Studio — side panel logic
//
// Covers: M1-2 (builder), M1-3 (library, local-storage stand-in for
// CORE-4 until Drive OAuth is wired), M1-4 (filter + list), M1-6 (tab
// labeling), M1-7 (destination picker), M1-9 (clipboard fallback),
// M1-11 (variable placeholders), M1.5-1 (Format block), M1.5-2/M1.5-3
// (optimize step + result intake), M2-1 (capture panel), M2-2 (save
// capture), M2-3 (send to prompt), CORE-5 (Status + custom tags).
//
// The panel is split into two tabs — Prompts and Replies — over a
// shared "Chat tabs" list, because both tabs act on the same ticked
// tabs and duplicating that list would let the two drift apart.

// ---------- Constants ----------

// Seeded on first run; editable from Blocks → Manage after that.
const DEFAULT_BLOCK_TYPES = [
  { id: 'scenario', label: 'Scenario' },
  { id: 'expertise', label: 'Expertise' },
  { id: 'ask', label: 'Ask' },
  { id: 'format', label: 'Format' },
];

// Per-platform guidance for the optimize step. Deliberately says
// "markdown headings" rather than XML-style tags: a rewritten prompt
// containing <context>-style tags would come back and be read as
// variable placeholders by the <angle bracket> syntax below.
const OPTIMIZE_TARGETS = [
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

const OPTIMIZE_POLL_MS = 2000;

// ---------- State ----------

let canvasBlocks = []; // { id, type, text }
let blockTypes = []; // { id, label }
let detectedTabs = []; // { id, title, url, windowId }
let tabLabels = {}; // { [tabId]: label }
let selectedTabIds = new Set();
let captures = []; // staged, unsaved: { id, tabId, label, kind, text, url, capturedAt }
let activeTagFilter = null; // null = all tags

// ---------- Elements ----------

const canvasEl = document.getElementById('canvas');
const previewEl = document.getElementById('preview');
const paletteRowEl = document.getElementById('palette-row');
const libraryListEl = document.getElementById('library-list');
const tagFilterRowEl = document.getElementById('tag-filter-row');
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

// ---------- Storage (M1-3 local stand-in for CORE-4) ----------

async function getLibrary() {
  const { library } = await chrome.storage.local.get('library');
  return library || [];
}

async function saveLibrary(library) {
  await chrome.storage.local.set({ library });
}

async function getResponses() {
  const { responses } = await chrome.storage.local.get('responses');
  return responses || [];
}

async function saveResponses(responses) {
  await chrome.storage.local.set({ responses });
}

async function loadBlockTypes() {
  const { blockTypes: stored } = await chrome.storage.local.get('blockTypes');
  blockTypes = stored && stored.length ? stored : [...DEFAULT_BLOCK_TYPES];
}

async function persistBlockTypes() {
  await chrome.storage.local.set({ blockTypes });
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

// ---------- Variable placeholders (M1-11) ----------
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
// in the panel goes through this one function.
//
// Resolves to an object of field values keyed by field name, or null if
// Dan cancels. A modal with no fields resolves to {} on confirm, which
// is what makes it usable as a confirmation dialog.
//
// Field types: text (default), textarea, select, checkbox.
// `render(container, api)` draws arbitrary extra content — used by the
// block manager, which needs per-row delete buttons.
// `extraButtons` adds actions beside Cancel/Confirm.
// `onOpen(api)` hands control back to the caller so long-running flows
// (the optimize poller) can close the dialog themselves.

function openModal({
  title,
  body = null,
  hint = null,
  fields = [],
  confirmLabel = 'OK',
  danger = false,
  render = null,
  extraButtons = [],
  onOpen = null,
}) {
  return new Promise((resolve) => {
    modalTitleEl.textContent = title;
    setModalBody(body);

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

      let input;
      if (field.type === 'select') {
        input = document.createElement('select');
        (field.options || []).forEach((opt) => {
          const option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          input.appendChild(option);
        });
        input.value = field.value ?? '';
      } else if (field.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = field.rows || 8;
        input.value = field.value || '';
      } else if (field.type === 'checkbox') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!field.value;
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = field.value || '';
      }

      inputs[field.name] = input;
      wrapper.appendChild(input);
      modalFieldsEl.appendChild(wrapper);
    });

    const extraEls = [];
    if (render) render(modalFieldsEl, { confirm: onConfirm, cancel: onCancel });

    modalConfirmBtn.textContent = confirmLabel;
    modalConfirmBtn.classList.toggle('danger', danger);

    extraButtons.forEach((spec) => {
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.textContent = spec.label;
      btn.addEventListener('click', () => spec.onClick({ getValues, confirm: onConfirm, cancel: onCancel }));
      modalConfirmBtn.parentNode.insertBefore(btn, modalConfirmBtn);
      extraEls.push(btn);
    });

    modalEl.classList.remove('hidden');

    const firstField = fields.find((f) => f.type !== 'checkbox');
    const firstInput = firstField ? inputs[firstField.name] : null;
    if (firstInput) {
      firstInput.focus();
      // A prefilled value should be easy to replace.
      if (typeof firstInput.select === 'function') firstInput.select();
    } else {
      modalConfirmBtn.focus();
    }

    function getValues() {
      const values = {};
      fields.forEach((field) => {
        const input = inputs[field.name];
        values[field.name] = field.type === 'checkbox' ? input.checked : input.value;
      });
      return values;
    }

    function cleanup() {
      modalEl.classList.add('hidden');
      modalConfirmBtn.classList.remove('danger');
      extraEls.forEach((el) => el.remove());
      modalConfirmBtn.removeEventListener('click', onConfirm);
      modalCancelBtn.removeEventListener('click', onCancel);
      modalEl.removeEventListener('keydown', onKeydown);
    }

    let settled = false;
    function onConfirm() {
      if (settled) return;
      settled = true;
      const values = getValues();
      cleanup();
      resolve(values);
    }

    function onCancel() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    }

    function onKeydown(e) {
      if (e.key === 'Escape') onCancel();
      // Enter submits from a single-line input only — not from a
      // textarea, where it has to keep inserting newlines.
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type === 'text') onConfirm();
    }

    modalConfirmBtn.addEventListener('click', onConfirm);
    modalCancelBtn.addEventListener('click', onCancel);
    modalEl.addEventListener('keydown', onKeydown);

    if (onOpen) onOpen({ confirm: onConfirm, cancel: onCancel, setBody: setModalBody, getValues });
  });
}

function setModalBody(body) {
  if (body) {
    modalBodyEl.textContent = body;
    modalBodyEl.classList.remove('hidden');
  } else {
    modalBodyEl.classList.add('hidden');
  }
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

// ---------- Prompts / Replies tabs ----------

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `tab-${name}`);
  });
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ---------- Block types (palette + manager) ----------

function blockLabel(typeId) {
  const type = blockTypes.find((t) => t.id === typeId);
  // A block whose type was deleted still renders — it falls back to the
  // raw id rather than disappearing or blanking out.
  return type ? type.label : typeId;
}

function defaultBlockTypeId() {
  const scenario = blockTypes.find((t) => t.id === 'scenario');
  return scenario ? scenario.id : blockTypes[0]?.id || 'scenario';
}

function renderPalette() {
  paletteRowEl.innerHTML = '';
  blockTypes.forEach((type) => {
    const chip = document.createElement('div');
    chip.className = 'block-chip';
    chip.draggable = true;
    chip.dataset.blockType = type.id;
    chip.textContent = type.label;
    chip.title = `Drag into the builder, or click to append a ${type.label} block`;
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/block-type', type.id);
    });
    // Dragging is fiddly in a narrow side panel, so a click does the
    // same thing.
    chip.addEventListener('click', () => addBlock(type.id));
    paletteRowEl.appendChild(chip);
  });

  if (blockTypes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No block types. Add one with Manage.';
    paletteRowEl.appendChild(empty);
  }
}

function slugifyBlockId(label, taken) {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'block';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

async function openBlockManager() {
  // Working copy — nothing is persisted unless Dan confirms.
  let working = blockTypes.map((t) => ({ ...t }));

  const result = await openModal({
    title: 'Manage blocks',
    hint: 'Rename, remove or add block types. Blocks already used in saved prompts keep working; a removed type just shows its raw name.',
    confirmLabel: 'Save',
    render: (container) => {
      const list = document.createElement('div');
      list.className = 'block-manager';
      container.appendChild(list);

      const addRow = document.createElement('div');
      addRow.className = 'block-manager-add';
      const addInput = document.createElement('input');
      addInput.type = 'text';
      addInput.placeholder = 'New block type…';
      const addBtn = document.createElement('button');
      addBtn.className = 'secondary';
      addBtn.textContent = 'Add';
      addRow.appendChild(addInput);
      addRow.appendChild(addBtn);
      container.appendChild(addRow);

      function draw() {
        list.innerHTML = '';
        working.forEach((type) => {
          const row = document.createElement('div');
          row.className = 'block-manager-row';

          const input = document.createElement('input');
          input.type = 'text';
          input.value = type.label;
          input.addEventListener('input', (e) => {
            type.label = e.target.value;
          });
          row.appendChild(input);

          const del = document.createElement('span');
          del.className = 'remove-block';
          del.textContent = '✕';
          del.title = `Remove ${type.label}`;
          del.addEventListener('click', () => {
            working = working.filter((t) => t.id !== type.id);
            draw();
          });
          row.appendChild(del);

          list.appendChild(row);
        });

        if (working.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'empty-state';
          empty.textContent = 'No block types left.';
          list.appendChild(empty);
        }
      }

      function addType() {
        const label = addInput.value.trim();
        if (!label) return;
        working.push({ id: slugifyBlockId(label, new Set(working.map((t) => t.id))), label });
        addInput.value = '';
        addInput.focus();
        draw();
      }

      addBtn.addEventListener('click', addType);
      addInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.stopPropagation(); // don't let the modal treat this as confirm
          addType();
        }
      });

      draw();
    },
  });

  if (result === null) return;

  const cleaned = working
    .map((t) => ({ id: t.id, label: t.label.trim() }))
    .filter((t) => t.label);

  if (cleaned.length === 0) {
    showToast('Keep at least one block type.', 'warning');
    return;
  }

  blockTypes = cleaned;
  await persistBlockTypes();
  renderPalette();
  renderCanvas();
  showToast('Block types updated.');
}

document.getElementById('manage-blocks-btn').addEventListener('click', openBlockManager);

// ---------- M1-2: Builder canvas ----------

function newBlockId(type) {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

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

    // The type is a select, not a label, so a block typed as Ask can be
    // switched to Scenario after the fact without retyping its text.
    const select = document.createElement('select');
    select.className = 'block-type-select';
    const options = [...blockTypes];
    if (!options.some((t) => t.id === block.type)) {
      // Keep an orphaned type selectable so switching away from it is a
      // choice rather than something that happens silently.
      options.push({ id: block.type, label: blockLabel(block.type) });
    }
    options.forEach((type) => {
      const option = document.createElement('option');
      option.value = type.id;
      option.textContent = type.label;
      select.appendChild(option);
    });
    select.value = block.type;
    select.addEventListener('change', (e) => {
      block.type = e.target.value;
      renderCanvas(); // re-render to pick up the type's colour
      updatePreview();
    });
    label.appendChild(select);

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
    textarea.placeholder = `Enter ${blockLabel(block.type)} text...`;
    textarea.addEventListener('input', (e) => {
      block.text = e.target.value;
      updatePreview();
    });
    wrapper.appendChild(textarea);

    canvasEl.appendChild(wrapper);
  });
}

function updatePreview() {
  previewEl.value = canvasBlocks
    .map((b) => (b.text || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function addBlock(type) {
  canvasBlocks.push({ id: newBlockId(type), type, text: '' });
  renderCanvas();
  updatePreview();
}

function setBuilderTo(text, type = null) {
  const blockType = type || defaultBlockTypeId();
  canvasBlocks = [{ id: newBlockId(blockType), type: blockType, text }];
  renderCanvas();
  updatePreview();
}

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

// ---------- M1-3 / M1-4 / CORE-5: Library, tags and grouping ----------

function parseTags(raw) {
  // Stored lowercase so "Apex", "apex" and "APEX" are one group.
  return [...new Set(
    (raw || '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
  )];
}

document.getElementById('save-prompt-btn').addEventListener('click', async () => {
  if (canvasBlocks.length === 0) {
    showToast('Nothing to save — add a block first.', 'warning');
    return;
  }
  const result = await openModal({
    title: 'Save prompt',
    fields: [
      { name: 'title', label: 'Name this prompt' },
      { name: 'tags', label: 'Tags (comma separated)', value: activeTagFilter || '' },
    ],
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
    tags: parseTags(result.tags),
    status: 'Draft', // CORE-5 standard system tag
    createdAt: new Date().toISOString(),
  });
  await saveLibrary(library);
  showToast(`Saved "${title}" to your library.`);
  await renderLibrary();
});

async function editPromptMeta(item) {
  const result = await openModal({
    title: 'Edit prompt',
    fields: [
      { name: 'title', label: 'Name', value: item.title },
      { name: 'tags', label: 'Tags (comma separated)', value: (item.tags || []).join(', ') },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        value: item.status || 'Draft',
        options: ['Draft', 'In Review', 'Approved', 'Archived'].map((s) => ({ value: s, label: s })),
      },
    ],
    confirmLabel: 'Save',
  });
  if (result === null) return;

  const title = result.title.trim();
  if (!title) {
    showToast('A prompt needs a name.', 'warning');
    return;
  }

  const library = await getLibrary();
  const target = library.find((x) => x.id === item.id);
  if (!target) return;
  target.title = title;
  target.tags = parseTags(result.tags);
  target.status = result.status;
  await saveLibrary(library);
  showToast(`Updated "${title}".`);
  await renderLibrary();
}

function loadPromptIntoBuilder(item) {
  canvasBlocks = item.blocks.map((b) => ({ ...b, id: newBlockId(b.type) }));
  renderCanvas();
  updatePreview();
  switchTab('prompts');
  showToast(`Loaded "${item.title}" into the builder.`);
}

function buildPromptRow(item) {
  const li = document.createElement('li');
  li.className = 'library-item';

  const head = document.createElement('div');
  head.className = 'library-head';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = item.title;
  title.title = 'Load into the builder';
  title.addEventListener('click', () => loadPromptIntoBuilder(item));
  head.appendChild(title);

  const status = document.createElement('span');
  status.className = 'status-tag';
  status.textContent = item.status || 'Draft';
  head.appendChild(status);

  const edit = document.createElement('span');
  edit.className = 'row-action';
  edit.textContent = '✎';
  edit.title = 'Edit name, tags and status';
  edit.addEventListener('click', () => editPromptMeta(item));
  head.appendChild(edit);

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
    await renderLibrary();
  });
  head.appendChild(del);

  li.appendChild(head);

  if ((item.tags || []).length) {
    const tagRow = document.createElement('div');
    tagRow.className = 'tag-row';
    item.tags.forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = tag;
      chip.title = `Filter by "${tag}"`;
      chip.addEventListener('click', () => {
        activeTagFilter = tag;
        renderLibrary();
      });
      tagRow.appendChild(chip);
    });
    li.appendChild(tagRow);
  }

  return li;
}

function renderTagFilter(allTags) {
  tagFilterRowEl.innerHTML = '';
  if (allTags.length === 0) return;

  const makeChip = (label, value) => {
    const chip = document.createElement('button');
    chip.className = 'tag-chip filter';
    chip.classList.toggle('active', activeTagFilter === value);
    chip.textContent = label;
    chip.addEventListener('click', () => {
      activeTagFilter = value;
      renderLibrary();
    });
    return chip;
  };

  tagFilterRowEl.appendChild(makeChip('All', null));
  allTags.forEach((tag) => tagFilterRowEl.appendChild(makeChip(tag, tag)));
}

async function renderLibrary() {
  const library = await getLibrary();
  const q = filterInputEl.value.trim().toLowerCase();

  const allTags = [...new Set(library.flatMap((item) => item.tags || []))].sort();
  // A tag that no longer exists shouldn't leave the list looking empty.
  if (activeTagFilter && !allTags.includes(activeTagFilter)) activeTagFilter = null;
  renderTagFilter(allTags);

  const matchesText = (item) =>
    !q ||
    item.title.toLowerCase().includes(q) ||
    (item.status || '').toLowerCase().includes(q) ||
    (item.tags || []).some((t) => t.includes(q));

  libraryListEl.innerHTML = '';

  const visible = library.filter(matchesText);

  if (visible.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = library.length === 0 ? 'No saved prompts yet.' : 'No matches.';
    libraryListEl.appendChild(empty);
    return;
  }

  // With a tag selected, show a flat list of just that tag. With "All"
  // selected, group by tag instead — a prompt tagged both "apex" and
  // "work" appears under both, which is the point of tagging rather
  // than foldering.
  if (activeTagFilter) {
    const list = document.createElement('ul');
    list.className = 'library-group-list';
    visible
      .filter((item) => (item.tags || []).includes(activeTagFilter))
      .forEach((item) => list.appendChild(buildPromptRow(item)));
    if (!list.children.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No matches in this tag.';
      libraryListEl.appendChild(empty);
      return;
    }
    libraryListEl.appendChild(list);
    return;
  }

  const groups = [];
  allTags.forEach((tag) => {
    const items = visible.filter((item) => (item.tags || []).includes(tag));
    if (items.length) groups.push({ tag, items });
  });
  const untagged = visible.filter((item) => !(item.tags || []).length);
  if (untagged.length) groups.push({ tag: 'Untagged', items: untagged });

  groups.forEach((group) => {
    const heading = document.createElement('h3');
    heading.className = 'library-group-heading';
    heading.textContent = `${group.tag} (${group.items.length})`;
    libraryListEl.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'library-group-list';
    group.items.forEach((item) => list.appendChild(buildPromptRow(item)));
    libraryListEl.appendChild(list);
  });
}

filterInputEl.addEventListener('input', () => renderLibrary());

// ---------- M1-5 / M1-6 / M1-7: Tab detection, labeling, picker ----------

// The picker, the capture cards and the insert toasts must all call a
// tab the same thing, so they all resolve its name here.
function tabDisplayName(tabId) {
  const tab = detectedTabs.find((t) => t.id === tabId);
  return tabLabels[tabId] || tab?.title || `Tab ${tabId}`;
}

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

function renderTabList() {
  tabListEl.innerHTML = '';

  if (!detectedTabs || detectedTabs.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = 'No open ChatGPT tabs found. Open one, then Refresh.';
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

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error('[Edge Studio] Clipboard write failed:', err);
    return false;
  }
}

document.getElementById('insert-btn').addEventListener('click', async () => {
  const rawText = previewEl.value.trim();
  if (!rawText) {
    showToast('Nothing to insert — build a prompt first.', 'warning');
    return;
  }
  if (selectedTabIds.size === 0) {
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

  for (const tabId of selectedTabIds) {
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
});

// ---------- M1.5-2 / M1.5-3: Optimize ----------
// Per spec decision #4 this never calls an LLM API directly. It writes
// an optimization request into a chat tab Dan already has open, waits
// for that chat to answer, scrapes the answer back out and hands it to
// him to approve, edit or discard.

function buildOptimizationRequest(prompt, target) {
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
function cleanOptimizedPrompt(raw) {
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

document.getElementById('optimize-btn').addEventListener('click', runOptimize);

async function runOptimize() {
  const prompt = previewEl.value.trim();
  if (!prompt) {
    showToast('Build a prompt first.', 'warning');
    return;
  }
  if (detectedTabs.length === 0) {
    showToast('Open a chat tab to run the optimization in, then Refresh.', 'warning');
    return;
  }

  const setup = await openModal({
    title: 'Optimize prompt',
    hint: 'The optimization runs in a chat you already have open. Pick which chat does the work, and which system the result should be tuned for.',
    fields: [
      {
        name: 'workerTabId',
        label: 'Run it in',
        type: 'select',
        value: String([...selectedTabIds][0] ?? detectedTabs[0].id),
        options: detectedTabs.map((t) => ({ value: String(t.id), label: tabDisplayName(t.id) })),
      },
      {
        name: 'target',
        label: 'Optimize for',
        type: 'select',
        value: 'chatgpt',
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
    intro = copied
      ? `Couldn't write into "${workerName}" — the request is on your clipboard. Paste and send it there.`
      : `Couldn't write into "${workerName}" and the clipboard is unavailable. Optimization cancelled.`;
    if (!copied) {
      showToast(intro, 'warning');
      return;
    }
  }

  const optimized = await waitForOptimizedReply(workerTabId, baseline, intro);
  if (optimized === null) return;

  await reviewOptimizedPrompt(optimized, target, workerName);
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
      const stop = () => clearInterval(timer);

      timer = setInterval(async () => {
        const text = await captureFromTab(tabId);
        if (!text || text === baseline) return;

        if (text === lastSeen) {
          stableTicks += 1;
          if (stableTicks >= 2) {
            captured = text;
            stop();
            api.confirm();
          }
        } else {
          lastSeen = text;
          stableTicks = 0;
          api.setBody(`${intro}\n\nAnswer arriving — waiting for it to finish…`);
        }
      }, OPTIMIZE_POLL_MS);
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
    fields: [{ name: 'text', label: 'Rewritten prompt', type: 'textarea', rows: 12, value: optimized }],
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

// ---------- M2-1: Response + selection capture ----------
// Captures are staged in the panel before they're saved. The staged
// text sits in an editable textarea on purpose: trimming a captured
// response down to the part worth keeping is the same action as M2-2's
// "save just this section", so it doesn't need a second mechanism.

async function captureFrom(kind) {
  if (selectedTabIds.size === 0) {
    showToast('Tick a chat tab above to capture from.', 'warning');
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

// Uses the highlighted part of a textarea if there is one, the whole
// value otherwise. This is what makes "turn this bit into a prompt"
// work without a separate selection mode.
function selectedTextOf(textarea) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  if (start !== end) return value.slice(start, end).trim();
  return value.trim();
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

    const appendBtn = document.createElement('button');
    appendBtn.className = 'secondary';
    appendBtn.textContent = 'To builder';
    appendBtn.title = 'Append to the current prompt as a block';
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

// ---------- M2-3: Capture or reply → the builder ----------

function appendTextToBuilder(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    showToast('Nothing to send — that text is empty.', 'warning');
    return;
  }

  // A reply used as input to the next prompt is context, so it lands as
  // a Scenario block by default. The type select on the block makes it
  // one click to change that.
  const type = defaultBlockTypeId();
  canvasBlocks.push({ id: newBlockId(type), type, text: trimmed });
  renderCanvas();
  updatePreview();
  switchTab('prompts');
  showToast(`Added to the builder as a ${blockLabel(type)} block.`);
}

async function startPromptFrom(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    showToast('Nothing selected to build from.', 'warning');
    return;
  }

  if (canvasBlocks.length > 0) {
    const confirmed = await openModal({
      title: 'Start a new prompt',
      body: 'This replaces what\'s currently in the builder. Save it first if you want to keep it.',
      confirmLabel: 'Replace',
      danger: true,
    });
    if (confirmed === null) return;
  }

  setBuilderTo(trimmed);
  switchTab('prompts');
  showToast('New prompt started from the selection.');
}

// ---------- M2-2: Save a capture to the repository ----------

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

// ---------- Saved replies ----------

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
    empty.textContent = q ? 'No matches.' : 'No saved replies yet.';
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
      showToast(ok ? 'Copied as Markdown.' : 'Could not copy to the clipboard.', ok ? 'success' : 'warning');
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

async function init() {
  await loadBlockTypes();
  renderPalette();
  renderCanvas();
  updatePreview();
  await renderLibrary();
  renderCaptures();
  await renderResponses();
  await refreshTabs();
}

init();
