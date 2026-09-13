// Projects — the one organising choice every page shares.
//
// The active project is a setting, not page state, so both surfaces
// follow it: switch to "Apex" in the side panel and the studio switches
// too. Pages learn about it through store.subscribe.
//
// No DOM here; project-bar.js is the UI.

import { COLLECTIONS, getSetting, list, put, remove, updateSetting } from './store.js';
import { newProject } from './model.js';

export const FIRST_PROJECT_ID = 'prj-first';

export async function listProjects() {
  const projects = await list('projects');
  return projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// Always resolves to a real project. If none exist (first run, or the
// last one was deleted) one is created, so no page ever has to handle
// "there is no project".
export async function ensureActiveProject() {
  const app = (await getSetting('app', {})) || {};
  const projects = await listProjects();

  let active = projects.find((p) => p.id === app.activeProjectId);
  if (!active) active = projects[0];
  if (!active) {
    // Two pages opening at once on a fresh install would each find no
    // projects and each create one. The very first project gets a fixed
    // id, so both writes land on the same record instead of making two.
    const everCreated = (await list('projects', { includeDeleted: true })).length > 0;
    const first = newProject('My first project');
    if (!everCreated) first.id = FIRST_PROJECT_ID;
    active = await put('projects', first);
  }

  if (app.activeProjectId !== active.id) await updateSetting('app', { activeProjectId: active.id });
  return active;
}

export async function setActiveProject(projectId) {
  await updateSetting('app', { activeProjectId: projectId });
}

export async function createProject(name) {
  const project = await put('projects', newProject(name));
  await setActiveProject(project.id);
  return project;
}

export async function renameProject(project, { name, status }) {
  if (name !== undefined) project.name = String(name).trim() || project.name;
  if (status !== undefined) project.status = status;
  return put('projects', project);
}

// What deleting a project would take with it, for the confirmation.
export async function projectContents(projectId) {
  const counts = {};
  for (const collection of COLLECTIONS) {
    if (collection === 'projects') continue;
    counts[collection] = (await list(collection, { projectId })).length;
  }
  return counts;
}

// Removes the project and everything in it. With Google connected each
// record becomes a tombstone, so their Docs go to Drive's trash (not
// deleted outright) on the next sync.
export async function deleteProject(projectId) {
  for (const collection of COLLECTIONS) {
    if (collection === 'projects') continue;
    const records = await list(collection, { projectId });
    for (const record of records) await remove(collection, record.id);
  }
  await remove('projects', projectId);
  return ensureActiveProject();
}
