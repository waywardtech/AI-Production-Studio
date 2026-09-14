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
//   state.js       the active project's productions, assets, documents
//   repository.js  reads and writes, on top of shared/store.js
//   render.js      the redraw registry the columns talk through
//   files.js       reading dropped files; writing the report out
//   scenes.js      the scene rail, sequences, and productions
//   assets.js      column 1 — the project's asset pool
//   runorder.js    column 2 — the blocks of the script for the scene
//   shot.js        column 3 — still, aspects, refine, assembled preview
//   seed.js        the chat round trips: expand, refine, script, import
//   produce.js     produce → out-box, and the dailies report
//   boxes.js       the in-box/out-box drawer and the review loop
//
// The dialog, toasts, chat round trip, project bar and record store come
// from ../shared/, the same modules the side panel uses.

import { state } from './lib/state.js';
import { hasUnsavedChanges, loadProject } from './lib/repository.js';
import { registerRenderer, render, renderAll } from './lib/render.js';
import { initScenes, renderScenes } from './lib/scenes.js';
import { initAssets, refreshHeldBytes, renderAssets } from './lib/assets.js';
import { initDriveImport } from './lib/drive-import.js';
import { initRunOrder, renderRunOrder } from './lib/runorder.js';
import { initShot, renderShot } from './lib/shot.js';
import { expandScene, importMaterial, refineScene, scenesFromScript } from './lib/seed.js';
import { initProduce } from './lib/produce.js';
import { fileTexts, initBoxes, renderDrawer } from './lib/boxes.js';
import { migrate } from '../shared/migrate.js';
import { subscribe } from '../shared/store.js';
import { mountProjectBar } from '../shared/project-bar.js';
import { mountSyncStatus } from '../shared/sync-status.js';
import { showToast } from '../shared/ui.js';

registerRenderer('scenes', renderScenes);
registerRenderer('assets', renderAssets);
registerRenderer('runorder', renderRunOrder);
registerRenderer('shot', renderShot);
registerRenderer('drawer', renderDrawer);

// Replaces a record in a state list with a newer copy from storage, or
// drops it if it was deleted. Returns whether anything changed.
function applyExternal(list, event) {
  const index = list.findIndex((item) => item.id === event.id);
  const gone = !event.record || event.record.deletedAt || event.record.projectId !== state.projectId;

  if (gone) {
    if (index === -1) return false;
    list.splice(index, 1);
    return true;
  }
  if (index === -1) list.push(event.record);
  else list[index] = event.record;
  return true;
}

// The side panel and, once connected, Google sync write to the same
// store. Pick up what they changed in this project. A production with
// edits still waiting to be saved here is left alone — those edits are
// about to be written, and this page's copy is the newer one.
function followStoreChanges() {
  subscribe((events) => {
    const due = new Set();

    events
      .filter((e) => !e.self && e.kind === 'record')
      .forEach((e) => {
        if (e.collection === 'productions') {
          if (hasUnsavedChanges(e.id)) return;
          if (applyExternal(state.productions, e)) {
            if (!state.productions.some((p) => p.id === state.activeProductionId) && state.productions[0]) {
              state.activeProductionId = state.productions[0].id;
              state.activeSceneId = state.productions[0].scenes[0]?.id || null;
            }
            due.add('all');
          }
        }
        if (e.collection === 'assets' && applyExternal(state.assets, e)) due.add('assets');
        if (e.collection === 'documents' && applyExternal(state.documents, e)) due.add('drawer');
      });

    // A document reaching Google Docs gets its "Doc ↗" link.
    if (events.some((e) => e.kind === 'sync' && e.collection === 'documents')) due.add('drawer');

    if (due.has('all')) renderAll();
    else {
      if (due.has('assets')) render('assets', 'shot');
      if (due.has('drawer')) render('drawer');
    }
  });
}

async function init() {
  // Earlier builds kept data in a different shape; bring it across
  // before anything reads.
  await migrate();

  initScenes();
  initAssets({ onTextFiles: fileTexts });
  initDriveImport({ onTextFiles: fileTexts });
  initRunOrder();
  initShot({ onRefine: refineScene });
  initProduce();
  initBoxes();

  document.getElementById('expand-btn').addEventListener('click', expandScene);
  document.getElementById('from-script-btn').addEventListener('click', () => scenesFromScript());
  document.getElementById('import-btn').addEventListener('click', () => importMaterial());

  // The project bar resolves the active project and calls back whenever
  // it changes — from this page or from the side panel.
  await mountProjectBar(document.getElementById('project-bar'), {
    onChange: async (project) => {
      await loadProject(project);
      document.title = `${project.name} — Edge Studio`;
      // Which asset files this machine holds is per project, so it is
      // re-read whenever the project changes.
      await refreshHeldBytes();
      renderAll();
    },
  });

  followStoreChanges();
  await mountSyncStatus(document.getElementById('sync-status'));
  document.getElementById('open-settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  // The composer is the side panel. Chrome only opens a side panel in
  // response to a click, and not in every situation — if it refuses,
  // say where the button is rather than failing silently.
  document.getElementById('open-composer-btn').addEventListener('click', async () => {
    try {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
    } catch {
      showToast('Click the Edge Studio icon in the toolbar to open the composer beside this window.', 'warning');
    }
  });
}

init();
