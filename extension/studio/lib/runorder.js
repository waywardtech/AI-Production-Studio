// Column 2 — the blocks of the script for the scene, in running order
// (M4-6).
//
// A block is one part of the shot: where it is, what's in it, what
// happens, what's said. Blank blocks are what the seed pass fills, so
// they're marked rather than hidden — an empty Dialogue block is a
// decision waiting to be made, not a missing feature.

import { state, activeProduction, activeScene } from './state.js';
import { persist } from './repository.js';
import { render } from './render.js';
import { BLOCK_TYPES, blockLabel, newBlock, touch } from './model.js';
import { openModal } from '../../shared/modal.js';
import { showToast } from '../../shared/ui.js';

const listEl = document.getElementById('block-list');
const seedEl = document.getElementById('scene-seed');
const blankCountEl = document.getElementById('blank-count');

function commitOrderFromDom() {
  const scene = activeScene();
  if (!scene) return;
  const order = [...listEl.querySelectorAll('.block-card')].map((el) => el.dataset.blockId);
  scene.blocks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  touch(scene);
  persist();
  render('shot');
}

// Which card the dragged one should land in front of, by pointer
// position — the usual midpoint test, so the gap opens where the cursor
// actually is rather than where the drag started.
function cardAfter(y) {
  const cards = [...listEl.querySelectorAll('.block-card:not(.dragging)')];
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  cards.forEach((card) => {
    const box = card.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = card;
    }
  });
  return closest;
}

function blockCard(block) {
  const scene = activeScene();
  const blank = !(block.text || '').trim();

  const card = document.createElement('div');
  card.className = 'block-card';
  card.dataset.blockId = block.id;
  card.dataset.blockType = block.type;
  card.classList.toggle('blank', blank);
  card.classList.toggle('selected', state.selectedBlockId === block.id);
  card.draggable = true;

  card.addEventListener('dragstart', () => {
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    commitOrderFromDom();
  });

  const head = document.createElement('div');
  head.className = 'block-head';

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.textContent = '⠿';
  handle.title = 'Drag to reorder';
  head.appendChild(handle);

  const select = document.createElement('select');
  select.className = 'block-type-select';
  BLOCK_TYPES.forEach((type) => {
    const option = document.createElement('option');
    option.value = type.id;
    option.textContent = type.label;
    select.appendChild(option);
  });
  select.value = block.type;
  select.addEventListener('change', () => {
    block.type = select.value;
    touch(scene);
    persist();
    renderRunOrder();
    render('shot');
  });
  head.appendChild(select);

  if (blank) {
    const badge = document.createElement('span');
    badge.className = 'blank-badge';
    badge.textContent = 'blank';
    head.appendChild(badge);
  }

  const remove = document.createElement('span');
  remove.className = 'remove-block';
  remove.textContent = '✕';
  remove.title = 'Remove block';
  remove.addEventListener('click', () => {
    scene.blocks = scene.blocks.filter((b) => b.id !== block.id);
    if (state.selectedBlockId === block.id) state.selectedBlockId = null;
    touch(scene);
    persist();
    renderRunOrder();
    render('shot');
  });
  head.appendChild(remove);

  card.appendChild(head);

  const textarea = document.createElement('textarea');
  textarea.value = block.text || '';
  textarea.placeholder = BLOCK_TYPES.find((t) => t.id === block.type)?.hint || `${blockLabel(block.type)}…`;
  textarea.addEventListener('input', () => {
    const wasBlank = blank;
    block.text = textarea.value;
    touch(scene);
    persist();
    // Only a full re-render when the blank state flips, so typing
    // doesn't yank the caret out of the textarea.
    if (wasBlank !== !textarea.value.trim()) renderRunOrder();
    render('shot');
  });
  // Selecting a block is what highlights its segment in the assembled
  // prompt over in column 3 (M4-8).
  textarea.addEventListener('focus', () => {
    state.selectedBlockId = block.id;
    listEl.querySelectorAll('.block-card').forEach((el) => {
      el.classList.toggle('selected', el.dataset.blockId === block.id);
    });
    render('shot');
  });
  card.appendChild(textarea);

  return card;
}

export function renderRunOrder() {
  const scene = activeScene();
  listEl.innerHTML = '';

  if (!scene) {
    blankCountEl.textContent = '';
    seedEl.value = '';
    seedEl.disabled = true;
    return;
  }

  seedEl.disabled = false;
  if (seedEl.value !== scene.seed) seedEl.value = scene.seed;

  const blanks = scene.blocks.filter((b) => !(b.text || '').trim()).length;
  blankCountEl.textContent = blanks
    ? `${blanks} blank of ${scene.blocks.length}`
    : `${scene.blocks.length} blocks, all filled`;

  scene.blocks.forEach((block) => listEl.appendChild(blockCard(block)));
}

async function addBlock() {
  const scene = activeScene();
  if (!scene) return;

  const values = await openModal({
    title: 'Add a block',
    fields: [
      {
        name: 'type',
        label: 'Block',
        type: 'select',
        value: 'characters',
        options: BLOCK_TYPES.map((t) => ({ value: t.id, label: t.label })),
      },
    ],
    confirmLabel: 'Add',
  });
  if (values === null) return;

  scene.blocks.push(newBlock(values.type));
  touch(scene);
  persist();
  renderRunOrder();
  render('shot');
  showToast(`${blockLabel(values.type)} block added.`);
}

export function initRunOrder() {
  seedEl.addEventListener('input', () => {
    const scene = activeScene();
    if (!scene) return;
    scene.seed = seedEl.value;
    touch(scene);
    touch(activeProduction());
    persist();
  });

  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    const dragging = listEl.querySelector('.dragging');
    if (!dragging) return;
    const after = cardAfter(e.clientY);
    if (after) listEl.insertBefore(dragging, after);
    else listEl.appendChild(dragging);
  });

  document.getElementById('add-block-btn').addEventListener('click', addBlock);
}
