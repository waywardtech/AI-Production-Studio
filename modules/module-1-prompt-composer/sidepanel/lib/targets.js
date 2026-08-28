// The shared "Chat tabs" list (M1-5 / M1-6 / M1-7).
//
// It lives above the Prompts/Replies tabs because both act on the same
// ticked tabs — Prompts inserts into them, Replies captures from them.

import { state } from './state.js';
import { getTabLabels, saveTabLabels } from './storage.js';

const tabListEl = document.getElementById('tab-list');

// The picker, the capture cards and the insert toasts must all call a
// tab the same thing, so they all resolve its name here.
export function tabDisplayName(tabId) {
  const tab = state.detectedTabs.find((t) => t.id === tabId);
  return state.tabLabels[tabId] || tab?.title || `Tab ${tabId}`;
}

export function tabPlatform(tabId) {
  return state.detectedTabs.find((t) => t.id === tabId)?.platform || null;
}

export async function refreshTabs() {
  state.detectedTabs = (await chrome.runtime.sendMessage({ type: 'EDGE_STUDIO_GET_TABS' })) || [];
  state.tabLabels = await getTabLabels();

  // Drop anything referring to a tab that no longer exists. Without
  // this, closing a selected tab left its ID in selectedTabIds with no
  // row in the list to unselect — Insert would then try to reach a dead
  // tab and report a failure for something Dan couldn't see. Labels get
  // the same treatment so the map doesn't grow for the whole session.
  const liveTabIds = new Set(state.detectedTabs.map((tab) => tab.id));

  for (const tabId of state.selectedTabIds) {
    if (!liveTabIds.has(tabId)) state.selectedTabIds.delete(tabId);
  }

  const liveLabels = {};
  let droppedLabel = false;
  for (const [tabId, label] of Object.entries(state.tabLabels)) {
    if (liveTabIds.has(Number(tabId))) liveLabels[tabId] = label;
    else droppedLabel = true;
  }
  if (droppedLabel) {
    state.tabLabels = liveLabels;
    await saveTabLabels(state.tabLabels);
  }

  renderTabList();
}

export function renderTabList() {
  tabListEl.innerHTML = '';

  if (!state.detectedTabs || state.detectedTabs.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = 'No open chat tabs found. Open one, then Refresh.';
    tabListEl.appendChild(empty);
    return;
  }

  state.detectedTabs.forEach((tab) => {
    const li = document.createElement('li');
    li.className = 'tab-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selectedTabIds.has(tab.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selectedTabIds.add(tab.id);
      else state.selectedTabIds.delete(tab.id);
    });
    li.appendChild(checkbox);

    if (tab.platformLabel) {
      const badge = document.createElement('span');
      badge.className = 'platform-badge';
      badge.dataset.platform = tab.platform;
      badge.textContent = tab.platformLabel;
      li.appendChild(badge);
    }

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = tabDisplayName(tab.id);
    labelInput.addEventListener('change', async () => {
      state.tabLabels[tab.id] = labelInput.value;
      await saveTabLabels(state.tabLabels);
    });
    li.appendChild(labelInput);

    tabListEl.appendChild(li);
  });
}

export function initTargets() {
  document.getElementById('refresh-tabs-btn').addEventListener('click', refreshTabs);
}
