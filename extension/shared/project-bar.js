// The project switcher both pages carry in their header.
//
// It reflects a setting rather than owning state: choosing a project
// writes es:settings:app.activeProjectId, and every open page — this one
// included — hears that through store.subscribe and follows. So the side
// panel and the studio are always looking at the same project.

import { STATUSES } from './model.js';
import { subscribe } from './store.js';
import {
  createProject,
  deleteProject,
  ensureActiveProject,
  listProjects,
  projectContents,
  renameProject,
  setActiveProject,
} from './projects.js';
import { openModal } from './modal.js';
import { showToast } from './ui.js';

const CONTENT_LABELS = {
  prompts: ['prompt', 'prompts'],
  replies: ['reply', 'replies'],
  productions: ['production', 'productions'],
  assets: ['asset', 'assets'],
  documents: ['document', 'documents'],
};

function describeContents(counts) {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([collection, n]) => `${n} ${CONTENT_LABELS[collection][n === 1 ? 0 : 1]}`);
  return parts.length ? parts.join(', ') : 'nothing yet';
}

// `onChange(project)` is called with the active project on mount and
// whenever the active project changes or is renamed, from any page.
export async function mountProjectBar(container, { onChange }) {
  container.classList.add('project-bar');
  container.innerHTML = '';

  const label = document.createElement('label');
  label.className = 'project-label';
  label.textContent = 'Project';
  label.htmlFor = 'project-select';
  container.appendChild(label);

  const select = document.createElement('select');
  select.id = 'project-select';
  select.className = 'project-select';
  container.appendChild(select);

  const newBtn = document.createElement('button');
  newBtn.className = 'link-btn';
  newBtn.textContent = '+ New';
  newBtn.title = 'New project';
  container.appendChild(newBtn);

  const editBtn = document.createElement('button');
  editBtn.className = 'link-btn';
  editBtn.textContent = '✎';
  editBtn.title = 'Rename, set status or delete this project';
  container.appendChild(editBtn);

  let active = null;
  let lastSignature = '';

  async function refresh() {
    const projects = await listProjects();
    const current = await ensureActiveProject();

    select.innerHTML = '';
    projects.forEach((project) => {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.status && project.status !== 'Draft'
        ? `${project.name} · ${project.status}`
        : project.name;
      select.appendChild(option);
    });
    select.value = current.id;

    // Only tell the page when something it cares about changed — which
    // project, or that project's name/status.
    const signature = `${current.id}|${current.name}|${current.status}`;
    active = current;
    if (signature !== lastSignature) {
      lastSignature = signature;
      await onChange(current);
    }
  }

  // Several storage changes can arrive together (deleting a project
  // touches every record in it); refresh once for the batch.
  let queued = null;
  const scheduleRefresh = () => {
    clearTimeout(queued);
    queued = setTimeout(() => refresh().catch((e) => console.error('[Edge Studio]', e)), 30);
  };

  subscribe((events) => {
    const relevant = events.some(
      (e) => (e.kind === 'setting' && e.name === 'app') || (e.kind === 'record' && e.collection === 'projects')
    );
    if (relevant) scheduleRefresh();
  });

  select.addEventListener('change', () => setActiveProject(select.value));

  newBtn.addEventListener('click', async () => {
    const values = await openModal({
      title: 'New project',
      hint: 'A project holds its own prompts, replies, productions and assets. In Google Drive it becomes a folder.',
      fields: [{ name: 'name', label: 'Name', value: '' }],
      confirmLabel: 'Create',
    });
    if (values === null) return;
    const name = values.name.trim();
    if (!name) {
      showToast('Give the project a name.', 'warning');
      return;
    }
    await createProject(name);
    showToast(`Switched to "${name}".`);
  });

  editBtn.addEventListener('click', async () => {
    if (!active) return;
    const project = active;
    const values = await openModal({
      title: 'Project',
      fields: [
        { name: 'name', label: 'Name', value: project.name },
        {
          name: 'status',
          label: 'Status',
          type: 'select',
          value: project.status || 'Draft',
          options: STATUSES.map((s) => ({ value: s, label: s })),
        },
      ],
      confirmLabel: 'Save',
      extraButtons: [
        {
          label: 'Delete project',
          onClick: async ({ cancel }) => {
            cancel();
            const counts = await projectContents(project.id);
            const confirmed = await openModal({
              title: `Delete "${project.name}"?`,
              body:
                `This deletes the project and everything in it — ${describeContents(counts)}. ` +
                'If Google Docs is connected, its documents go to your Drive trash rather than being destroyed.',
              confirmLabel: 'Delete project',
              danger: true,
            });
            if (confirmed === null) return;
            const next = await deleteProject(project.id);
            showToast(`Deleted "${project.name}". Now in "${next.name}".`);
          },
        },
      ],
    });
    if (values === null) return;
    await renameProject(project, { name: values.name, status: values.status });
  });

  await refresh();

  return {
    get project() {
      return active;
    },
  };
}
