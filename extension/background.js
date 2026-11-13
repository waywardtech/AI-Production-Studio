// Edge Studio — background service worker
// Covers: M1-1 (extension scaffold), M1-5/M1.5-6 (tab detection across
// ChatGPT, Claude and Gemini), M1-7/M1-8 (send-to-tab relay), and
// CORE-4 (keeping the record store in step with Google Docs).

import { migrate } from './shared/migrate.js';
import { get, getSetting, getSyncMeta, list, subscribe, updateSetting } from './shared/store.js';
import { createDrive } from './shared/drive.js';
import { canBrowse, getAccessToken, invalidateToken } from './shared/google-auth.js';
import { clearStaleSyncing, createSyncEngine } from './shared/sync.js';
import { createSingleFlight } from './shared/watchdog.js';
import { createRelay } from './shared/relay.js';
import { blobs, isTooLarge, newBlobId } from './shared/blobs.js';
import { assembleSegments, profileById, segmentText, targetById } from './studio/lib/prompt.js';

const SYNC_ALARM = 'edge-studio-sync';
const SYNC_EVERY_MINUTES = 5;
// After an edit, wait this long for more before syncing, so typing a
// paragraph is one sync, not forty.
const SYNC_DEBOUNCE_MS = 4000;
// A sync run is given up on after this long with no progress at all —
// not after this long in total. It has to exceed the longest single
// Drive request (a five-minute asset transfer), or a legitimate upload
// would be mistaken for a stall.
const SYNC_STALL_MS = 6 * 60 * 1000;

// Installing or updating brings stored data into the current shape
// straight away, rather than waiting for the first page to open. Every
// page runs the same migration on load too; it's safe to run twice.
chrome.runtime.onInstalled.addListener(() => {
  migrate()
    .then((result) => {
      if (result.migrated) console.log('[Edge Studio] Migrated stored data:', result);
    })
    .catch((error) => console.error('[Edge Studio] Migration failed:', error));
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_EVERY_MINUTES });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_EVERY_MINUTES });
  scheduleSync(2000);
});

// ---------- CORE-4: Google Docs sync ----------
//
// This worker is the only place sync runs, so two open pages can never
// push the same change twice. Pages ask for a sync by message; edits
// trigger one by themselves through storage change events; an alarm
// catches up with edits made on other machines or directly in Docs.

const drive = createDrive({
  fetchImpl: (...args) => fetch(...args),
  auth: { getAccessToken, invalidateToken },
});

// The shot list Doc is the studio's own assembled prompt per scene, so
// the Doc reads exactly like what Produce would send.
async function productionContext(production) {
  const assets = await list('assets', { projectId: production.projectId });
  return {
    assembleShot: (scene) =>
      assembleSegments(production, scene, { assets }).map(segmentText).join('\n\n'),
    targetLabel: targetById(production.target).label,
    profileLabel: profileById(production.profile).label,
  };
}

// The worker has IndexedDB, so it can hand the engine an asset's bytes
// to upload. A machine that doesn't hold them just has nothing to send.
const engine = createSyncEngine({ drive, productionContext, blobSource: blobs });

let timer = null;

// One sync at a time, and never one that holds the lock forever. Before
// this, a run that stopped moving — a request that never returned, a
// token renewal that never came back — kept `running` set for the life
// of the worker, and every later sync was handed the same stuck promise.
const syncFlight = createSingleFlight(({ signal, beat }) => engine.run({ signal, beat }), {
  stallMs: SYNC_STALL_MS,
  what: 'Sync',
  // The stuck run can't report its own failure, so it is reported here.
  onStall: async (error) => {
    console.error('[Edge Studio] Sync stalled:', error.message);
    await updateSetting('google', {
      status: 'error',
      lastError: `${error.message} Nothing was lost — it will run again at the next sync.`,
    });
  },
  // Something asked for another pass every time, five times running.
  // Stop, and let the usual debounce decide when to look again.
  onRerunsCapped: () => scheduleSync(),
});

async function runSync() {
  try {
    return await syncFlight.start();
  } catch (error) {
    console.error('[Edge Studio] Sync failed:', error);
    return undefined;
  }
}

function scheduleSync(delay = SYNC_DEBOUNCE_MS) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const google = (await getSetting('google', {})) || {};
    if (google.connected) runSync();
  }, delay);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) scheduleSync(0);
});

// A worker killed mid-sync leaves "syncing" in storage with nothing
// syncing. This is the first thing a fresh worker checks.
clearStaleSyncing()
  .then((wasStale) => {
    if (wasStale) scheduleSync(500);
  })
  .catch((error) => console.error('[Edge Studio] Could not check for an interrupted sync:', error));

// Records changed by a page (not by this worker's own sync) are due for
// upload. Connecting Google starts a first sync straight away.
subscribe((events) => {
  let due = false;
  events.forEach((event) => {
    if (event.self) return;
    if (event.kind === 'record') due = true;
    if (event.kind === 'setting' && event.name === 'google' && event.record?.connected && !event.previous?.connected) {
      scheduleSync(500);
    }
  });
  if (due) scheduleSync();
});

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[Edge Studio] setPanelBehavior failed:', error));

// --- M1-5 / M1.5-6: Tab detection ---
// The side panel asks the background worker for the current list of
// open chat tabs, since only the background worker has the "tabs"
// permission context needed to query across windows. Each tab carries
// its platform so the panel can badge it and so Optimize can default
// its target to whatever the worker tab already is.
// `kind` separates chats (which answer, so Optimize and the studio's
// round trips can run in them) from generator pages (which only take a
// prompt). Both can receive an Insert or a Produce.
const CHAT_PLATFORMS = [
  { platform: 'chatgpt', label: 'ChatGPT', kind: 'chat', urls: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] },
  { platform: 'claude', label: 'Claude', kind: 'chat', urls: ['https://claude.ai/*'] },
  { platform: 'gemini', label: 'Gemini', kind: 'chat', urls: ['https://gemini.google.com/*'] },
  { platform: 'sora', label: 'Sora', kind: 'generator', urls: ['https://sora.chatgpt.com/*'] },
  { platform: 'flow', label: 'Flow', kind: 'generator', urls: ['https://labs.google/fx/*'] },
];

async function findChatTabs() {
  const found = [];
  for (const entry of CHAT_PLATFORMS) {
    const tabs = await chrome.tabs.query({ url: entry.urls });
    tabs.forEach((tab) =>
      found.push({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        windowId: tab.windowId,
        platform: entry.platform,
        platformLabel: entry.label,
        kind: entry.kind,
      })
    );
  }
  return found;
}

// --- M1-7 / M1-8 / M2-1: Content-script relay ---
// The side panel is a separate extension context and can't message a
// content script directly, so the background worker relays the request.
// Everything that talks to the page — injecting a prompt, capturing a
// response, capturing a selection — goes through relayToTab so they all
// get the same recovery behaviour.
// The relay itself lives in shared/relay.js, where it can be tested: it
// always answers, and always within a bound, even when the tab doesn't.
const relayToTab = createRelay({
  sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  executeScript: (injection) => chrome.scripting.executeScript(injection),
});

// An asset imported on another machine arrives as a record with no
// bytes behind it. The file is in Drive, so fetch it on demand rather
// than pulling every project's media down on every sync. The worker
// does it because it already holds the Drive client — and because
// pages and the worker share one IndexedDB, the bytes land where the
// page will find them.
async function fetchAssetBytes(assetId) {
  const asset = await get('assets', assetId);
  if (!asset) return { success: false, reason: 'That asset is gone.' };

  const blobId = asset.fileRef?.blobId;
  if (!blobId) return { success: false, reason: 'That asset has no file behind it.' };
  if (await blobs.has(blobId)) return { success: true, already: true };

  const meta = await getSyncMeta('assets', assetId);
  if (!meta?.fileId) {
    return { success: false, reason: "This file hasn't reached Drive — it was imported on another machine and hasn't synced." };
  }

  try {
    const blob = await drive.downloadFile(meta.fileId);
    if (!blob) return { success: false, reason: 'The file is no longer in Drive.' };
    await blobs.put(blobId, blob, { name: asset.fileRef.name, type: asset.fileRef.type });
    return { success: true, size: blob.size };
  } catch (error) {
    return { success: false, reason: error.message };
  }
}

// ---------- browsing and importing from Drive (M5-3) ----------
//
// The worker does this rather than the page because it already holds
// the Drive client and the token, and because pages share its
// IndexedDB: bytes it downloads are immediately visible to the studio.

const GOOGLE_DOC_MIMES = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

async function browseGuard() {
  if (await canBrowse()) return null;
  return {
    success: false,
    needsPermission: true,
    reason: 'Turn on Drive browsing in Settings first — reading files Edge Studio did not create needs its own permission.',
  };
}

async function driveList({ parentId, pageToken }) {
  const denied = await browseGuard();
  if (denied) return denied;
  try {
    const page = await drive.listFolderPage({ parentId, pageToken });
    return { success: true, ...page };
  } catch (error) {
    return { success: false, reason: error.message };
  }
}

async function driveSearch({ text }) {
  const denied = await browseGuard();
  if (denied) return denied;
  try {
    const page = await drive.searchFiles(text);
    return { success: true, ...page };
  } catch (error) {
    return { success: false, reason: error.message };
  }
}

// A Google Doc has no bytes worth downloading — it becomes text, which
// the studio files in the In-box. Everything else comes down as itself.
async function driveImport({ fileId }) {
  const denied = await browseGuard();
  if (denied) return denied;

  try {
    const file = await drive.getFile(fileId);
    if (!file) return { success: false, reason: 'That file is no longer in Drive.' };

    const exportMime = GOOGLE_DOC_MIMES[file.mimeType];
    if (exportMime) {
      const text = await drive.exportText(file.id);
      return { success: true, kind: 'text', name: file.name, text, url: file.webViewLink || null };
    }

    const size = Number(file.size) || 0;
    if (isTooLarge(size)) {
      return {
        success: true,
        kind: 'reference',
        name: file.name,
        mimeType: file.mimeType,
        size,
        url: file.webViewLink || null,
        driveFileId: file.id,
      };
    }

    const blob = await drive.downloadFile(file.id);
    if (!blob) return { success: false, reason: 'That file could not be downloaded.' };

    const blobId = newBlobId();
    await blobs.put(blobId, blob, { name: file.name, type: file.mimeType });
    return {
      success: true,
      kind: 'file',
      name: file.name,
      mimeType: file.mimeType || blob.type,
      size: blob.size,
      blobId,
      url: file.webViewLink || null,
      driveFileId: file.id,
    };
  } catch (error) {
    return { success: false, reason: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EDGE_STUDIO_DRIVE_LIST') {
    driveList(message).then(sendResponse);
    return true;
  }

  if (message.type === 'EDGE_STUDIO_DRIVE_SEARCH') {
    driveSearch(message).then(sendResponse);
    return true;
  }

  if (message.type === 'EDGE_STUDIO_DRIVE_IMPORT') {
    driveImport(message).then(sendResponse);
    return true;
  }

  if (message.type === 'EDGE_STUDIO_FETCH_ASSET_BYTES') {
    fetchAssetBytes(message.assetId).then(sendResponse);
    return true;
  }

  if (message.type === 'EDGE_STUDIO_SYNC_NOW') {
    runSync().then((summary) => sendResponse(summary || null));
    return true;
  }

  if (message.type === 'EDGE_STUDIO_GET_TABS') {
    findChatTabs().then(sendResponse);
    return true; // keep the message channel open for the async response
  }

  if (message.type === 'EDGE_STUDIO_SEND_TO_TAB') {
    relayToTab(message.tabId, {
      type: 'EDGE_STUDIO_INJECT_PROMPT',
      text: message.text,
    }).then(sendResponse);
    return true;
  }

  // --- M2-1 / M2-2 / CORE-8: capture relays ---
  if (
    message.type === 'EDGE_STUDIO_CAPTURE_RESPONSE' ||
    message.type === 'EDGE_STUDIO_CAPTURE_SELECTION' ||
    message.type === 'EDGE_STUDIO_CAPTURE_USAGE' ||
    message.type === 'EDGE_STUDIO_PROBE'
  ) {
    relayToTab(message.tabId, { type: message.type }).then(sendResponse);
    return true;
  }

  // --- M5-4: attachment relays ---
  // Passed through whole: the worker is a postbox for these, and the
  // chunks are only meaningful to the content script assembling them.
  if (
    message.type === 'EDGE_STUDIO_ATTACH_BEGIN' ||
    message.type === 'EDGE_STUDIO_ATTACH_CHUNK' ||
    message.type === 'EDGE_STUDIO_ATTACH_COMMIT'
  ) {
    const { tabId, ...rest } = message;
    relayToTab(tabId, rest).then(sendResponse);
    return true;
  }
});
