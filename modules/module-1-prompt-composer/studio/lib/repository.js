// Every read and write the studio page makes.
//
// This is the same CORE-4 seam the side panel's storage.js is: swapping
// these for Drive API calls is what wires the real repository in, and
// nothing outside this file needs to change when that happens. Until
// then productions live in chrome.storage.local — which is why the
// manifest asks for unlimitedStorage: thumbnails add up.

import { state } from './state.js';
import { newProduction } from './model.js';

const PRODUCTIONS_KEY = 'productions';
const ACTIVE_KEY = 'activeProductionId';

export async function loadProductions() {
  const stored = await chrome.storage.local.get([PRODUCTIONS_KEY, ACTIVE_KEY]);
  state.productions = stored[PRODUCTIONS_KEY] || [];

  if (state.productions.length === 0) {
    state.productions = [newProduction('First production')];
    await persistNow();
  }

  const wanted = stored[ACTIVE_KEY];
  state.activeProductionId = state.productions.some((p) => p.id === wanted)
    ? wanted
    : state.productions[0].id;

  const production = state.productions.find((p) => p.id === state.activeProductionId);
  state.activeSceneId = production.scenes[0]?.id || null;
}

export async function persistNow() {
  await chrome.storage.local.set({
    [PRODUCTIONS_KEY]: state.productions,
    [ACTIVE_KEY]: state.activeProductionId,
  });
}

// Typing in a block textarea writes on every keystroke, so the actual
// storage call is coalesced. Anything that must be on disk before the
// page can be closed — deleting a production, filing to the out-box —
// awaits persistNow directly.
let pending = null;

export function persist() {
  clearTimeout(pending);
  pending = setTimeout(() => {
    persistNow().catch((err) => console.error('[Edge Studio] Save failed:', err));
  }, 300);
}
