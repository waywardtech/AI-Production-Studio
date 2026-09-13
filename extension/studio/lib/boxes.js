// The in-box and the out-box (M4-13 / M4-15 / M4-16).
//
// From the notes: folders for in-box and out-box, scripts and assets
// dropped in per production, produced clips and a review/dailies report
// coming out. One drawer serves both — they're the same list of things
// with different verbs on them.
//
// Both boxes are views, not containers of their own:
//   in-box  = the production's documents with box 'inbox' (scripts, notes)
//   out-box = the renders recorded on the production's scenes, plus its
//             documents with box 'outbox' (filed dailies reports)
// With Google connected, each document is a Google Doc in the
// production's In-box or Out-box folder.
//
// Dropped files are read, not copied: a script becomes a document in the
// in-box, an image becomes a reference plus a thumbnail in the asset
// pool.

import { state, activeProduction, productionDocuments } from './state.js';
import { deleteDocument, persist, saveDocument } from './repository.js';
import { render } from './render.js';
import { touch } from './model.js';
import { targetById } from './prompt.js';
import { newDocument } from '../../shared/model.js';
import { getSyncMeta } from '../../shared/store.js';
import { openModal } from '../../shared/modal.js';
import { showToast, copyToClipboard } from '../../shared/ui.js';
import { downloadText, isImage, isText, readText } from './files.js';
import { ingestImageFiles } from './assets.js';
import { fileDailiesReport, produceScenes } from './produce.js';
import { importMaterial, scenesFromScript } from './seed.js';

const drawerEl = document.getElementById('drawer');
const drawerTitleEl = document.getElementById('drawer-title');
const drawerHintEl = document.getElementById('drawer-hint');
const drawerBodyEl = document.getElementById('drawer-body');
const drawerActionBtn = document.getElementById('drawer-action-btn');
const overlayEl = document.getElementById('drop-overlay');

let openBox = null; // 'inbox' | 'outbox' | null

export function openDrawer(box) {
  openBox = box;
  drawerEl.classList.remove('hidden');
  renderDrawer();
}

export function closeDrawer() {
  openBox = null;
  drawerEl.classList.add('hidden');
}

function allRenders(production) {
  return production.scenes
    .flatMap((scene) => scene.renders.map((entry) => ({ entry, scene })))
    .sort((a, b) => b.entry.at.localeCompare(a.entry.at));
}

// ---------- in-box ----------

export async function addToInbox({ kind, title, text }) {
  const production = activeProduction();
  if (!production) return null;
  const doc = newDocument({
    projectId: state.projectId,
    productionId: production.id,
    box: 'inbox',
    kind,
    title,
    text,
  });
  await saveDocument(doc);
  render('drawer');
  return doc;
}

// Adds an "Open in Google Docs" link to a row once its document has
// synced. Looked up after the row is drawn so the drawer never waits on
// storage to appear.
function addDocLink(head, doc) {
  getSyncMeta('documents', doc.id).then((meta) => {
    if (!meta?.docUrl || head.querySelector('.doc-link')) return;
    const link = document.createElement('a');
    link.className = 'doc-link';
    link.href = meta.docUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Doc ↗';
    link.title = 'Open in Google Docs';
    head.appendChild(link);
  });
}

function inboxRow(doc) {
  const row = document.createElement('div');
  row.className = 'box-row';

  const head = document.createElement('div');
  head.className = 'box-head';

  const title = document.createElement('span');
  title.className = 'box-title';
  title.textContent = doc.title;
  head.appendChild(title);
  addDocLink(head, doc);

  const meta = document.createElement('span');
  meta.className = 'box-meta';
  meta.textContent = `${doc.kind} · ${doc.text.length} chars`;
  head.appendChild(meta);

  row.appendChild(head);

  const preview = document.createElement('p');
  preview.className = 'box-preview';
  preview.textContent = doc.text.slice(0, 240) + (doc.text.length > 240 ? '…' : '');
  row.appendChild(preview);

  const actions = document.createElement('div');
  actions.className = 'row';

  const toScenes = document.createElement('button');
  toScenes.className = 'secondary compact';
  toScenes.textContent = 'Break into shots';
  toScenes.addEventListener('click', () => {
    closeDrawer();
    scenesFromScript(doc.text);
  });
  actions.appendChild(toScenes);

  const toAssets = document.createElement('button');
  toAssets.className = 'secondary compact';
  toAssets.textContent = 'Import material';
  toAssets.addEventListener('click', () => {
    closeDrawer();
    importMaterial(doc.text);
  });
  actions.appendChild(toAssets);

  const remove = document.createElement('button');
  remove.className = 'secondary compact';
  remove.textContent = 'Remove';
  remove.addEventListener('click', async () => {
    const confirmed = await openModal({
      title: `Remove "${doc.title}"?`,
      body: 'It comes out of the in-box. With Google Docs connected, its Doc goes to your Drive trash.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (confirmed === null) return;
    await deleteDocument(doc.id);
    renderDrawer();
  });
  actions.appendChild(remove);

  row.appendChild(actions);
  return row;
}

// ---------- out-box: the review loop ----------

// Regenerating re-runs Produce for the one scene, carrying the note
// about what was wrong into the next attempt.
async function setVerdict(entry, scene, verdict) {
  const production = activeProduction();

  if (verdict === 'regen') {
    const values = await openModal({
      title: 'Regenerate this shot',
      hint: 'What was wrong with it? The note is carried into the next attempt.',
      fields: [{ name: 'notes', label: 'Notes', type: 'textarea', rows: 4, value: entry.notes }],
      confirmLabel: 'Regenerate',
    });
    if (values === null) return;

    entry.verdict = 'regen';
    entry.notes = values.notes.trim();
    touch(scene);
    persist(production);
    renderDrawer();
    closeDrawer();
    await produceScenes({ sceneIds: [scene.id], notes: entry.notes });
    return;
  }

  entry.verdict = entry.verdict === verdict ? 'pending' : verdict;
  touch(scene);
  persist(production);
  renderDrawer();
  render('scenes');
}

function renderRow(entry, scene) {
  const production = activeProduction();
  const row = document.createElement('div');
  row.className = `box-row verdict-${entry.verdict}`;

  const head = document.createElement('div');
  head.className = 'box-head';

  const title = document.createElement('span');
  title.className = 'box-title';
  title.textContent = scene.name;
  head.appendChild(title);

  const meta = document.createElement('span');
  meta.className = 'box-meta';
  meta.textContent = `${targetById(entry.target).label} · ${new Date(entry.at).toLocaleString()}`;
  head.appendChild(meta);

  const verdictBadge = document.createElement('span');
  verdictBadge.className = 'verdict-badge';
  verdictBadge.textContent = entry.verdict;
  head.appendChild(verdictBadge);

  row.appendChild(head);

  // Where the clip actually lives. The generator keeps the file; this
  // is the link back to the session that made it (spec decision #7).
  const link = document.createElement('input');
  link.type = 'text';
  link.className = 'box-link';
  link.placeholder = 'Paste the clip or session link…';
  link.value = entry.url || '';
  link.addEventListener('change', () => {
    entry.url = link.value.trim();
    touch(scene);
    persist(production);
  });
  row.appendChild(link);

  const actions = document.createElement('div');
  actions.className = 'row';

  [
    ['Keep', 'keep'],
    ['Reject', 'reject'],
    ['Regenerate', 'regen'],
  ].forEach(([label, verdict]) => {
    const btn = document.createElement('button');
    btn.className = entry.verdict === verdict ? 'compact' : 'secondary compact';
    btn.textContent = label;
    btn.addEventListener('click', () => setVerdict(entry, scene, verdict));
    actions.appendChild(btn);
  });

  const copyPrompt = document.createElement('button');
  copyPrompt.className = 'secondary compact';
  copyPrompt.textContent = 'Copy prompt';
  copyPrompt.addEventListener('click', async () => {
    const ok = await copyToClipboard(entry.prompt);
    showToast(ok ? 'Prompt copied.' : 'Could not copy.', ok ? 'success' : 'warning');
  });
  actions.appendChild(copyPrompt);

  row.appendChild(actions);

  if (entry.notes) {
    const notes = document.createElement('p');
    notes.className = 'box-preview';
    notes.textContent = `Notes: ${entry.notes}`;
    row.appendChild(notes);
  }

  return row;
}

function reportRow(doc) {
  const production = activeProduction();
  const row = document.createElement('div');
  row.className = 'box-row report';

  const head = document.createElement('div');
  head.className = 'box-head';

  const title = document.createElement('span');
  title.className = 'box-title';
  title.textContent = doc.title;
  head.appendChild(title);

  const meta = document.createElement('span');
  meta.className = 'box-meta';
  meta.textContent = new Date(doc.createdAt).toLocaleString();
  head.appendChild(meta);
  addDocLink(head, doc);

  row.appendChild(head);

  const actions = document.createElement('div');
  actions.className = 'row';

  const view = document.createElement('button');
  view.className = 'secondary compact';
  view.textContent = 'View';
  view.addEventListener('click', () =>
    openModal({
      title: doc.title,
      fields: [{ name: 'body', label: 'Report', type: 'textarea', rows: 18, value: doc.text }],
      confirmLabel: 'Close',
    })
  );
  actions.appendChild(view);

  const download = document.createElement('button');
  download.className = 'secondary compact';
  download.textContent = 'Download';
  download.addEventListener('click', () => {
    const stamp = (doc.createdAt || new Date().toISOString()).slice(0, 10);
    downloadText(`dailies-${production.name.replace(/\W+/g, '-').toLowerCase()}-${stamp}.md`, doc.text);
  });
  actions.appendChild(download);

  const remove = document.createElement('button');
  remove.className = 'secondary compact';
  remove.textContent = 'Remove';
  remove.addEventListener('click', async () => {
    const confirmed = await openModal({
      title: `Remove "${doc.title}"?`,
      body: 'The report comes out of the out-box. With Google Docs connected, its Doc goes to your Drive trash.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (confirmed === null) return;
    await deleteDocument(doc.id);
    renderDrawer();
  });
  actions.appendChild(remove);

  row.appendChild(actions);
  return row;
}

export function renderDrawer() {
  const production = activeProduction();
  const inbox = productionDocuments('inbox');
  const reports = productionDocuments('outbox');

  document.getElementById('inbox-count').textContent = String(inbox.length);
  document.getElementById('outbox-count').textContent = String(
    production ? allRenders(production).length + reports.length : 0
  );

  if (!openBox || !production) return;

  drawerBodyEl.innerHTML = '';

  if (openBox === 'inbox') {
    drawerTitleEl.textContent = `In-box — ${production.name}`;
    drawerHintEl.textContent =
      'Drop scripts, notes and images anywhere on the page. Scripts land here; images go straight into the asset pool.';
    drawerActionBtn.textContent = 'Paste text…';

    if (inbox.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-hint';
      empty.textContent = 'Nothing waiting. Drop a script in, or paste one.';
      drawerBodyEl.appendChild(empty);
    } else {
      inbox.forEach((doc) => drawerBodyEl.appendChild(inboxRow(doc)));
    }
    return;
  }

  drawerTitleEl.textContent = `Out-box — ${production.name}`;
  drawerHintEl.textContent =
    'Everything produced, with the prompt that made it. Paste each clip’s link in, mark it keep or reject, then file the dailies.';
  drawerActionBtn.textContent = 'File dailies report';

  const renders = allRenders(production);

  if (renders.length === 0 && reports.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = 'Nothing produced yet.';
    drawerBodyEl.appendChild(empty);
    return;
  }

  renders.forEach(({ entry, scene }) => drawerBodyEl.appendChild(renderRow(entry, scene)));
  reports.forEach((doc) => drawerBodyEl.appendChild(reportRow(doc)));
}

// ---------- drop handling ----------

async function ingest(files) {
  const list = [...files];
  const images = list.filter(isImage);
  const texts = list.filter((f) => !isImage(f) && isText(f));
  const ignored = list.length - images.length - texts.length;

  if (images.length) await ingestImageFiles(images);

  for (const file of texts) {
    await addToInbox({ kind: 'script', title: file.name, text: await readText(file) });
  }

  if (texts.length) {
    showToast(`${texts.length} file${texts.length === 1 ? '' : 's'} in the in-box.`);
    openDrawer('inbox');
  }
  if (ignored) {
    showToast(`${ignored} file${ignored === 1 ? '' : 's'} skipped — only images and text files can be read here.`, 'warning');
  }
}

export function initBoxes() {
  document.getElementById('inbox-btn').addEventListener('click', () => openDrawer('inbox'));
  document.getElementById('outbox-btn').addEventListener('click', () => openDrawer('outbox'));
  document.getElementById('drawer-close-btn').addEventListener('click', closeDrawer);

  drawerActionBtn.addEventListener('click', async () => {
    if (openBox === 'outbox') {
      const production = activeProduction();
      if (allRenders(production).length === 0) {
        showToast('Nothing produced to report on yet.', 'warning');
        return;
      }
      await fileDailiesReport();
      renderDrawer();
      return;
    }

    const values = await openModal({
      title: 'Add to the in-box',
      fields: [
        { name: 'name', label: 'Name', value: 'Pasted notes' },
        { name: 'text', label: 'Text', type: 'textarea', rows: 12 },
      ],
      confirmLabel: 'Add',
    });
    if (values === null) return;
    if (!values.text.trim()) {
      showToast('Nothing to add.', 'warning');
      return;
    }
    await addToInbox({
      kind: 'note',
      title: values.name.trim() || 'Pasted notes',
      text: values.text.trim(),
    });
    renderDrawer();
  });

  // Page-wide drop. dragenter/dragleave are counted rather than
  // toggled, because dragging over a child element fires a leave on the
  // parent and the overlay would flicker off mid-drag.
  let dragDepth = 0;

  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth += 1;
    overlayEl.classList.remove('hidden');
  });

  window.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });

  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlayEl.classList.add('hidden');
  });

  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    overlayEl.classList.add('hidden');
    await ingest(e.dataTransfer.files);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openBox && document.getElementById('modal').classList.contains('hidden')) {
      closeDrawer();
    }
  });
}
