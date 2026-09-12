// The scene rail: scenes, and the sequences that bundle them (M4-3).
//
// Scenes are the unit of work — one scene is one shot. Sequences are
// the ordered bundles they get produced and reviewed in, which is what
// makes "a page of a comic book" a thing you can hand off in one piece.

import { state, activeProduction, activeScene } from './state.js';
import { persist, persistNow } from './repository.js';
import { render, renderAll } from './render.js';
import { STATUSES, duplicateScene, newId, newProduction, newScene, touch } from './model.js';
import { openModal } from '../../sidepanel/lib/modal.js';
import { showToast } from '../../sidepanel/lib/ui.js';
import { JOB_PROFILES, VIDEO_TARGETS } from './prompt.js';
import { applyProfileDefaults } from './shot.js';

const sceneListEl = document.getElementById('scene-list');
const sequenceListEl = document.getElementById('sequence-list');
const productionSelectEl = document.getElementById('production-select');
const targetSelectEl = document.getElementById('target-select');
const profileSelectEl = document.getElementById('profile-select');

export function selectScene(sceneId) {
  state.activeSceneId = sceneId;
  state.selectedBlockId = null;
  renderAll();
}

function sceneProgress(scene) {
  const filled = scene.blocks.filter((b) => (b.text || '').trim()).length;
  return `${filled}/${scene.blocks.length}`;
}

function sceneRow(scene, index) {
  const li = document.createElement('li');
  li.className = 'scene-item';
  li.classList.toggle('active', scene.id === state.activeSceneId);
  li.draggable = true;

  li.addEventListener('dragstart', () => li.classList.add('dragging'));
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    const production = activeProduction();
    const order = [...sceneListEl.querySelectorAll('.scene-item')].map((el) => el.dataset.sceneId);
    production.scenes.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    touch(production);
    persist();
    render('scenes');
  });
  li.dataset.sceneId = scene.id;

  const number = document.createElement('span');
  number.className = 'scene-number';
  number.textContent = String(index + 1).padStart(2, '0');
  li.appendChild(number);

  const name = document.createElement('span');
  name.className = 'scene-name';
  name.textContent = scene.name;
  li.appendChild(name);

  const progress = document.createElement('span');
  progress.className = 'scene-progress';
  progress.textContent = sceneProgress(scene);
  progress.title = 'Blocks filled';
  li.appendChild(progress);

  if (scene.renders.length) {
    const badge = document.createElement('span');
    badge.className = 'scene-renders';
    badge.textContent = `▶ ${scene.renders.length}`;
    badge.title = `${scene.renders.length} render${scene.renders.length === 1 ? '' : 's'}`;
    li.appendChild(badge);
  }

  li.addEventListener('click', () => selectScene(scene.id));
  li.addEventListener('dblclick', () => renameScene(scene));

  return li;
}

async function renameScene(scene) {
  const values = await openModal({
    title: 'Scene',
    fields: [
      { name: 'name', label: 'Name', value: scene.name },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        value: scene.status,
        options: STATUSES.map((s) => ({ value: s, label: s })),
      },
    ],
    confirmLabel: 'Save',
  });
  if (values === null) return;

  scene.name = values.name.trim() || scene.name;
  scene.status = values.status;
  touch(scene);
  persist();
  render('scenes');
}

export function renderScenes() {
  const production = activeProduction();

  productionSelectEl.innerHTML = '';
  state.productions.forEach((p) => {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = p.name;
    productionSelectEl.appendChild(option);
  });
  productionSelectEl.value = state.activeProductionId;

  targetSelectEl.value = production?.target || VIDEO_TARGETS[0].id;
  profileSelectEl.value = production?.profile || JOB_PROFILES[0].id;

  sceneListEl.innerHTML = '';
  if (!production || production.scenes.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-hint';
    empty.textContent = 'No scenes yet.';
    sceneListEl.appendChild(empty);
  } else {
    production.scenes.forEach((scene, i) => sceneListEl.appendChild(sceneRow(scene, i)));
  }

  renderSequences();
}

function renderSequences() {
  const production = activeProduction();
  sequenceListEl.innerHTML = '';
  if (!production || production.sequences.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = 'No sequences. Bundle scenes to group a run of shots.';
    sequenceListEl.appendChild(empty);
    return;
  }

  production.sequences.forEach((sequence) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'sequence';

    const head = document.createElement('div');
    head.className = 'sequence-head';

    const name = document.createElement('span');
    name.className = 'sequence-name';
    name.textContent = sequence.name;
    head.appendChild(name);

    const count = document.createElement('span');
    count.className = 'sequence-count';
    count.textContent = `${sequence.sceneIds.length}`;
    head.appendChild(count);

    const edit = document.createElement('button');
    edit.className = 'link-btn';
    edit.textContent = '✎';
    edit.addEventListener('click', () => editSequence(sequence));
    head.appendChild(edit);

    wrapper.appendChild(head);

    sequence.sceneIds.forEach((sceneId) => {
      const scene = production.scenes.find((s) => s.id === sceneId);
      if (!scene) return;
      const item = document.createElement('button');
      item.className = 'sequence-scene link-btn';
      item.textContent = scene.name;
      item.addEventListener('click', () => selectScene(scene.id));
      wrapper.appendChild(item);
    });

    sequenceListEl.appendChild(wrapper);
  });
}

// Bundling is a checklist over the production's scenes: a scene can sit
// in more than one sequence, the same way a shot can be used in more
// than one cut.
async function sequenceDialog({ title, name = '', sceneIds = [], confirmLabel, onDelete = null }) {
  const production = activeProduction();
  const checked = new Set(sceneIds);

  const result = await openModal({
    title,
    fields: [{ name: 'name', label: 'Sequence name', value: name }],
    confirmLabel,
    render: (container) => {
      const list = document.createElement('div');
      list.className = 'sequence-picker';
      production.scenes.forEach((scene) => {
        const row = document.createElement('label');
        row.className = 'sequence-pick-row';

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = checked.has(scene.id);
        box.addEventListener('change', () => {
          if (box.checked) checked.add(scene.id);
          else checked.delete(scene.id);
        });
        row.appendChild(box);

        const label = document.createElement('span');
        label.textContent = scene.name;
        row.appendChild(label);

        list.appendChild(row);
      });
      container.appendChild(list);
    },
    extraButtons: onDelete
      ? [{ label: 'Delete', onClick: ({ cancel }) => { onDelete(); cancel(); } }]
      : [],
  });
  if (result === null) return null;

  // Sequence order follows the production's scene order, so a bundle
  // always plays in the order the rail shows.
  return {
    name: result.name.trim(),
    sceneIds: production.scenes.filter((s) => checked.has(s.id)).map((s) => s.id),
  };
}

async function newSequence() {
  const production = activeProduction();
  const result = await sequenceDialog({
    title: 'Bundle scenes into a sequence',
    name: `Sequence ${production.sequences.length + 1}`,
    sceneIds: state.activeSceneId ? [state.activeSceneId] : [],
    confirmLabel: 'Create',
  });
  if (!result) return;

  if (result.sceneIds.length === 0) {
    showToast('Tick at least one scene.', 'warning');
    return;
  }

  production.sequences.push({ id: newId('seq'), name: result.name || 'Untitled sequence', ...result });
  touch(production);
  persist();
  renderSequences();
  showToast(`Bundled ${result.sceneIds.length} scenes.`);
}

async function editSequence(sequence) {
  const production = activeProduction();
  const result = await sequenceDialog({
    title: 'Sequence',
    name: sequence.name,
    sceneIds: sequence.sceneIds,
    confirmLabel: 'Save',
    onDelete: () => {
      production.sequences = production.sequences.filter((s) => s.id !== sequence.id);
      touch(production);
      persist();
      renderSequences();
      showToast(`Deleted "${sequence.name}".`);
    },
  });
  if (!result) return;

  sequence.name = result.name || sequence.name;
  sequence.sceneIds = result.sceneIds;
  touch(production);
  persist();
  renderSequences();
}

// ---------- productions ----------

async function newProductionFlow() {
  const values = await openModal({
    title: 'New production',
    fields: [{ name: 'name', label: 'Name', value: 'Untitled production' }],
    confirmLabel: 'Create',
  });
  if (values === null) return;

  const production = newProduction(values.name.trim() || 'Untitled production');
  state.productions.unshift(production);
  state.activeProductionId = production.id;
  state.activeSceneId = production.scenes[0].id;
  await persistNow();
  renderAll();
  showToast(`"${production.name}" created.`);
}

async function renameProductionFlow() {
  const production = activeProduction();
  const values = await openModal({
    title: 'Production',
    fields: [
      { name: 'name', label: 'Name', value: production.name },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        value: production.status,
        options: STATUSES.map((s) => ({ value: s, label: s })),
      },
    ],
    confirmLabel: 'Save',
    extraButtons: [
      {
        label: 'Delete production',
        onClick: async ({ cancel }) => {
          cancel();
          const confirmed = await openModal({
            title: `Delete "${production.name}"?`,
            body: 'Every scene, asset reference and out-box entry in this production goes with it. This cannot be undone.',
            confirmLabel: 'Delete',
            danger: true,
          });
          if (confirmed === null) return;

          state.productions = state.productions.filter((p) => p.id !== production.id);
          if (state.productions.length === 0) state.productions = [newProduction('First production')];
          state.activeProductionId = state.productions[0].id;
          state.activeSceneId = state.productions[0].scenes[0]?.id || null;
          await persistNow();
          renderAll();
          showToast('Production deleted.');
        },
      },
    ],
  });
  if (values === null) return;

  production.name = values.name.trim() || production.name;
  production.status = values.status;
  touch(production);
  persist();
  renderScenes();
}

export function initScenes() {
  VIDEO_TARGETS.forEach((target) => {
    const option = document.createElement('option');
    option.value = target.id;
    option.textContent = target.label;
    targetSelectEl.appendChild(option);
  });

  JOB_PROFILES.forEach((profile) => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.label;
    profileSelectEl.appendChild(option);
  });

  productionSelectEl.addEventListener('change', async () => {
    state.activeProductionId = productionSelectEl.value;
    state.activeSceneId = activeProduction().scenes[0]?.id || null;
    state.selectedBlockId = null;
    await persistNow();
    renderAll();
  });

  targetSelectEl.addEventListener('change', () => {
    const production = activeProduction();
    production.target = targetSelectEl.value;
    touch(production);
    persist();
    render('shot');
  });

  profileSelectEl.addEventListener('change', () => {
    const production = activeProduction();
    production.profile = profileSelectEl.value;
    touch(production);

    // A profile carries settings — duration, aspect ratio, what to
    // avoid. They fill blanks only, so choosing one never rewrites a
    // value already set by hand.
    const scene = activeScene();
    const filled = scene ? applyProfileDefaults(scene, production.profile) : 0;
    persist();
    render('shot');
    if (filled) showToast(`Profile applied — ${filled} blank setting${filled === 1 ? '' : 's'} filled.`);
  });

  document.getElementById('new-production-btn').addEventListener('click', newProductionFlow);
  document.getElementById('rename-production-btn').addEventListener('click', renameProductionFlow);
  document.getElementById('new-sequence-btn').addEventListener('click', newSequence);

  document.getElementById('new-scene-btn').addEventListener('click', () => {
    const production = activeProduction();
    const scene = newScene(`Scene ${production.scenes.length + 1}`);
    applyProfileDefaults(scene, production.profile);
    production.scenes.push(scene);
    touch(production);
    persist();
    selectScene(scene.id);
  });

  document.getElementById('duplicate-scene-btn').addEventListener('click', () => {
    const production = activeProduction();
    const scene = activeScene();
    if (!scene) return;
    const copy = duplicateScene(scene);
    production.scenes.splice(production.scenes.indexOf(scene) + 1, 0, copy);
    touch(production);
    persist();
    selectScene(copy.id);
    showToast(`Duplicated as "${copy.name}".`);
  });

  document.getElementById('delete-scene-btn').addEventListener('click', async () => {
    const production = activeProduction();
    const scene = activeScene();
    if (!scene) return;

    const confirmed = await openModal({
      title: `Delete "${scene.name}"?`,
      body: scene.renders.length
        ? `This scene has ${scene.renders.length} recorded render${scene.renders.length === 1 ? '' : 's'}. Deleting it removes them from the review list; anything already filed in the out-box stays.`
        : 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (confirmed === null) return;

    production.scenes = production.scenes.filter((s) => s.id !== scene.id);
    production.sequences.forEach((seq) => {
      seq.sceneIds = seq.sceneIds.filter((id) => id !== scene.id);
    });
    touch(production);
    await persistNow();
    state.activeSceneId = production.scenes[0]?.id || null;
    renderAll();
    showToast('Scene deleted.');
  });
}
