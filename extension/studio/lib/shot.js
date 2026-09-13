// Column 3 — the scene builder: a still, the aspects that describe how
// it's shot, the refine box, and the assembled prompt (M4-7/M4-8).
//
// The preview is rendered segment by segment rather than as one string
// so selecting a block in column 2 can highlight exactly what that
// block contributes. That's the "preview for each block to check how
// changes impact the overall result" from the notes: the whole prompt
// stays on screen, and the part under discussion lights up inside it.

import { state, activeProduction, activeScene } from './state.js';
import { persist } from './repository.js';
import { render } from './render.js';
import { ASPECTS, touch } from './model.js';
import { assembleSegments, segmentText, profileById, releaseFromProfile } from './prompt.js';
import { copyToClipboard, showToast } from '../../shared/ui.js';

const stillEl = document.getElementById('still-slot');
const aspectListEl = document.getElementById('aspect-list');
const previewEl = document.getElementById('prompt-preview');
const refineInputEl = document.getElementById('refine-input');
const refineLogEl = document.getElementById('refine-log');
const toggleAspectsBtn = document.getElementById('toggle-aspects-btn');

export function currentPromptText() {
  const production = activeProduction();
  const scene = activeScene();
  if (!production || !scene) return '';
  return assembleSegments(production, scene).map(segmentText).join('\n\n');
}

function renderStill() {
  const production = activeProduction();
  const scene = activeScene();
  stillEl.innerHTML = '';
  if (!scene) return;

  const asset = scene.shot.stillAssetId
    ? production.assets.find((a) => a.id === scene.shot.stillAssetId)
    : null;

  if (!asset) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = 'No opening frame. Press ★ on a picture in column 1 to use it as the still this shot builds from.';
    stillEl.appendChild(empty);
    return;
  }

  if (asset.thumb) {
    const img = document.createElement('img');
    img.src = asset.thumb;
    img.alt = asset.name;
    stillEl.appendChild(img);
  }

  const caption = document.createElement('div');
  caption.className = 'still-caption';
  caption.textContent = asset.name;

  const clear = document.createElement('button');
  clear.className = 'link-btn';
  clear.textContent = 'Clear';
  clear.addEventListener('click', () => {
    scene.shot.stillAssetId = null;
    touch(scene);
    persist();
    render('assets', 'shot');
  });
  caption.appendChild(clear);
  stillEl.appendChild(caption);
}

function aspectRow(aspect, scene) {
  const row = document.createElement('div');
  row.className = 'aspect-row';
  row.classList.toggle('blank', !(scene.shot.aspects[aspect.id] || '').trim());

  const label = document.createElement('label');
  label.className = 'field-label';
  label.textContent = aspect.label;
  label.setAttribute('for', `aspect-${aspect.id}`);
  row.appendChild(label);

  const input = document.createElement('input');
  input.type = 'text';
  input.id = `aspect-${aspect.id}`;
  input.value = scene.shot.aspects[aspect.id] || '';
  input.placeholder = aspect.placeholder || '';
  input.addEventListener('input', () => {
    scene.shot.aspects[aspect.id] = input.value;
    // Typed by hand, so it's Dan's now — a profile switch won't touch it.
    releaseFromProfile(scene, aspect.id);
    touch(scene);
    persist();
    renderPreview();
  });
  // Blank/filled styling changes the row's border, and doing it on blur
  // rather than per keystroke keeps the field from flickering.
  input.addEventListener('blur', () => {
    row.classList.toggle('blank', !input.value.trim());
  });
  row.appendChild(input);

  return row;
}

function renderAspects() {
  const scene = activeScene();
  aspectListEl.innerHTML = '';
  if (!scene) return;

  const shown = ASPECTS.filter((a) => state.showAdvancedAspects || !a.advanced);
  shown.forEach((aspect) => aspectListEl.appendChild(aspectRow(aspect, scene)));

  toggleAspectsBtn.textContent = state.showAdvancedAspects ? 'Fewer' : 'More';
}

function renderRefineLog() {
  const scene = activeScene();
  refineLogEl.innerHTML = '';
  if (!scene || scene.refinements.length === 0) return;

  scene.refinements
    .slice()
    .reverse()
    .forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'refine-entry';

      const text = document.createElement('span');
      text.textContent = entry.text;
      item.appendChild(text);

      const meta = document.createElement('span');
      meta.className = 'refine-meta';
      meta.textContent = entry.applied ? `${entry.applied} field${entry.applied === 1 ? '' : 's'}` : 'no change';
      item.appendChild(meta);

      refineLogEl.appendChild(item);
    });
}

export function renderPreview() {
  const production = activeProduction();
  const scene = activeScene();
  previewEl.innerHTML = '';
  if (!production || !scene) return;

  const segments = assembleSegments(production, scene);
  if (segments.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = 'Nothing to preview yet — fill a block or an aspect.';
    previewEl.appendChild(empty);
    return;
  }

  segments.forEach((segment) => {
    const part = document.createElement('div');
    part.className = 'preview-segment';
    part.classList.toggle('highlight', !!segment.blockId && segment.blockId === state.selectedBlockId);

    const label = document.createElement('span');
    label.className = 'preview-label';
    label.textContent = segment.label;
    part.appendChild(label);

    const body = document.createElement('span');
    body.className = 'preview-text';
    body.textContent = segment.text;
    part.appendChild(body);

    previewEl.appendChild(part);
  });

  const profile = profileById(production.profile);
  const footer = document.createElement('div');
  footer.className = 'preview-footer';
  footer.textContent = `${segments.length} parts · ${currentPromptText().length} characters · ${profile.label}`;
  previewEl.appendChild(footer);
}

export function renderShot() {
  renderStill();
  renderAspects();
  renderRefineLog();
  renderPreview();
}

export function initShot({ onRefine }) {
  toggleAspectsBtn.addEventListener('click', () => {
    state.showAdvancedAspects = !state.showAdvancedAspects;
    renderAspects();
  });

  document.getElementById('copy-prompt-btn').addEventListener('click', async () => {
    const text = currentPromptText();
    if (!text) {
      showToast('Nothing to copy yet.', 'warning');
      return;
    }
    const ok = await copyToClipboard(text);
    showToast(ok ? 'Assembled shot copied.' : 'Could not copy.', ok ? 'success' : 'warning');
  });

  document.getElementById('clear-refine-log-btn').addEventListener('click', () => {
    const scene = activeScene();
    if (!scene) return;
    scene.refinements = [];
    persist();
    renderRefineLog();
  });

  const submitRefine = async () => {
    const instruction = refineInputEl.value.trim();
    if (!instruction) {
      showToast('Say what should change.', 'warning');
      return;
    }
    // Only cleared once the refine actually ran — cancelling the tab
    // picker or the wait keeps what was typed.
    const ran = await onRefine(instruction);
    if (ran && refineInputEl.value.trim() === instruction) refineInputEl.value = '';
  };

  document.getElementById('refine-btn').addEventListener('click', submitRefine);
  refineInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitRefine();
  });
}
