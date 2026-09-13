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
// Tab labels live in storage.session, not storage.local, and that's
// deliberate. They're keyed by Chrome tab ID, and tab IDs are only
// unique within a single browser session — Chrome hands the same IDs
// out again after a restart. Persisting them to storage.local meant a
// label saved against tab 42 today would reappear on an unrelated tab
// 42 tomorrow, quietly mislabelling a destination. storage.session is
// cleared when the browser closes, which matches M1-6's "labels persist
// per tab session" acceptance criterion exactly and makes the ID reuse
// unreachable.

export async function getTabLabels() {
  const { tabLabels } = await chrome.storage.session.get('tabLabels');
  return tabLabels || {};
}

export async function saveTabLabels(tabLabels) {
  await chrome.storage.session.set({ tabLabels });
}
