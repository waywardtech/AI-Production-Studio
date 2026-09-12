// Edge Studio — Module 4, the video & media production pipeline.
//
// A full-window extension page rather than a side-panel tab (spec
// decision #11): the workspace is three columns wide plus a scene rail,
// and the panel can't carry that.
//
// This file only wires modules together and starts them. The work lives
// in lib/, one module per concern:
//
//   model.js       the data shapes, block types, aspects, categories
//   prompt.js      assembly, generator targets, job profiles, requests
//   state.js       shared mutable page state
//   repository.js  every chrome.storage read/write (the CORE-4 seam)
//   render.js      the redraw registry the columns talk through
//   files.js       reading dropped files; writing the report out
//   scenes.js      the scene rail, sequences, and productions
//   assets.js      column 1 — the asset pool
//   runorder.js    column 2 — the blocks of the script for the scene
//   shot.js        column 3 — still, aspects, refine, assembled preview
//   seed.js        the chat round trips: expand, refine, script, import
//   produce.js     produce → out-box, and the dailies report
//   boxes.js       the in-box/out-box drawer and the review loop
//
// It shares the side panel's modal, toast and chat round-trip rather
// than growing a second copy of each — same extension, same behaviour.

import { loadProductions } from './lib/repository.js';
import { registerRenderer, renderAll } from './lib/render.js';
import { initScenes, renderScenes } from './lib/scenes.js';
import { initAssets, renderAssets } from './lib/assets.js';
import { initRunOrder, renderRunOrder } from './lib/runorder.js';
import { initShot, renderShot } from './lib/shot.js';
import { expandScene, importMaterial, refineScene, scenesFromScript } from './lib/seed.js';
import { initProduce } from './lib/produce.js';
import { initBoxes, renderDrawer } from './lib/boxes.js';

registerRenderer('scenes', renderScenes);
registerRenderer('assets', renderAssets);
registerRenderer('runorder', renderRunOrder);
registerRenderer('shot', renderShot);
registerRenderer('drawer', renderDrawer);

async function init() {
  initScenes();
  initAssets();
  initRunOrder();
  initShot({ onRefine: refineScene });
  initProduce();
  initBoxes();

  document.getElementById('expand-btn').addEventListener('click', expandScene);
  document.getElementById('from-script-btn').addEventListener('click', () => scenesFromScript());
  document.getElementById('import-btn').addEventListener('click', () => importMaterial());

  await loadProductions();
  renderAll();
}

init();
