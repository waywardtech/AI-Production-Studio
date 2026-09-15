// "Check page" — runs the adapter's own probe on the ticked tabs and
// shows what Insert, Attach and Capture would find there (M5-5).
//
// Every selector in the adapter is a guess about somebody else's markup.
// This is how a guess becomes a fact: open the site, tick the tab, press
// Check, and read which selector actually matched. The report is meant
// to be copied out — a dated record of what worked where is the only
// real answer to "have these been verified".

import { state } from './state.js';
import { tabDisplayName } from './targets.js';
import { openModal } from '../../shared/modal.js';
import { showToast, copyToClipboard } from '../../shared/ui.js';
import { formatProbes, probeIsClean } from '../../shared/probe-format.js';

async function probeTab(tabId) {
  try {
    return await chrome.runtime.sendMessage({ type: 'EDGE_STUDIO_PROBE', tabId });
  } catch (error) {
    return { success: false, reason: error.message };
  }
}

// Which tabs to look at: the ticked ones, or everything open if nothing
// is ticked — checking all five sites at once is the common case.
function tabsToCheck() {
  if (state.selectedTabIds.size > 0) {
    return state.detectedTabs.filter((tab) => state.selectedTabIds.has(tab.id));
  }
  return state.detectedTabs;
}

export async function runPageCheck() {
  const tabs = tabsToCheck();
  if (tabs.length === 0) {
    showToast('Open a chat or generator tab first, then Refresh.', 'warning');
    return;
  }

  const results = [];
  for (const tab of tabs) {
    results.push({ tab, tabLabel: tabDisplayName(tab.id), report: await probeTab(tab.id) });
  }

  const text = formatProbes(results);
  const clean = results.filter((r) => probeIsClean(r.report)).length;

  await openModal({
    title: `Page check — ${clean} of ${results.length} fully supported`,
    hint:
      'What Insert, Attach and Capture would find on each page right now. Copy this and keep it — it is the record of which selectors are actually verified.',
    fields: [{ name: 'report', label: 'Report', type: 'textarea', rows: 18, value: text }],
    confirmLabel: 'Close',
    extraButtons: [
      {
        label: 'Copy',
        onClick: async () => {
          const ok = await copyToClipboard(text);
          showToast(ok ? 'Report copied.' : 'Could not copy.', ok ? 'success' : 'warning');
        },
      },
    ],
  });
}

export function initDiagnose() {
  document.getElementById('check-page-btn').addEventListener('click', runPageCheck);
}
