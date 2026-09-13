// The builder canvas (M1-2) and everything that puts text into it.

import { state, newBlockId } from './state.js';
import { blockLabel, defaultBlockTypeId } from './blocks.js';
import { openModal } from '../../shared/modal.js';
import { showToast, switchTab } from '../../shared/ui.js';
import { updateCostEstimate } from './usage.js';

const canvasEl = document.getElementById('canvas');
const previewEl = document.getElementById('preview');

export function assembledPrompt() {
  return previewEl.value.trim();
}

export function updatePreview() {
  previewEl.value = state.canvasBlocks
    .map((b) => (b.text || '').trim())
    .filter(Boolean)
    .join('\n\n');
  // The cost of what's about to be sent should be visible before
  // Insert, not after (spec §Usage, P0).
  updateCostEstimate();
}

export function renderCanvas() {
  canvasEl.innerHTML = '';

  if (state.canvasBlocks.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = 'Drag blocks here to build a prompt.';
    canvasEl.appendChild(hint);
  }

  state.canvasBlocks.forEach((block) => {
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
    const options = [...state.blockTypes];
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
      state.canvasBlocks = state.canvasBlocks.filter((b) => b.id !== block.id);
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

export function addBlock(type) {
  state.canvasBlocks.push({ id: newBlockId(type), type, text: '' });
  renderCanvas();
  updatePreview();
}

export function setBuilderTo(text, type = null) {
  const blockType = type || defaultBlockTypeId();
  state.canvasBlocks = [{ id: newBlockId(blockType), type: blockType, text }];
  renderCanvas();
  updatePreview();
}

export function loadBlocksIntoBuilder(blocks) {
  state.canvasBlocks = blocks.map((b) => ({ ...b, id: newBlockId(b.type) }));
  renderCanvas();
  updatePreview();
}

// ---------- M2-3: capture or reply → the builder ----------

export function appendTextToBuilder(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    showToast('Nothing to send — that text is empty.', 'warning');
    return;
  }

  // A reply used as input to the next prompt is context, so it lands as
  // a Scenario block by default. The type select on the block makes it
  // one click to change that.
  const type = defaultBlockTypeId();
  state.canvasBlocks.push({ id: newBlockId(type), type, text: trimmed });
  renderCanvas();
  updatePreview();
  switchTab('prompts');
  showToast(`Added to the builder as a ${blockLabel(type)} block.`);
}

export async function startPromptFrom(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    showToast('Nothing selected to build from.', 'warning');
    return;
  }

  if (state.canvasBlocks.length > 0) {
    const confirmed = await openModal({
      title: 'Start a new prompt',
      body: "This replaces what's currently in the builder. Save it first if you want to keep it.",
      confirmLabel: 'Replace',
      danger: true,
    });
    if (confirmed === null) return;
  }

  setBuilderTo(trimmed);
  switchTab('prompts');
  showToast('New prompt started from the selection.');
}

export function initBuilder() {
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
    state.canvasBlocks = [];
    renderCanvas();
    updatePreview();
  });
}
