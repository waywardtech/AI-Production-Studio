// Block types (M1-2 / M1.5-1): the palette, and the editor behind
// Blocks → Manage.

import { state } from './state.js';
import { getStoredBlockTypes, saveBlockTypes } from './storage.js';
import { openModal } from '../../shared/modal.js';
import { showToast } from '../../shared/ui.js';

// Seeded on first run; editable from Blocks → Manage after that.
export const DEFAULT_BLOCK_TYPES = [
  { id: 'scenario', label: 'Scenario' },
  { id: 'expertise', label: 'Expertise' },
  { id: 'ask', label: 'Ask' },
  { id: 'format', label: 'Format' },
];

const paletteRowEl = document.getElementById('palette-row');

export async function loadBlockTypes() {
  const stored = await getStoredBlockTypes();
  state.blockTypes = stored && stored.length ? stored : [...DEFAULT_BLOCK_TYPES];
}

export function blockLabel(typeId) {
  const type = state.blockTypes.find((t) => t.id === typeId);
  // A block whose type was deleted still renders — it falls back to the
  // raw id rather than disappearing or blanking out.
  return type ? type.label : typeId;
}

export function defaultBlockTypeId() {
  const scenario = state.blockTypes.find((t) => t.id === 'scenario');
  return scenario ? scenario.id : state.blockTypes[0]?.id || 'scenario';
}

export function renderPalette(onAdd) {
  paletteRowEl.innerHTML = '';

  state.blockTypes.forEach((type) => {
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
    chip.addEventListener('click', () => onAdd(type.id));
    paletteRowEl.appendChild(chip);
  });

  if (state.blockTypes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No block types. Add one with Manage.';
    paletteRowEl.appendChild(empty);
  }
}

function slugifyBlockId(label, taken) {
  const base =
    label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'block';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

export async function openBlockManager({ onSaved }) {
  // Working copy — nothing is persisted unless Dan confirms.
  let working = state.blockTypes.map((t) => ({ ...t }));

  const result = await openModal({
    title: 'Manage blocks',
    hint:
      'Rename, remove or add block types. Blocks already used in saved prompts keep working; a removed type just shows its raw name.',
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
        working.push({
          id: slugifyBlockId(label, new Set(working.map((t) => t.id))),
          label,
        });
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

  state.blockTypes = cleaned;
  await saveBlockTypes(cleaned);
  onSaved();
  showToast('Block types updated.');
}
