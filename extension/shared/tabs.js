// The open chat and generator tabs, named the same way on every page.
//
// A tab labelled "Client X" in the side panel is "Client X" in the
// studio's pickers too — the label is per browser session, stored in
// storage.session, and both pages read it from here.

const LABELS_KEY = 'tabLabels';

// Tab labels live in storage.session, not storage.local, and that's
// deliberate. They're keyed by Chrome tab ID, and tab IDs are only
// unique within a single browser session — Chrome hands the same IDs
// out again after a restart. Persisting them to disk would let a label
// saved against tab 42 today reappear on an unrelated tab 42 tomorrow,
// quietly mislabelling a destination.

export async function getTabLabels() {
  const data = await chrome.storage.session.get(LABELS_KEY);
  return data[LABELS_KEY] || {};
}

export async function saveTabLabels(labels) {
  await chrome.storage.session.set({ [LABELS_KEY]: labels });
}

// Every detected tab, each carrying its session label if it has one.
export async function listChatTabs() {
  const tabs = (await chrome.runtime.sendMessage({ type: 'EDGE_STUDIO_GET_TABS' })) || [];
  const labels = await getTabLabels();
  return tabs.map((tab) => ({ ...tab, label: labels[tab.id] || null }));
}

// A page title that just repeats the platform's name ("Sora", "ChatGPT")
// or is empty says nothing, so it isn't shown twice.
function usefulTitle(tab) {
  const title = (tab.title || '').trim();
  if (!title) return null;
  if (tab.platformLabel && title.toLowerCase() === tab.platformLabel.toLowerCase()) return null;
  return title;
}

// What a tab is called in a picker: the platform, then the label if Dan
// gave it one, otherwise the page title — "ChatGPT · Client X".
export function tabName(tab) {
  const detail = tab.label || usefulTitle(tab);
  if (!tab.platformLabel) return detail || `Tab ${tab.id}`;
  return detail ? `${tab.platformLabel} · ${detail}` : `${tab.platformLabel} tab`;
}

// What a tab is called where the platform is already shown beside it
// (the panel's list has a platform badge): just the label or title.
export function tabShortName(tab) {
  return tab.label || usefulTitle(tab) || tab.platformLabel || `Tab ${tab.id}`;
}

// Chats can answer, so Optimize and the studio's round trips run in them.
// Generator pages (Sora, Flow) only take a prompt.
export function isChatTab(tab) {
  return tab.kind !== 'generator';
}
