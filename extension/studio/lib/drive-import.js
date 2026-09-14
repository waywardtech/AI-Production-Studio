// Importing from the Drive you already have (M5-3).
//
// Everything else in Edge Studio works on files it made itself, which
// is all drive.file can see. Bringing in a folder of plates shot last
// year is the opposite case, so this is the one place that reads the
// rest of Drive — behind its own permission, granted in Settings and
// asked for nowhere else.
//
// The worker does the listing and downloading; this is the browser over
// it. Google Docs come across as text and land in the In-box; anything
// else becomes an asset, with its bytes when it's small enough and a
// link back to Drive either way.

import { render } from './render.js';
import { ASSET_CATEGORIES } from './model.js';
import { openModal, setModalBody } from '../../shared/modal.js';
import { showToast } from '../../shared/ui.js';
import { blobs, formatBytes } from '../../shared/blobs.js';
import { FILE_KINDS, baseName, fileKind, makeThumbnail } from './files.js';
import { addAssets, refreshHeldBytes } from './assets.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT = { id: 'root', name: 'My Drive' };

const isFolder = (file) => file.mimeType === FOLDER_MIME;

async function ask(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

// What a Drive file would become here, so the row can say so before
// anything is downloaded.
function describe(file) {
  if (isFolder(file)) return { kind: 'folder', label: 'Folder' };
  if (file.mimeType?.startsWith('application/vnd.google-apps.')) {
    return { kind: 'gdoc', label: 'Google Doc → In-box' };
  }
  const kind = fileKind({ name: file.name, type: file.mimeType });
  return { kind, label: FILE_KINDS[kind]?.label || 'File' };
}

export async function openDriveImport() {
  let trail = [ROOT];
  let files = [];
  let nextPageToken = null;
  let searching = '';
  const picked = new Map(); // fileId → file

  let listEl;
  let crumbEl;
  let countEl;

  async function load({ append = false } = {}) {
    listEl.setAttribute('aria-busy', 'true');
    if (!append) {
      listEl.innerHTML = '';
      const loading = document.createElement('p');
      loading.className = 'empty-hint';
      loading.textContent = searching ? `Searching Drive for “${searching}”…` : 'Reading that folder…';
      listEl.appendChild(loading);
    }

    const result = searching
      ? await ask('EDGE_STUDIO_DRIVE_SEARCH', { text: searching })
      : await ask('EDGE_STUDIO_DRIVE_LIST', {
          parentId: trail[trail.length - 1].id,
          pageToken: append ? nextPageToken : undefined,
        });

    listEl.removeAttribute('aria-busy');

    if (!result || !result.success) {
      files = append ? files : [];
      renderList(result?.reason || 'Could not read Drive.', result?.needsPermission);
      return;
    }

    files = append ? [...files, ...result.files] : result.files;
    nextPageToken = result.nextPageToken;
    renderList();
  }

  function renderCrumbs() {
    crumbEl.innerHTML = '';
    trail.forEach((entry, i) => {
      const crumb = document.createElement('button');
      crumb.className = 'link-btn drive-crumb';
      crumb.textContent = entry.name;
      crumb.disabled = i === trail.length - 1 && !searching;
      crumb.addEventListener('click', () => {
        trail = trail.slice(0, i + 1);
        searching = '';
        nextPageToken = null;
        load();
      });
      crumbEl.appendChild(crumb);
      if (i < trail.length - 1) {
        const sep = document.createElement('span');
        sep.className = 'drive-crumb-sep';
        sep.textContent = '›';
        crumbEl.appendChild(sep);
      }
    });

    if (searching) {
      const sep = document.createElement('span');
      sep.className = 'drive-crumb-sep';
      sep.textContent = '›';
      crumbEl.appendChild(sep);
      const label = document.createElement('span');
      label.className = 'drive-crumb-search';
      label.textContent = `“${searching}”`;
      crumbEl.appendChild(label);
    }
  }

  function renderCount() {
    const total = [...picked.values()].reduce((sum, f) => sum + (Number(f.size) || 0), 0);
    countEl.textContent = picked.size
      ? `${picked.size} selected · ${formatBytes(total)}`
      : 'Nothing selected yet.';
  }

  function renderList(error = null, needsPermission = false) {
    renderCrumbs();
    listEl.innerHTML = '';

    if (error) {
      const message = document.createElement('p');
      message.className = 'empty-hint';
      message.textContent = error;
      listEl.appendChild(message);
      if (needsPermission) {
        const open = document.createElement('button');
        open.className = 'secondary compact';
        open.textContent = 'Open Settings';
        open.addEventListener('click', () => chrome.runtime.openOptionsPage());
        listEl.appendChild(open);
      }
      renderCount();
      return;
    }

    if (files.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-hint';
      empty.textContent = searching ? 'Nothing in Drive matches that.' : 'This folder is empty.';
      listEl.appendChild(empty);
      renderCount();
      return;
    }

    files.forEach((file) => {
      const info = describe(file);
      const row = document.createElement('div');
      row.className = 'drive-row';
      row.dataset.kind = info.kind;

      if (isFolder(file)) {
        const open = document.createElement('button');
        open.className = 'drive-open link-btn';
        open.textContent = `📁 ${file.name}`;
        open.addEventListener('click', () => {
          trail = [...trail, { id: file.id, name: file.name }];
          searching = '';
          nextPageToken = null;
          load();
        });
        row.appendChild(open);
      } else {
        const label = document.createElement('label');
        label.className = 'drive-pick';

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = picked.has(file.id);
        box.addEventListener('change', () => {
          if (box.checked) picked.set(file.id, file);
          else picked.delete(file.id);
          renderCount();
        });
        label.appendChild(box);

        const name = document.createElement('span');
        name.className = 'drive-name';
        name.textContent = file.name;
        label.appendChild(name);

        row.appendChild(label);
      }

      const meta = document.createElement('span');
      meta.className = 'drive-meta';
      meta.textContent = isFolder(file)
        ? ''
        : `${info.label}${file.size ? ` · ${formatBytes(file.size)}` : ''}`;
      row.appendChild(meta);

      listEl.appendChild(row);
    });

    if (nextPageToken && !searching) {
      const more = document.createElement('button');
      more.className = 'secondary compact drive-more';
      more.textContent = 'Load more';
      more.addEventListener('click', () => load({ append: true }));
      listEl.appendChild(more);
    }

    renderCount();
  }

  const choice = await openModal({
    title: 'Import from Google Drive',
    hint: 'Pick files to bring in. Google Docs come across as text and land in the In-box; everything else joins the asset pool.',
    fields: [
      {
        name: 'category',
        label: 'File in as',
        type: 'select',
        value: 'auto',
        options: [
          { value: 'auto', label: 'Whatever suits the file' },
          ...ASSET_CATEGORIES.map((c) => ({ value: c.id, label: c.label })),
        ],
      },
    ],
    confirmLabel: 'Import',
    render: (container) => {
      const search = document.createElement('div');
      search.className = 'drive-search';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Search all of Drive by name…';
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        searching = input.value.trim();
        nextPageToken = null;
        load();
      });
      search.appendChild(input);
      container.appendChild(search);

      crumbEl = document.createElement('div');
      crumbEl.className = 'drive-crumbs';
      container.appendChild(crumbEl);

      listEl = document.createElement('div');
      listEl.className = 'drive-list';
      container.appendChild(listEl);

      countEl = document.createElement('p');
      countEl.className = 'hint drive-count';
      container.appendChild(countEl);

      load();
    },
  });

  if (choice === null) return;
  if (picked.size === 0) {
    showToast('No files were ticked.', 'warning');
    return;
  }

  await importPicked([...picked.values()], choice.category);
}

async function importPicked(files, category) {
  const built = [];
  const texts = [];
  const failures = [];
  let referenceOnly = 0;

  // One at a time, with the dialog reporting progress: a folder of
  // stills is a lot of downloads, and a silent wait looks like a hang.
  let closeProgress = null;
  const progress = openModal({
    title: 'Importing from Drive',
    body: `0 of ${files.length}…`,
    confirmLabel: 'Hide',
    onOpen: (api) => {
      closeProgress = api.confirm;
    },
  });

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    setModalBody(`${i + 1} of ${files.length} — ${file.name}`);

    const result = await ask('EDGE_STUDIO_DRIVE_IMPORT', { fileId: file.id });
    if (!result || !result.success) {
      failures.push(`${file.name}: ${result?.reason || 'failed'}`);
      continue;
    }

    if (result.kind === 'text') {
      texts.push({ name: result.name, text: result.text, kind: 'script', url: result.url });
      continue;
    }

    const kind = fileKind({ name: result.name, type: result.mimeType });
    const stored = result.kind === 'file';
    if (!stored) referenceOnly += 1;

    // The thumbnail is made here rather than in the worker: a poster
    // frame needs a <video>, and there isn't one in a service worker.
    let thumb = null;
    if (stored) {
      const blob = await blobs.getBlob(result.blobId);
      if (blob) thumb = await makeThumbnail(new File([blob], result.name, { type: result.mimeType }));
    }

    built.push({
      name: baseName(result.name),
      category: category !== 'auto' ? category : FILE_KINDS[kind]?.category || 'other',
      origin: 'drive',
      sourceUrl: result.url || '',
      thumb,
      description: '',
      fileRef: {
        name: result.name,
        size: result.size || 0,
        type: result.mimeType || '',
        kind,
        blobId: result.blobId || null,
        stored,
        tooLarge: !stored,
        driveFileId: result.driveFileId || null,
        driveUrl: result.url || null,
      },
    });
  }

  const created = built.length ? addAssets(built) : [];
  await refreshHeldBytes();
  render('assets');

  // Close the progress dialog if Dan hasn't already dismissed it; the
  // toasts below are the actual report.
  if (closeProgress) closeProgress();
  await progress;

  if (created.length) {
    showToast(
      `Imported ${created.length} file${created.length === 1 ? '' : 's'} from Drive` +
        (referenceOnly ? `, ${referenceOnly} as a link only (over the size limit).` : '.')
    );
  }
  if (texts.length && onDriveTexts) await onDriveTexts(texts);
  if (failures.length) {
    showToast(`${failures.length} didn't come across: ${failures[0]}`, 'warning');
    console.error('[Edge Studio] Drive import failures:', failures);
  }
}

// boxes.js owns the In-box, same arrangement as local file intake.
let onDriveTexts = null;

export function initDriveImport({ onTextFiles = null } = {}) {
  onDriveTexts = onTextFiles;
  document.getElementById('asset-drive-btn').addEventListener('click', openDriveImport);
}
