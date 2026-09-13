// The side panel's data access, on top of the shared record store.
//
// Everything durable goes through shared/store.js, so the panel, the
// studio and (once connected) Google Drive all see the same records.
// What stays here is only what's genuinely the panel's own: tab labels,
// which are per browser session.

import { getSetting, list, put, remove, setSetting, updateSetting } from '../../shared/store.js';

// ---------- prompts and replies (per project) ----------

export const listPrompts = (projectId) => list('prompts', { projectId });
export const savePrompt = (record) => put('prompts', record);
export const deletePrompt = (id) => remove('prompts', id);

export const listReplies = (projectId) => list('replies', { projectId });
export const saveReply = (record) => put('replies', record);
export const deleteReply = (id) => remove('replies', id);

// ---------- settings (across projects) ----------

export async function getStoredBlockTypes() {
  const app = (await getSetting('app', {})) || {};
  return app.blockTypes && app.blockTypes.length ? app.blockTypes : null;
}

export async function saveBlockTypes(blockTypes) {
  await updateSetting('app', { blockTypes });
}

export async function getRememberedValues() {
  const variables = (await getSetting('variables', {})) || {};
  return variables.values || {};
}

export async function saveRememberedValues(values) {
  await updateSetting('variables', { values });
}

export async function getUsage() {
  return getSetting('usage', null);
}

export async function saveUsage(usage) {
  await setSetting('usage', usage);
}

// ---------- tab labels (per browser session) ----------
//
// Kept in shared/tabs.js so the studio names tabs the same way.

export { getTabLabels, saveTabLabels } from '../../shared/tabs.js';
