// Edge Studio — side panel entry point.
//
// This file only wires modules together and starts them. The work lives
// in lib/, one module per concern:
//
//   state.js      shared mutable panel state
//   storage.js    the panel's reads and writes, on shared/store.js
//   blocks.js     block types: palette and the Manage editor
//   builder.js    the canvas, and everything that puts text into it
//   library.js    saved prompts, tags and grouping
//   targets.js    the shared Chat tabs list
//   insert.js     Insert, the variable form, clipboard fallback
//   optimize.js   the platform-targeted rewrite loop
//   replies.js    capture, save, and reuse
//   usage.js      the Usage tab and the composer's cost meter
//
// Modules the studio uses too — the dialog, toasts, the chat round trip
// and <placeholder> parsing — live in ../shared/.
//
// The panel has three tabs — Prompts, Replies and Usage — over a shared
// Chat tabs list, because Prompts and Replies act on the same ticked
// tabs and duplicating that list would let the two drift apart.

import { initTabs } from '../shared/ui.js';
import { loadBlockTypes, renderPalette, openBlockManager } from './lib/blocks.js';
import { renderCanvas, updatePreview, addBlock, initBuilder } from './lib/builder.js';
import { renderLibrary, initLibrary } from './lib/library.js';
import { refreshTabs, initTargets } from './lib/targets.js';
import { initInsert } from './lib/insert.js';
import { initOptimize } from './lib/optimize.js';
import { renderCaptures, renderResponses, initReplies } from './lib/replies.js';
import { loadUsage, renderUsage, updateCostEstimate, initUsage } from './lib/usage.js';
import { state } from './lib/state.js';
import { migrate } from '../shared/migrate.js';
import { getSetting, subscribe, updateSetting } from '../shared/store.js';
import { mountProjectBar } from '../shared/project-bar.js';
import { mountSyncStatus } from '../shared/sync-status.js';

// blocks.js owns the palette but shouldn't have to know how the builder
// renders, so the two are joined here rather than importing each other.
function refreshBlockUI() {
  renderPalette(addBlock);
  renderCanvas();
}

document
  .getElementById('manage-blocks-btn')
  .addEventListener('click', () => openBlockManager({ onSaved: refreshBlockUI }));

// Module 4 lives in a full window rather than this panel: its three
// columns need the width. Focus the tab if it's already open instead of
// stacking up copies of the workspace.
const STUDIO_URL = chrome.runtime.getURL('studio/studio.html');

document.getElementById('open-settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.getElementById('open-studio-btn').addEventListener('click', async () => {
  const [existing] = await chrome.tabs.query({ url: STUDIO_URL });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: STUDIO_URL });
  }
});

// Other pages (the studio) and, once connected, Google sync write to the
// same store. Redraw what they changed rather than showing a stale list.
// This page's own writes are ignored — it already drew them.
function followStoreChanges() {
  let queued = new Set();
  let timer = null;

  subscribe((events) => {
    events
      .filter((e) => !e.self)
      .forEach((e) => {
        if ((e.kind === 'record' || e.kind === 'sync') && e.collection === 'prompts') queued.add('library');
        if ((e.kind === 'record' || e.kind === 'sync') && e.collection === 'replies') queued.add('replies');
        if (e.kind === 'setting' && e.name === 'usage') queued.add('usage');
        // The app setting also changes when a page switches project or
        // production; only a change to the block types needs a redraw
        // (a redraw would take focus out of a block being typed in).
        if (
          e.kind === 'setting' &&
          e.name === 'app' &&
          JSON.stringify(e.record?.blockTypes || null) !== JSON.stringify(e.previous?.blockTypes || null)
        ) {
          queued.add('blocks');
        }
      });
    if (!queued.size) return;

    clearTimeout(timer);
    timer = setTimeout(async () => {
      const due = queued;
      queued = new Set();
      if (due.has('library')) await renderLibrary();
      if (due.has('replies')) await renderResponses();
      if (due.has('usage')) {
        await loadUsage();
        renderUsage();
        updateCostEstimate();
      }
      if (due.has('blocks')) {
        await loadBlockTypes();
        refreshBlockUI();
      }
    }, 50);
  });
}

async function init() {
  // Earlier builds kept data in a different shape; bring it across
  // before anything reads.
  await migrate();

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
  renderCaptures();

  // Mounting the project bar resolves the active project and draws the
  // project's lists; it calls back again whenever the project changes,
  // from this panel or from the studio.
  await mountProjectBar(document.getElementById('project-bar'), {
    onChange: async (project) => {
      state.projectId = project.id;
      state.projectName = project.name;
      state.activeTagFilter = null;
      await renderLibrary();
      await renderResponses();
    },
  });

  followStoreChanges();
  await mountSyncStatus(document.getElementById('sync-status'));

  const app = (await getSetting('app', {})) || {};
  const guide = document.getElementById('getting-started');
  if (!app.gettingStartedDismissed) guide.classList.remove('hidden');
  document.getElementById('dismiss-start-btn').addEventListener('click', async () => {
    guide.classList.add('hidden');
    await updateSetting('app', { gettingStartedDismissed: true });
  });
  await refreshTabs();
  updateCostEstimate();
}

init();
