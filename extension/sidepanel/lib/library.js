// The prompt library (M1-3 / M1-4) with CORE-5 tagging and grouping.

import { state } from './state.js';
import { getLibrary, saveLibrary } from './storage.js';
import { openModal } from '../../shared/modal.js';
import { showToast, switchTab } from '../../shared/ui.js';
import { loadBlocksIntoBuilder } from './builder.js';

const libraryListEl = document.getElementById('library-list');
const tagFilterRowEl = document.getElementById('tag-filter-row');
const filterInputEl = document.getElementById('filter-input');

const STATUSES = ['Draft', 'In Review', 'Approved', 'Archived'];

// Stored lowercase so "Apex", "apex" and "APEX" are one group.
export function parseTags(raw) {
  return [
    ...new Set(
      (raw || '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

async function savePromptFromBuilder() {
  if (state.canvasBlocks.length === 0) {
    showToast('Nothing to save — add a block first.', 'warning');
    return;
  }

  const result = await openModal({
    title: 'Save prompt',
    fields: [
      { name: 'title', label: 'Name this prompt' },
      // Saving while filtered to a tag pre-fills that tag, which is
      // almost always what's wanted.
      { name: 'tags', label: 'Tags (comma separated)', value: state.activeTagFilter || '' },
    ],
    confirmLabel: 'Save',
  });
  if (result === null) return;

  const title = result.title.trim();
  if (!title) {
    showToast('Give the prompt a name to save it.', 'warning');
    return;
  }

  const library = await getLibrary();
  library.unshift({
    id: `prompt-${Date.now()}`,
    title,
    blocks: state.canvasBlocks,
    tags: parseTags(result.tags),
    status: 'Draft', // CORE-5 standard system tag
    createdAt: new Date().toISOString(),
  });
  await saveLibrary(library);
  showToast(`Saved "${title}" to your library.`);
  await renderLibrary();
}

async function editPromptMeta(item) {
  const result = await openModal({
    title: 'Edit prompt',
    fields: [
      { name: 'title', label: 'Name', value: item.title },
      { name: 'tags', label: 'Tags (comma separated)', value: (item.tags || []).join(', ') },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        value: item.status || 'Draft',
        options: STATUSES.map((s) => ({ value: s, label: s })),
      },
    ],
    confirmLabel: 'Save',
  });
  if (result === null) return;

  const title = result.title.trim();
  if (!title) {
    showToast('A prompt needs a name.', 'warning');
    return;
  }

  const library = await getLibrary();
  const target = library.find((x) => x.id === item.id);
  if (!target) return;
  target.title = title;
  target.tags = parseTags(result.tags);
  target.status = result.status;
  await saveLibrary(library);
  showToast(`Updated "${title}".`);
  await renderLibrary();
}

async function deletePrompt(item) {
  // The library is the only copy of a saved prompt until CORE-4 backs
  // it with Drive, so a stray click here is unrecoverable.
  const confirmed = await openModal({
    title: 'Delete prompt',
    body: `Delete "${item.title}"? This can't be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (confirmed === null) return;

  const library = await getLibrary();
  await saveLibrary(library.filter((x) => x.id !== item.id));
  showToast(`Deleted "${item.title}".`);
  await renderLibrary();
}

function buildPromptRow(item) {
  const li = document.createElement('li');
  li.className = 'library-item';

  const head = document.createElement('div');
  head.className = 'library-head';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = item.title;
  title.title = 'Load into the builder';
  title.addEventListener('click', () => {
    loadBlocksIntoBuilder(item.blocks);
    switchTab('prompts');
    showToast(`Loaded "${item.title}" into the builder.`);
  });
  head.appendChild(title);

  const status = document.createElement('span');
  status.className = 'status-tag';
  status.textContent = item.status || 'Draft';
  head.appendChild(status);

  const edit = document.createElement('span');
  edit.className = 'row-action';
  edit.textContent = '✎';
  edit.title = 'Edit name, tags and status';
  edit.addEventListener('click', () => editPromptMeta(item));
  head.appendChild(edit);

  const del = document.createElement('span');
  del.className = 'delete-item';
  del.textContent = '✕';
  del.title = 'Delete';
  del.addEventListener('click', () => deletePrompt(item));
  head.appendChild(del);

  li.appendChild(head);

  if ((item.tags || []).length) {
    const tagRow = document.createElement('div');
    tagRow.className = 'tag-row';
    item.tags.forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = tag;
      chip.title = `Filter by "${tag}"`;
      chip.addEventListener('click', () => {
        state.activeTagFilter = tag;
        renderLibrary();
      });
      tagRow.appendChild(chip);
    });
    li.appendChild(tagRow);
  }

  return li;
}

function renderTagFilter(allTags) {
  tagFilterRowEl.innerHTML = '';
  if (allTags.length === 0) return;

  const makeChip = (label, value) => {
    const chip = document.createElement('button');
    chip.className = 'tag-chip filter';
    chip.classList.toggle('active', state.activeTagFilter === value);
    chip.textContent = label;
    chip.addEventListener('click', () => {
      state.activeTagFilter = value;
      renderLibrary();
    });
    return chip;
  };

  tagFilterRowEl.appendChild(makeChip('All', null));
  allTags.forEach((tag) => tagFilterRowEl.appendChild(makeChip(tag, tag)));
}

function appendEmpty(text) {
  const empty = document.createElement('p');
  empty.className = 'empty-state';
  empty.textContent = text;
  libraryListEl.appendChild(empty);
}

export async function renderLibrary() {
  const library = await getLibrary();
  const q = filterInputEl.value.trim().toLowerCase();

  const allTags = [...new Set(library.flatMap((item) => item.tags || []))].sort();
  // A tag that no longer exists shouldn't leave the list looking empty.
  if (state.activeTagFilter && !allTags.includes(state.activeTagFilter)) {
    state.activeTagFilter = null;
  }
  renderTagFilter(allTags);

  const visible = library.filter(
    (item) =>
      !q ||
      item.title.toLowerCase().includes(q) ||
      (item.status || '').toLowerCase().includes(q) ||
      (item.tags || []).some((t) => t.includes(q))
  );

  libraryListEl.innerHTML = '';

  if (visible.length === 0) {
    appendEmpty(library.length === 0 ? 'No saved prompts yet.' : 'No matches.');
    return;
  }

  // With a tag selected, show a flat list of just that tag. With "All"
  // selected, group by tag instead — a prompt tagged both "apex" and
  // "work" appears under both, which is the point of tagging rather
  // than foldering.
  if (state.activeTagFilter) {
    const list = document.createElement('ul');
    list.className = 'library-group-list';
    visible
      .filter((item) => (item.tags || []).includes(state.activeTagFilter))
      .forEach((item) => list.appendChild(buildPromptRow(item)));

    if (!list.children.length) {
      appendEmpty('No matches in this tag.');
      return;
    }
    libraryListEl.appendChild(list);
    return;
  }

  const groups = [];
  allTags.forEach((tag) => {
    const items = visible.filter((item) => (item.tags || []).includes(tag));
    if (items.length) groups.push({ tag, items });
  });
  const untagged = visible.filter((item) => !(item.tags || []).length);
  if (untagged.length) groups.push({ tag: 'Untagged', items: untagged });

  groups.forEach((group) => {
    const heading = document.createElement('h3');
    heading.className = 'library-group-heading';
    heading.textContent = `${group.tag} (${group.items.length})`;
    libraryListEl.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'library-group-list';
    group.items.forEach((item) => list.appendChild(buildPromptRow(item)));
    libraryListEl.appendChild(list);
  });
}

export function initLibrary() {
  document.getElementById('save-prompt-btn').addEventListener('click', savePromptFromBuilder);
  filterInputEl.addEventListener('input', () => renderLibrary());
}
