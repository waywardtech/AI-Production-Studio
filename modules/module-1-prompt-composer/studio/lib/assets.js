// Column 1 — asset discovery, customization and creation (M4-4/M4-5).
//
// One pool per production. Ticking a tile attaches that asset to the
// current scene, which is what stops the same location and character
// being re-described in every shot; double-clicking a picture promotes
// it to the shot's opening still.

import { state, activeProduction, activeScene } from './state.js';
import { persist } from './repository.js';
import { render } from './render.js';
import { ASSET_CATEGORIES, categoryLabel, newAsset, touch } from './model.js';
import { openModal } from '../../sidepanel/lib/modal.js';
import { showToast } from '../../sidepanel/lib/ui.js';
import { isImage, fileRef, makeThumbnail } from './files.js';

const gridEl = document.getElementById('asset-grid');
const searchEl = document.getElementById('asset-search');
const categoriesEl = document.getElementById('asset-categories');
const countEl = document.getElementById('asset-count');
const fileInputEl = document.getElementById('asset-file-input');

export function visibleAssets() {
  const production = activeProduction();
  if (!production) return [];
  const query = state.assetQuery.trim().toLowerCase();

  return production.assets.filter((asset) => {
    if (state.assetCategory && asset.category !== state.assetCategory) return false;
    if (!query) return true;
    return [asset.name, asset.description, asset.category, ...(asset.tags || [])]
      .join(' ')
      .toLowerCase()
      .includes(query);
  });
}

export function addAssets(assets) {
  const production = activeProduction();
  if (!production) return [];
  const created = assets.map((fields) => newAsset(fields));
  production.assets.unshift(...created);
  touch(production);
  persist();
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
  const production = activeProduction();
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
        onClick: ({ cancel }) => {
          production.assets = production.assets.filter((a) => a.id !== asset.id);
          production.scenes.forEach((scene) => {
            scene.assetIds = scene.assetIds.filter((id) => id !== asset.id);
            if (scene.shot.stillAssetId === asset.id) scene.shot.stillAssetId = null;
          });
          touch(production);
          persist();
          cancel();
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
  touch(production);
  persist();
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

  tile.appendChild(frame);

  const name = document.createElement('div');
  name.className = 'asset-name';
  name.textContent = asset.name;
  tile.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'asset-meta';
  meta.textContent = categoryLabel(asset.category);

  const edit = document.createElement('button');
  edit.className = 'link-btn asset-edit';
  edit.textContent = '✎';
  edit.title = 'Edit asset';
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    editAsset(asset);
  });
  meta.appendChild(edit);
  tile.appendChild(meta);

  tile.addEventListener('click', () => toggleAttached(asset.id));
  tile.addEventListener('dblclick', (e) => {
    e.preventDefault();
    setStill(asset.id);
  });

  return tile;
}

export function renderAssets() {
  const production = activeProduction();
  const assets = visibleAssets();
  const scene = activeScene();

  countEl.textContent = production
    ? `${scene ? scene.assetIds.length : 0} attached · ${production.assets.length} in pool`
    : '';

  // Category chips, with counts, so an empty category is obvious
  // before it's clicked.
  categoriesEl.innerHTML = '';
  const counts = new Map();
  (production?.assets || []).forEach((a) => counts.set(a.category, (counts.get(a.category) || 0) + 1));

  const allChip = document.createElement('button');
  allChip.className = `tag-chip filter${state.assetCategory === null ? ' active' : ''}`;
  allChip.textContent = `All ${production ? production.assets.length : 0}`;
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
    empty.textContent = production && production.assets.length
      ? 'Nothing matches that search.'
      : 'No assets yet. Upload one, add it from a URL, or describe one that does not exist yet.';
    gridEl.appendChild(empty);
    return;
  }

  assets.forEach((asset) => gridEl.appendChild(assetTile(asset)));
}

// ---------- intake ----------

export async function ingestImageFiles(files) {
  const images = [...files].filter(isImage);
  if (images.length === 0) return [];

  const built = [];
  for (const file of images) {
    built.push({
      name: file.name.replace(/\.[^.]+$/, ''),
      category: 'other',
      origin: 'upload',
      thumb: await makeThumbnail(file),
      fileRef: fileRef(file),
      description: '',
    });
  }
  const created = addAssets(built);
  showToast(
    `Added ${created.length} image${created.length === 1 ? '' : 's'}. The originals stay where they are — these are references.`
  );
  return created;
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

export function initAssets() {
  searchEl.addEventListener('input', () => {
    state.assetQuery = searchEl.value;
    renderAssets();
  });

  document.getElementById('asset-upload-btn').addEventListener('click', () => fileInputEl.click());
  fileInputEl.addEventListener('change', async () => {
    await ingestImageFiles(fileInputEl.files);
    fileInputEl.value = '';
  });

  document.getElementById('asset-url-btn').addEventListener('click', addFromUrl);
  document.getElementById('asset-describe-btn').addEventListener('click', addFromDescription);
}
