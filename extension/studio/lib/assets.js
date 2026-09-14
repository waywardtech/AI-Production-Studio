// Column 1 — asset discovery, customization and creation (M4-4/M4-5).
//
// One pool per project, shared by every production in it — a character
// or a location is reused across productions, not rebuilt for each.
// Clicking a tile attaches that asset to the current scene, which is what stops the same location and character
// being re-described in every shot; double-clicking a picture promotes
// it to the shot's opening still.

import { state, activeProduction, activeScene } from './state.js';
import { deleteAsset, persist, saveAsset, saveAssets } from './repository.js';
import { render } from './render.js';
import { ASSET_CATEGORIES, categoryLabel, newAsset, touch } from './model.js';
import { openModal } from '../../shared/modal.js';
import { showToast } from '../../shared/ui.js';
import { FILE_KINDS, baseName, fileKind, isReadableText, makeThumbnail, readText, storeBytes } from './files.js';
import { blobs, formatBytes, MAX_STORED_BYTES } from '../../shared/blobs.js';

const gridEl = document.getElementById('asset-grid');
const searchEl = document.getElementById('asset-search');
const categoriesEl = document.getElementById('asset-categories');
const countEl = document.getElementById('asset-count');
const fileInputEl = document.getElementById('asset-file-input');

export function visibleAssets() {
  const query = state.assetQuery.trim().toLowerCase();

  return state.assets.filter((asset) => {
    if (state.assetCategory && asset.category !== state.assetCategory) return false;
    if (!query) return true;
    return [asset.name, asset.description, asset.category, ...(asset.tags || [])]
      .join(' ')
      .toLowerCase()
      .includes(query);
  });
}

export function addAssets(assets) {
  const created = assets.map((fields) => newAsset({ ...fields, projectId: state.projectId }));
  state.assets.unshift(...created);
  saveAssets(created).catch((err) => console.error('[Edge Studio] Saving assets failed:', err));
  render('assets');
  return created;
}

function toggleAttached(assetId) {
  const scene = activeScene();
  if (!scene) return;
  const index = scene.assetIds.indexOf(assetId);
  if (index === -1) scene.assetIds.push(assetId);
  else {
    scene.assetIds.splice(index, 1);
    if (scene.shot.stillAssetId === assetId) scene.shot.stillAssetId = null;
  }
  touch(scene);
  persist();
  render('assets', 'shot');
}

function setStill(assetId) {
  const scene = activeScene();
  if (!scene) return;
  scene.shot.stillAssetId = scene.shot.stillAssetId === assetId ? null : assetId;
  // The still is a reference like any other, so it counts as attached.
  if (scene.shot.stillAssetId && !scene.assetIds.includes(assetId)) scene.assetIds.push(assetId);
  touch(scene);
  persist();
  render('assets', 'shot');
}

async function editAsset(asset) {
  const values = await openModal({
    title: 'Edit asset',
    fields: [
      { name: 'name', label: 'Name', value: asset.name },
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        value: asset.category,
        options: ASSET_CATEGORIES.map((c) => ({ value: c.id, label: c.label })),
      },
      { name: 'description', label: 'Description', type: 'textarea', rows: 4, value: asset.description },
      { name: 'sourceUrl', label: 'Source URL', value: asset.sourceUrl },
      { name: 'tags', label: 'Tags (comma separated)', value: (asset.tags || []).join(', ') },
    ],
    confirmLabel: 'Save',
    extraButtons: [
      {
        label: 'Delete',
        onClick: async ({ cancel }) => {
          cancel();
          // Assets are project-wide, so it can be in use across several
          // productions, not just this one.
          const usedIn = state.productions.flatMap((production) =>
            production.scenes
              .filter((scene) => scene.assetIds.includes(asset.id))
              .map((scene) => ({ production, scene }))
          );
          const asStill = usedIn.filter(({ scene }) => scene.shot.stillAssetId === asset.id).length;
          const productionCount = new Set(usedIn.map(({ production }) => production.id)).size;
          const confirmed = await openModal({
            title: `Delete "${asset.name}"?`,
            body:
              (usedIn.length
                ? `It's attached to ${usedIn.length} scene${usedIn.length === 1 ? '' : 's'}` +
                  (productionCount > 1 ? ` across ${productionCount} productions` : '') +
                  (asStill ? ` and is the opening frame of ${asStill}` : '') +
                  ', and comes out of all of them. '
                : '') + 'This cannot be undone.',
            confirmLabel: 'Delete',
            danger: true,
          });
          if (confirmed === null) return;

          usedIn.forEach(({ production, scene }) => {
            scene.assetIds = scene.assetIds.filter((id) => id !== asset.id);
            if (scene.shot.stillAssetId === asset.id) scene.shot.stillAssetId = null;
            touch(scene);
            persist(production);
          });
          if (asset.fileRef?.blobId) await blobs.remove(asset.fileRef.blobId);
          await deleteAsset(asset.id);
          render('assets', 'shot');
          showToast(`Deleted "${asset.name}".`);
        },
      },
    ],
  });
  if (values === null) return;

  Object.assign(asset, {
    name: values.name.trim() || asset.name,
    category: values.category,
    description: values.description.trim(),
    sourceUrl: values.sourceUrl.trim(),
    tags: values.tags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  });
  await saveAsset(asset);
  render('assets', 'shot');
}

function assetTile(asset) {
  const scene = activeScene();
  const attached = !!scene && scene.assetIds.includes(asset.id);
  const isStill = !!scene && scene.shot.stillAssetId === asset.id;

  const tile = document.createElement('div');
  tile.className = 'asset-tile';
  tile.classList.toggle('attached', attached);
  tile.classList.toggle('still', isStill);
  tile.title = asset.description || asset.name;

  const frame = document.createElement('div');
  frame.className = 'asset-thumb';
  if (asset.thumb) {
    const img = document.createElement('img');
    img.src = asset.thumb;
    img.alt = asset.name;
    frame.appendChild(img);
  } else {
    // A described asset has no picture yet — the category initial keeps
    // the grid readable until one is generated or dropped in.
    const glyph = document.createElement('span');
    glyph.className = 'asset-glyph';
    glyph.textContent = categoryLabel(asset.category).slice(0, 1);
    frame.appendChild(glyph);
  }

  const tick = document.createElement('span');
  tick.className = 'asset-tick';
  tick.textContent = attached ? '✓' : '';
  frame.appendChild(tick);

  if (isStill) {
    const badge = document.createElement('span');
    badge.className = 'still-badge';
    badge.textContent = 'STILL';
    frame.appendChild(badge);
  }

  // What kind of file this is, and whether its bytes are actually here.
  // An asset that can't be attached should say so on the tile rather
  // than at the moment Produce tries to send it.
  const ref = asset.fileRef;
  if (ref) {
    const kind = document.createElement('span');
    kind.className = 'file-badge';
    kind.dataset.kind = ref.kind || 'other';
    kind.textContent = FILE_KINDS[ref.kind]?.label || 'File';
    if (ref.stored) {
      kind.title = `${ref.name} · ${formatBytes(ref.size)} · attachable`;
    } else {
      kind.classList.add('reference-only');
      kind.title = ref.tooLarge
        ? `${ref.name} · ${formatBytes(ref.size)} — too big to hold, so it can't be attached`
        : `${ref.name} · reference only — the file itself isn't held here`;
    }
    frame.appendChild(kind);
  }

  tile.appendChild(frame);

  const name = document.createElement('div');
  name.className = 'asset-name';
  name.textContent = asset.name;
  tile.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'asset-meta';

  const category = document.createElement('span');
  category.textContent = categoryLabel(asset.category);
  meta.appendChild(category);

  const controls = document.createElement('span');
  controls.className = 'asset-controls';

  // Setting the still is its own button rather than a double-click on
  // the tile. A double-click is two clicks first, and each click toggles
  // attachment — so un-setting a still by double-clicking could never
  // work, and setting one briefly detached the asset.
  if (asset.thumb) {
    const star = document.createElement('button');
    star.className = 'link-btn asset-still-btn';
    star.classList.toggle('active', isStill);
    star.textContent = isStill ? '★' : '☆';
    star.title = isStill ? 'Stop using as the opening frame' : 'Use as the opening frame';
    star.setAttribute('aria-pressed', String(isStill));
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      setStill(asset.id);
    });
    controls.appendChild(star);
  }

  const edit = document.createElement('button');
  edit.className = 'link-btn asset-edit';
  edit.textContent = '✎';
  edit.title = 'Edit asset';
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    editAsset(asset);
  });
  controls.appendChild(edit);
  meta.appendChild(controls);
  tile.appendChild(meta);

  tile.setAttribute('role', 'checkbox');
  tile.setAttribute('aria-checked', String(attached));
  tile.tabIndex = 0;
  tile.addEventListener('click', () => toggleAttached(asset.id));
  tile.addEventListener('keydown', (e) => {
    if (e.target !== tile) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggleAttached(asset.id);
    }
  });

  return tile;
}

export function renderAssets() {
  const assets = visibleAssets();
  const scene = activeScene();

  countEl.textContent = `${scene ? scene.assetIds.length : 0} attached · ${state.assets.length} in ${state.projectName || 'the project'}`;

  // Category chips, with counts, so an empty category is obvious
  // before it's clicked.
  categoriesEl.innerHTML = '';
  const counts = new Map();
  state.assets.forEach((a) => counts.set(a.category, (counts.get(a.category) || 0) + 1));

  const allChip = document.createElement('button');
  allChip.className = `tag-chip filter${state.assetCategory === null ? ' active' : ''}`;
  allChip.textContent = `All ${state.assets.length}`;
  allChip.addEventListener('click', () => {
    state.assetCategory = null;
    renderAssets();
  });
  categoriesEl.appendChild(allChip);

  ASSET_CATEGORIES.filter((c) => counts.get(c.id)).forEach((category) => {
    const chip = document.createElement('button');
    chip.className = `tag-chip filter${state.assetCategory === category.id ? ' active' : ''}`;
    chip.textContent = `${category.label} ${counts.get(category.id)}`;
    chip.addEventListener('click', () => {
      state.assetCategory = state.assetCategory === category.id ? null : category.id;
      renderAssets();
    });
    categoriesEl.appendChild(chip);
  });

  gridEl.innerHTML = '';
  if (assets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = state.assets.length
      ? 'Nothing matches that search.'
      : 'No assets yet. Upload one, add it from a URL, or describe one that does not exist yet.';
    gridEl.appendChild(empty);
    return;
  }

  assets.forEach((asset) => gridEl.appendChild(assetTile(asset)));
}

// ---------- intake ----------

// Local import (M5-1). Anything Dan drops or picks: images, clips,
// audio, scripts, PDFs. Images and video get a thumbnail, readable text
// gets read into the record, and everything under the size limit gets
// its bytes kept so it can be attached to a chat later.
//
// Returns { assets, texts } — texts are the readable scripts and notes,
// which the caller files in the In-box rather than the asset pool.
export async function ingestFiles(files, { category = null } = {}) {
  const list = [...files];
  if (list.length === 0) return { assets: [], texts: [] };

  const built = [];
  const texts = [];
  const skipped = [];

  for (const file of list) {
    const kind = fileKind(file);

    if (isReadableText(file)) {
      texts.push({ name: file.name, text: await readTextSafely(file), kind: kind === 'script' ? 'script' : 'note' });
      continue;
    }

    const ref = await storeBytes(file);
    if (ref.tooLarge) skipped.push(file.name);

    built.push({
      name: baseName(file.name),
      category: category || FILE_KINDS[kind]?.category || 'other',
      origin: 'upload',
      thumb: await makeThumbnail(file),
      fileRef: ref,
      description: '',
    });
  }

  const created = built.length ? addAssets(built) : [];

  if (created.length) {
    const held = created.filter((a) => a.fileRef?.stored).length;
    showToast(
      `Added ${created.length} file${created.length === 1 ? '' : 's'}` +
        (held ? `, ${held} held here and ready to attach.` : '.')
    );
  }
  if (skipped.length) {
    showToast(
      `${skipped.length} file${skipped.length === 1 ? ' is' : 's are'} over ${formatBytes(MAX_STORED_BYTES)} — kept as a reference, not attachable.`,
      'warning'
    );
  }

  return { assets: created, texts };
}

async function readTextSafely(file) {
  try {
    return await readText(file);
  } catch (error) {
    console.error('[Edge Studio] Could not read text file:', error);
    return '';
  }
}

async function addFromUrl() {
  const values = await openModal({
    title: 'Add asset from a URL',
    hint: 'The source URL is kept with the asset so a reference can always be traced back to where it came from.',
    fields: [
      { name: 'sourceUrl', label: 'Image or page URL' },
      { name: 'name', label: 'Name' },
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        value: 'location',
        options: ASSET_CATEGORIES.map((c) => ({ value: c.id, label: c.label })),
      },
      { name: 'description', label: 'Description', type: 'textarea', rows: 3 },
    ],
    confirmLabel: 'Add',
  });
  if (values === null) return;

  const sourceUrl = values.sourceUrl.trim();
  if (!sourceUrl) {
    showToast('A URL is needed to add an asset this way.', 'warning');
    return;
  }

  // An image URL can be shown directly; anything else (a page, a Drive
  // link) is kept as a reference with no thumbnail.
  const looksLikeImage = /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(sourceUrl);

  addAssets([
    {
      name: values.name.trim() || sourceUrl.split('/').pop() || 'Reference',
      category: values.category,
      description: values.description.trim(),
      sourceUrl,
      thumb: looksLikeImage ? sourceUrl : null,
      origin: 'web',
    },
  ]);
  showToast('Asset added.');
}

// "Describe" is the third path in the sketch: an asset that doesn't
// exist yet, recorded so the shot can be built around it and it can be
// generated later.
async function addFromDescription() {
  const values = await openModal({
    title: 'Describe an asset',
    hint: "For something that doesn't exist yet. It joins the pool as a description the prompt can use, and a picture can be attached later.",
    fields: [
      { name: 'name', label: 'Name' },
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        value: 'character',
        options: ASSET_CATEGORIES.map((c) => ({ value: c.id, label: c.label })),
      },
      { name: 'description', label: 'Description', type: 'textarea', rows: 5 },
    ],
    confirmLabel: 'Add',
  });
  if (values === null) return;

  const name = values.name.trim();
  if (!name) {
    showToast('Give it a name so it can be found again.', 'warning');
    return;
  }

  addAssets([
    {
      name,
      category: values.category,
      description: values.description.trim(),
      origin: 'described',
    },
  ]);
  showToast('Described asset added to the pool.');
}

// boxes.js owns the In-box; assets.js shouldn't have to know about it,
// so the entry point joins the two.
let onTextFiles = null;

export function initAssets({ onTextFiles: handler = null } = {}) {
  onTextFiles = handler;
  searchEl.addEventListener('input', () => {
    state.assetQuery = searchEl.value;
    renderAssets();
  });

  document.getElementById('asset-upload-btn').addEventListener('click', () => fileInputEl.click());
  fileInputEl.addEventListener('change', async () => {
    const { texts } = await ingestFiles(fileInputEl.files);
    fileInputEl.value = '';
    // A script picked through Upload is still a script: hand it to
    // whoever wired the In-box up rather than dropping it.
    if (texts.length && onTextFiles) await onTextFiles(texts);
  });

  document.getElementById('asset-url-btn').addEventListener('click', addFromUrl);
  document.getElementById('asset-describe-btn').addEventListener('click', addFromDescription);
}
