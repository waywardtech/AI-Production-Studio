// Shared mutable state for the studio page.
//
// Same reasoning as the side panel's state.js: one object, because
// modules replace these wholesale and an imported `let` can't be
// reassigned from outside the module that declares it.
//
// Everything here belongs to the active project. Switching project
// (from this page's project bar or the side panel's) reloads all of it.

export const state = {
  projectId: null,
  projectName: '',

  productions: [], // this project's productions
  assets: [], // this project's asset pool, shared by all its productions
  documents: [], // this project's in-box/out-box documents

  activeProductionId: null,
  activeSceneId: null,

  // Column 1
  assetQuery: '',
  assetCategory: null, // null = every category

  // Column 2 → column 3: which block's contribution is highlighted in
  // the assembled prompt (M4-8).
  selectedBlockId: null,

  showAdvancedAspects: false,
  chatTabs: [],
};

export function activeProduction() {
  return state.productions.find((p) => p.id === state.activeProductionId) || null;
}

export function activeScene() {
  const production = activeProduction();
  if (!production) return null;
  return production.scenes.find((s) => s.id === state.activeSceneId) || production.scenes[0] || null;
}

// Documents filed against the active production, newest first.
export function productionDocuments(box) {
  const production = activeProduction();
  if (!production) return [];
  return state.documents.filter((d) => d.productionId === production.id && d.box === box);
}
