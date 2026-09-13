// The studio's data access, on top of the shared record store.
//
// A production, each asset and each document is its own record, so
// typing in a scene rewrites one production — not the whole asset pool
// with its thumbnails, and not every other production in the project.
//
// Writes to a production are coalesced: typing in a block would
// otherwise hit storage on every keystroke. Anything that must be on
// disk before the page could close (creating or deleting, filing to the
// out-box) awaits persistNow() directly.

import { state, activeProduction } from './state.js';
import { newProduction } from './model.js';
import { getSetting, list, put, putMany, remove, updateSetting } from '../../shared/store.js';

// ---------- loading ----------

// Productions saved before the out-box stopped keeping per-clip copies,
// or before assets and boxes moved out of the production, are tidied as
// they load. The migration already does this; this catches anything
// written by an older build since.
function tidyProduction(production) {
  delete production.assets;
  delete production.inbox;
  delete production.outbox;
  production.sequences = production.sequences || [];
  production.scenes = production.scenes || [];
  return production;
}

export async function loadProject(project) {
  // Anything typed in the project being left (or renamed) is written
  // before its data is reloaded, not dropped.
  await persistNow();
  state.projectId = project.id;
  state.projectName = project.name;

  let productions = (await list('productions', { projectId: project.id })).map(tidyProduction);
  if (productions.length === 0) {
    const first = newProduction({ projectId: project.id, name: 'First production' });
    await put('productions', first);
    productions = [first];
  }
  state.productions = productions.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  state.assets = await list('assets', { projectId: project.id });
  state.documents = await list('documents', { projectId: project.id });

  const app = (await getSetting('app', {})) || {};
  const remembered = state.productions.find((p) => p.id === app.activeProductionId);
  selectProductionLocally((remembered || state.productions[0]).id);
}

function selectProductionLocally(productionId) {
  state.activeProductionId = productionId;
  state.activeSceneId = activeProduction()?.scenes[0]?.id || null;
  state.selectedBlockId = null;
}

export async function setActiveProduction(productionId) {
  await persistNow();
  selectProductionLocally(productionId);
  await updateSetting('app', { activeProductionId: productionId });
}

// ---------- productions ----------

const dirty = new Set();
let pending = null;

// Marks a production as changed and schedules the write. Defaults to the
// active production, which is what nearly every edit touches.
export function persist(production = activeProduction()) {
  if (production) dirty.add(production);
  clearTimeout(pending);
  pending = setTimeout(() => {
    persistNow().catch((err) => console.error('[Edge Studio] Save failed:', err));
  }, 300);
}

export async function persistNow(production = null) {
  if (production) dirty.add(production);
  clearTimeout(pending);
  pending = null;
  const due = [...dirty];
  dirty.clear();
  for (const item of due) await put('productions', item);
}

// Closing the tab inside the debounce window used to drop the last
// keystrokes. The write is started as the page goes away; extension
// storage calls made during pagehide still complete.
window.addEventListener('pagehide', () => {
  if (dirty.size) persistNow().catch(() => {});
});

export function hasUnsavedChanges(productionId) {
  return [...dirty].some((p) => p.id === productionId);
}

export async function createProduction(name) {
  await persistNow();
  const production = newProduction({ projectId: state.projectId, name });
  await put('productions', production);
  state.productions.push(production);
  state.productions.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  await setActiveProduction(production.id);
  return production;
}

// Takes the production's own documents with it. Assets stay — they
// belong to the project, and other productions may use them.
export async function deleteProduction(productionId) {
  await persistNow();
  const owned = state.documents.filter((d) => d.productionId === productionId);
  for (const doc of owned) await remove('documents', doc.id);
  await remove('productions', productionId);

  state.documents = state.documents.filter((d) => d.productionId !== productionId);
  state.productions = state.productions.filter((p) => p.id !== productionId);

  if (state.productions.length === 0) {
    const replacement = newProduction({ projectId: state.projectId, name: 'First production' });
    await put('productions', replacement);
    state.productions = [replacement];
  }
  await setActiveProduction(state.productions[0].id);
}

// ---------- assets (per project) ----------

export async function saveAsset(asset) {
  return put('assets', asset);
}

export async function saveAssets(assets) {
  return putMany('assets', assets);
}

export async function deleteAsset(assetId) {
  await remove('assets', assetId);
  state.assets = state.assets.filter((a) => a.id !== assetId);
}

// ---------- documents (per production) ----------

export async function saveDocument(doc) {
  const saved = await put('documents', doc);
  if (!state.documents.includes(doc)) state.documents.unshift(doc);
  return saved;
}

export async function deleteDocument(docId) {
  await remove('documents', docId);
  state.documents = state.documents.filter((d) => d.id !== docId);
}
