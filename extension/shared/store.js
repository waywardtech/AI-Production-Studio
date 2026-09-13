// The record store — every piece of Edge Studio's data goes through here,
// from every page and from the background worker.
//
// Layout in chrome.storage.local:
//
//   es:<collection>:<id>        one record per key
//   es:settings:<name>          one settings object per key
//   es:sync:<collection>:<id>   sync bookkeeping for a record (stage: Drive)
//
// One key per record, rather than one array per collection, is the
// point. Two pages open at once — the side panel and the studio, or two
// studio tabs — each read-modify-write their own records, so neither can
// silently overwrite the other's unrelated work.
//
// Sync bookkeeping is kept apart from the record for the same reason. A
// page holds its records in memory and writes them back whole. If the
// Google Doc a record belongs to were stored on the record itself, a
// page holding a copy from before the first sync would write it back
// without the Doc's id, and the next sync would create a second Doc.
// Pages never touch es:sync:* keys, so that can't happen.

export const COLLECTIONS = ['projects', 'prompts', 'replies', 'productions', 'assets', 'documents'];

const PREFIX = 'es:';

export const recordKey = (collection, id) => `${PREFIX}${collection}:${id}`;
export const settingKey = (name) => `${PREFIX}settings:${name}`;
export const syncKey = (collection, id) => `${PREFIX}sync:${collection}:${id}`;

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function nowISO() {
  return new Date().toISOString();
}

// Keys written by this context, with the updatedAt they were written at,
// so change notifications can say whether a change came from here or
// from somewhere else.
const writtenHere = new Map();

async function allKeys() {
  const area = chrome.storage.local;
  if (typeof area.getKeys === 'function') return area.getKeys();
  return Object.keys(await area.get(null));
}

function assertCollection(collection) {
  if (!COLLECTIONS.includes(collection)) throw new Error(`Unknown collection "${collection}"`);
}

// ---------- records ----------

// Newest first by creation, which is the order every list in the UI
// already used. `projectId` narrows to one project; tombstones (records
// deleted but not yet removed from Google) are left out unless asked for.
export async function list(collection, { projectId, includeDeleted = false } = {}) {
  assertCollection(collection);
  const prefix = `${PREFIX}${collection}:`;
  const keys = (await allKeys()).filter((k) => k.startsWith(prefix));
  if (keys.length === 0) return [];

  const data = await chrome.storage.local.get(keys);
  return Object.values(data)
    .filter((record) => record && typeof record === 'object')
    .filter((record) => includeDeleted || !record.deletedAt)
    .filter((record) => projectId === undefined || record.projectId === projectId)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function get(collection, id) {
  assertCollection(collection);
  const key = recordKey(collection, id);
  const data = await chrome.storage.local.get(key);
  const record = data[key] || null;
  return record && !record.deletedAt ? record : null;
}

// Saves a record, stamping createdAt/updatedAt. The record passed in is
// updated in place and returned, because the pages keep live objects and
// mutate them — a copy would leave the page holding a stale updatedAt.
//
// `fromSync` is for the sync engine only: it writes a record exactly as
// it arrived from Drive, keeping that copy's timestamps.
export async function put(collection, record, { fromSync = false } = {}) {
  assertCollection(collection);
  if (!record || !record.id) throw new Error(`Cannot save a ${collection} record without an id`);

  if (!fromSync) {
    const now = nowISO();
    if (!record.createdAt) record.createdAt = now;
    record.updatedAt = now;
  }

  const key = recordKey(collection, record.id);
  writtenHere.set(key, record.updatedAt);
  await chrome.storage.local.set({ [key]: structuredClone(record) });
  return record;
}

export async function putMany(collection, records) {
  assertCollection(collection);
  const now = nowISO();
  const writes = {};
  records.forEach((record) => {
    if (!record.createdAt) record.createdAt = now;
    record.updatedAt = now;
    const key = recordKey(collection, record.id);
    writtenHere.set(key, record.updatedAt);
    writes[key] = structuredClone(record);
  });
  if (records.length) await chrome.storage.local.set(writes);
  return records;
}

// Deleting depends on whether Google is connected. Without it there's
// nothing remote to clean up, so the record simply goes. With it, the
// record stays as a tombstone until the sync engine has moved its Doc to
// Drive's trash — otherwise the Doc would outlive the record forever.
export async function remove(collection, id) {
  assertCollection(collection);
  const key = recordKey(collection, id);
  const google = await getSetting('google', {});

  if (!google.connected) {
    writtenHere.set(key, null);
    await chrome.storage.local.remove([key, syncKey(collection, id)]);
    return;
  }

  const data = await chrome.storage.local.get(key);
  const record = data[key];
  if (!record) return;
  const now = nowISO();
  record.deletedAt = now;
  record.updatedAt = now;
  writtenHere.set(key, now);
  await chrome.storage.local.set({ [key]: record });
}

// Removes a record and its sync bookkeeping outright. Used by the sync
// engine once a tombstone's remote copy is gone.
export async function purge(collection, id) {
  assertCollection(collection);
  await chrome.storage.local.remove([recordKey(collection, id), syncKey(collection, id)]);
}

// ---------- settings ----------

export async function getSetting(name, fallback = null) {
  const key = settingKey(name);
  const data = await chrome.storage.local.get(key);
  return data[key] === undefined ? fallback : data[key];
}

export async function setSetting(name, value) {
  const key = settingKey(name);
  writtenHere.set(key, JSON.stringify(value));
  await chrome.storage.local.set({ [key]: value });
  return value;
}

// Read-modify-write of one settings object, so a caller changing one
// field doesn't overwrite another field a different page just changed.
export async function updateSetting(name, change) {
  const current = (await getSetting(name, {})) || {};
  const next = { ...current, ...(typeof change === 'function' ? change(current) : change) };
  return setSetting(name, next);
}

// ---------- sync bookkeeping (sync engine only) ----------

export async function getSyncMeta(collection, id) {
  const key = syncKey(collection, id);
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

export async function setSyncMeta(collection, id, meta) {
  await chrome.storage.local.set({ [syncKey(collection, id)]: meta });
  return meta;
}

// ---------- change notifications ----------

// Calls `listener(events)` whenever records or settings change, in this
// context or any other. Each event says what changed and whether it was
// this context's own write (`self`), so a page can ignore the echo of its
// own save and still react when the other page, or a sync, changes
// something underneath it.
export function subscribe(listener) {
  const handler = (changes, areaName) => {
    if (areaName !== 'local') return;
    const events = [];

    Object.entries(changes).forEach(([key, change]) => {
      if (!key.startsWith(PREFIX) || key.startsWith(`${PREFIX}sync:`)) return;
      const match = key.match(/^es:([^:]+):(.+)$/);
      if (!match) return;
      const [, kind, id] = match;

      const next = change.newValue;
      const marker = writtenHere.get(key);
      let self = false;
      if (writtenHere.has(key)) {
        self =
          kind === 'settings'
            ? marker === JSON.stringify(next)
            : next === undefined
              ? marker === null
              : marker === next.updatedAt;
      }

      events.push({
        kind: kind === 'settings' ? 'setting' : 'record',
        collection: kind === 'settings' ? null : kind,
        name: kind === 'settings' ? id : null,
        id,
        record: next ?? null,
        previous: change.oldValue ?? null,
        self,
      });
    });

    if (events.length) listener(events);
  };

  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
