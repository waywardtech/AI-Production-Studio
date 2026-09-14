// Edge Studio — Settings: connecting Google Docs, and backups.

import { migrate } from '../shared/migrate.js';
import { COLLECTIONS, getSetting, list, subscribe, updateSetting } from '../shared/store.js';
import { connect, disableBrowsing, disconnect, enableBrowsing, looksLikeClientId, redirectUri } from '../shared/google-auth.js';
import { blobs, formatBytes } from '../shared/blobs.js';
import { openModal } from '../shared/modal.js';
import { copyToClipboard, showToast } from '../shared/ui.js';
import { describeSyncState, relativeTime } from '../shared/sync-status.js';

const $ = (id) => document.getElementById(id);

// ---------- Google Docs ----------

async function fetchAccount(accessToken) {
  const response = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Couldn't read your Google account (${response.status}).`);
  const data = await response.json();
  return { email: data.user?.emailAddress || null, name: data.user?.displayName || null };
}

async function renderGoogle() {
  const google = (await getSetting('google', {})) || {};
  const hasClient = looksLikeClientId(google.clientId);
  const state = describeSyncState(google);

  const pill = $('google-status');
  pill.textContent = state.label;
  pill.dataset.state = state.state;

  $('google-connected').classList.toggle('hidden', !google.connected);
  $('google-ready').classList.toggle('hidden', google.connected || !hasClient);

  // The setup steps are the whole story until a client id exists; after
  // that they're reference, folded away.
  const setup = $('google-setup');
  if (!hasClient && !setup.dataset.userToggled) setup.open = true;

  if (google.connected) {
    $('google-account').textContent = google.account?.email
      ? `${google.account.name ? `${google.account.name} · ` : ''}${google.account.email}`
      : 'Connected';
    $('google-last-sync').textContent =
      google.status === 'syncing' ? 'Syncing now…' : google.lastSyncAt ? relativeTime(google.lastSyncAt) : 'Not yet';

    const link = $('google-folder-link');
    if (google.rootFolderUrl) {
      link.href = google.rootFolderUrl;
      link.textContent = 'Open “Edge Studio” in Drive ↗';
    } else {
      link.removeAttribute('href');
      link.textContent = 'Created on the first sync';
    }

    const error = $('google-error');
    error.textContent = google.lastError || '';
    error.classList.toggle('hidden', !google.lastError);
    $('reconnect-btn').classList.toggle('hidden', google.status !== 'reconnect');
    $('sync-now-btn').disabled = google.status === 'syncing';

    const browsing = !!google.browseEnabled;
    $('browse-state').textContent = browsing
      ? 'On — “From Drive” in the studio can read files you pick.'
      : 'Off — only the files Edge Studio created are visible to it.';
    $('enable-browse-btn').classList.toggle('hidden', browsing);
    $('disable-browse-btn').classList.toggle('hidden', !browsing);
  }

  if (document.activeElement !== $('client-id-input')) {
    $('client-id-input').value = google.clientId || '';
  }
}

async function saveClientId() {
  const value = $('client-id-input').value.trim();
  if (!looksLikeClientId(value)) {
    showToast('That doesn’t look like a client ID — it should end in .apps.googleusercontent.com.', 'warning');
    return;
  }
  await updateSetting('google', { clientId: value });
  $('google-setup').open = false;
  showToast('Client ID saved. Now connect.');
  await renderGoogle();
}

async function runConnect(errorEl) {
  errorEl?.classList.add('hidden');
  try {
    const account = await connect({ fetchAccount });
    showToast(`Connected as ${account.email || 'your Google account'}. Starting the first sync…`);
    chrome.runtime.sendMessage({ type: 'EDGE_STUDIO_SYNC_NOW' }).catch(() => {});
  } catch (error) {
    if (errorEl) {
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden');
    } else {
      showToast(error.message, 'warning');
    }
  }
  await renderGoogle();
}

async function syncNow() {
  $('sync-now-btn').disabled = true;
  const summary = await chrome.runtime.sendMessage({ type: 'EDGE_STUDIO_SYNC_NOW' }).catch(() => null);
  if (summary && !summary.errors?.length) {
    const moved = summary.pushed + summary.pulled + summary.readBack;
    showToast(moved ? `Synced — ${describeSummary(summary)}.` : 'Everything is already up to date.');
  }
  await renderGoogle();
}

function describeSummary(summary) {
  const parts = [];
  if (summary.pushed) parts.push(`${summary.pushed} sent to Drive`);
  if (summary.pulled) parts.push(`${summary.pulled} brought in`);
  if (summary.readBack) parts.push(`${summary.readBack} updated from Docs`);
  if (summary.trashed) parts.push(`${summary.trashed} moved to Drive trash`);
  return parts.join(', ');
}

async function runDisconnect() {
  const confirmed = await openModal({
    title: 'Disconnect Google Docs?',
    body: 'Edge Studio stops syncing from this browser. Everything stays here, and your Docs and folders stay in Drive — reconnect any time to pick up again.',
    confirmLabel: 'Disconnect',
    danger: true,
  });
  if (confirmed === null) return;
  await disconnect();
  showToast('Disconnected. Your Docs are still in Drive.');
  await renderGoogle();
}

// ---------- backup ----------

const BACKUP_FORMAT = 'edge-studio-backup';

async function renderBlobUsage() {
  try {
    const { count, bytes } = await blobs.usage();
    $('blob-usage').textContent = count
      ? `${count} file${count === 1 ? '' : 's'} · ${formatBytes(bytes)}`
      : 'No files held here yet.';
  } catch (error) {
    $('blob-usage').textContent = `Could not read the file store: ${error.message}`;
  }
}

async function renderCounts() {
  const counts = $('counts');
  counts.innerHTML = '';
  for (const collection of COLLECTIONS) {
    const dt = document.createElement('dt');
    dt.textContent = collection[0].toUpperCase() + collection.slice(1);
    const dd = document.createElement('dd');
    dd.textContent = String((await list(collection)).length);
    counts.append(dt, dd);
  }
}

async function exportBackup() {
  const everything = await chrome.storage.local.get(null);
  const data = Object.fromEntries(
    Object.entries(everything).filter(
      // The migration's safety copy is large and already superseded; the
      // Google setting holds this browser's connection, which shouldn't
      // travel to another one.
      ([key]) => key.startsWith('es:') && key !== 'es:backup:v1' && key !== 'es:settings:google'
    )
  );
  const payload = {
    format: BACKUP_FORMAT,
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    data,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `edge-studio-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  showToast('Backup downloaded.');
}

// Restoring merges rather than replaces: a record comes in only if it's
// missing here or the backup's copy is newer. Nothing is deleted, so
// restoring an old backup can't undo newer work.
async function importBackup(file) {
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    showToast("That file isn't valid JSON.", 'warning');
    return;
  }
  if (payload?.format !== BACKUP_FORMAT || typeof payload.data !== 'object') {
    showToast("That isn't an Edge Studio backup.", 'warning');
    return;
  }

  const incoming = Object.entries(payload.data).filter(([key]) => key.startsWith('es:') && key !== 'es:settings:google');
  const existing = await chrome.storage.local.get(incoming.map(([key]) => key));
  const writes = {};
  let newer = 0;
  let added = 0;

  incoming.forEach(([key, value]) => {
    const current = existing[key];
    const isRecord = /^es:(projects|prompts|replies|productions|assets|documents):/.test(key);
    if (current === undefined) {
      writes[key] = value;
      if (isRecord) added += 1;
    } else if (isRecord && (value?.updatedAt || '') > (current?.updatedAt || '')) {
      writes[key] = value;
      newer += 1;
    }
  });

  const confirmed = await openModal({
    title: 'Restore from backup?',
    body: `From ${payload.exportedAt ? new Date(payload.exportedAt).toLocaleString() : 'an unknown date'}: ${added} record${added === 1 ? '' : 's'} to add and ${newer} newer cop${newer === 1 ? 'y' : 'ies'} to bring in. Nothing here is deleted or replaced with an older version.`,
    confirmLabel: 'Restore',
  });
  if (confirmed === null) return;

  if (Object.keys(writes).length) await chrome.storage.local.set(writes);
  showToast(`Restored ${added + newer} record${added + newer === 1 ? '' : 's'}.`);
  await renderCounts();
}

// ---------- start ----------

async function init() {
  await migrate();

  $('redirect-uri').textContent = redirectUri();
  $('extension-id').textContent = chrome.runtime.id;
  $('version').textContent = `Edge Studio ${chrome.runtime.getManifest().version}`;

  $('google-setup').addEventListener('toggle', () => {
    $('google-setup').dataset.userToggled = '1';
  });
  $('copy-redirect-btn').addEventListener('click', async () => {
    const ok = await copyToClipboard(redirectUri());
    showToast(ok ? 'Redirect URI copied.' : 'Could not copy — select it and copy by hand.', ok ? 'success' : 'warning');
  });
  $('save-client-btn').addEventListener('click', saveClientId);
  $('client-id-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveClientId();
  });
  $('change-client-btn').addEventListener('click', () => {
    $('google-setup').open = true;
    $('client-id-input').focus();
  });
  $('connect-btn').addEventListener('click', () => runConnect($('connect-error')));
  $('reconnect-btn').addEventListener('click', () => runConnect($('google-error')));
  $('sync-now-btn').addEventListener('click', syncNow);
  $('disconnect-btn').addEventListener('click', runDisconnect);

  $('export-btn').addEventListener('click', exportBackup);
  $('import-btn').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => {
    const [file] = $('import-file').files;
    $('import-file').value = '';
    if (file) await importBackup(file);
  });

  $('enable-browse-btn').addEventListener('click', async () => {
    const error = $('browse-error');
    error.classList.add('hidden');
    try {
      await enableBrowsing();
      await renderGoogle();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
      await renderGoogle();
    }
  });

  $('disable-browse-btn').addEventListener('click', async () => {
    await disableBrowsing();
    await renderGoogle();
  });

  // Bytes left behind by a delete that didn't finish. Anything still
  // pointed at by an asset is kept.
  $('prune-blobs-btn').addEventListener('click', async () => {
    const keep = (await list('assets', { includeDeleted: true }))
      .map((asset) => asset.fileRef?.blobId)
      .filter(Boolean);
    const dropped = await blobs.pruneExcept(keep);
    await renderBlobUsage();
    $('blob-usage').textContent += dropped ? ` · removed ${dropped} orphaned` : ' · nothing to remove';
  });

  subscribe((events) => {
    if (events.some((e) => e.kind === 'setting' && e.name === 'google')) renderGoogle();
    if (events.some((e) => e.kind === 'record')) {
      renderCounts();
      renderBlobUsage();
    }
  });
  // Keeps "3 min ago" honest while the page is open.
  setInterval(renderGoogle, 30 * 1000);

  await renderGoogle();
  await renderCounts();
  await renderBlobUsage();
}

init();
