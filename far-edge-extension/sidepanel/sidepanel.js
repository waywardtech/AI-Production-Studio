// Far Edge Studio — side panel logic
// Covers: M1-2 (builder), M1-3 (library, local-storage stand-in for
// CORE-4 until Drive OAuth is wired), M1-4 (filter + flat list),
// M1-6 (tab labeling), M1-7 (destination picker), M1-9 (clipboard fallback)

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

const canvasEl = document.getElementById('canvas');
const previewEl = document.getElementById('preview');
const libraryListEl = document.getElementById('library-list');
const filterInputEl = document.getElementById('filter-input');
const tabListEl = document.getElementById('tab-list');
const toastEl = document.getElementById('toast');

// ---------- Storage helpers (M1-3 local stand-in for CORE-4) ----------

async function getLibrary() {
  const { library } = await chrome.storage.local.get('library');
  return library || [];
}

async function saveLibrary(library) {
  await chrome.storage.local.set({ library });
}

async function getTabLabels() {
  const { tabLabels: stored } = await chrome.storage.local.get('tabLabels');
  return stored || {};
}

async function saveTabLabels(labels) {
  await chrome.storage.local.set({ tabLabels: labels });
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
  const title = prompt('Name this prompt:');
  if (!title) return;

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
  renderLibrary();
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
      const lib = await getLibrary();
      await saveLibrary(lib.filter((x) => x.id !== item.id));
      renderLibrary(filterInputEl.value);
    });
    li.appendChild(del);

    libraryListEl.appendChild(li);
  });
}

filterInputEl.addEventListener('input', (e) => renderLibrary(e.target.value));

// ---------- M1-5 / M1-6 / M1-7: Tab detection, labeling, destination picker ----------

async function refreshTabs() {
  detectedTabs = await chrome.runtime.sendMessage({ type: 'FAR_EDGE_GET_TABS' });
  tabLabels = await getTabLabels();
  renderTabList();
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
    labelInput.value = tabLabels[tab.id] || tab.title || `Tab ${tab.id}`;
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
  const text = previewEl.value.trim();
  if (!text) {
    showToast('Nothing to insert — build a prompt first.', 'warning');
    return;
  }
  if (selectedTabIds.size === 0) {
    showToast('Select at least one destination tab.', 'warning');
    return;
  }

  let successCount = 0;
  let fallbackCount = 0;

  for (const tabId of selectedTabIds) {
    const label = tabLabels[tabId] || `Tab ${tabId}`;
    const result = await chrome.runtime.sendMessage({
      type: 'FAR_EDGE_SEND_TO_TAB',
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
        console.error('[Far Edge Studio] Clipboard write failed:', err);
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

// ---------- Init ----------

renderCanvas();
updatePreview();
renderLibrary();
refreshTabs();
