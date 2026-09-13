// The small "where is my work" indicator in each page's header.
//
// It answers one question at a glance — is this saved to Google Docs? —
// and is the way into Settings when the answer is "not yet" or "there's
// a problem".

import { getSetting, subscribe } from './store.js';

export function relativeTime(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

// One source of wording for every page.
export function describeSyncState(google = {}) {
  if (!google.connected) {
    return { state: 'off', label: 'Local only', detail: 'Saved in this browser. Connect Google Docs in Settings to keep everything in Drive.' };
  }
  switch (google.status) {
    case 'syncing':
      return { state: 'syncing', label: 'Syncing…', detail: 'Sending changes to Google Docs.' };
    case 'reconnect':
      return { state: 'reconnect', label: 'Reconnect Google', detail: 'Google needs you to sign in again. Open Settings to reconnect.' };
    case 'error':
      return { state: 'error', label: 'Sync issue', detail: google.lastError || 'Something didn’t sync. Open Settings for details.' };
    default:
      return {
        state: 'idle',
        label: google.lastSyncAt ? `In Google Docs · ${relativeTime(google.lastSyncAt)}` : 'Google Docs connected',
        detail: google.account?.email ? `Syncing to ${google.account.email}'s Drive.` : 'Syncing to Google Drive.',
      };
  }
}

export async function mountSyncStatus(button) {
  button.classList.add('sync-status');

  const draw = async () => {
    const google = (await getSetting('google', {})) || {};
    const { state, label, detail } = describeSyncState(google);
    button.dataset.state = state;
    button.textContent = label;
    button.title = `${detail} Click for Settings.`;
  };

  button.addEventListener('click', () => chrome.runtime.openOptionsPage());
  subscribe((events) => {
    if (events.some((e) => e.kind === 'setting' && e.name === 'google')) draw();
  });
  setInterval(draw, 30 * 1000);
  await draw();
}
