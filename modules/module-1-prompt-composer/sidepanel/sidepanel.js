// Edge Studio — side panel entry point.
//
// This file only wires modules together and starts them. The work lives
// in lib/, one module per concern:
//
//   state.js      shared mutable panel state
//   storage.js    every chrome.storage read/write (the CORE-4 seam)
//   variables.js  <placeholder> logic — pure, no DOM, no chrome
//   modal.js      the panel's one dialog
//   ui.js         toasts, Prompts/Replies switching, clipboard
//   blocks.js     block types: palette and the Manage editor
//   builder.js    the canvas, and everything that puts text into it
//   library.js    saved prompts, tags and grouping
//   targets.js    the shared Chat tabs list
//   insert.js     Insert, the variable form, clipboard fallback
//   optimize.js   the platform-targeted rewrite loop
//   replies.js    capture, save, and reuse
//   usage.js      the Usage tab and the composer's cost meter
//
// The panel has three tabs — Prompts, Replies and Usage — over a shared
// Chat tabs list, because Prompts and Replies act on the same ticked
// tabs and duplicating that list would let the two drift apart.

import { initTabs } from './lib/ui.js';
import { loadBlockTypes, renderPalette, openBlockManager } from './lib/blocks.js';
import { renderCanvas, updatePreview, addBlock, initBuilder } from './lib/builder.js';
import { renderLibrary, initLibrary } from './lib/library.js';
import { refreshTabs, initTargets } from './lib/targets.js';
import { initInsert } from './lib/insert.js';
import { initOptimize } from './lib/optimize.js';
import { renderCaptures, renderResponses, initReplies } from './lib/replies.js';
import { loadUsage, renderUsage, updateCostEstimate, initUsage } from './lib/usage.js';

// blocks.js owns the palette but shouldn't have to know how the builder
// renders, so the two are joined here rather than importing each other.
function refreshBlockUI() {
  renderPalette(addBlock);
  renderCanvas();
}

document
  .getElementById('manage-blocks-btn')
  .addEventListener('click', () => openBlockManager({ onSaved: refreshBlockUI }));

async function init() {
  initTabs();
  initBuilder();
  initLibrary();
  initTargets();
  initInsert();
  initOptimize();
  initReplies();
  initUsage();

  await loadBlockTypes();
  await loadUsage();
  renderUsage();
  refreshBlockUI();
  updatePreview();

  await renderLibrary();
  renderCaptures();
  await renderResponses();
  await refreshTabs();
  updateCostEstimate();
}

init();
