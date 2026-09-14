// The byte store — where an imported file's actual content lives.
//
// Everything else in Edge Studio is small text records in
// chrome.storage.local, which is the wrong home for a 20 MB clip: it's
// read whole, it's cloned on every get, and a page that lists assets
// would drag every byte of every file through memory to show a grid of
// thumbnails. So bytes go in IndexedDB, keyed by blob id, and the asset
// record keeps nothing but the id, the size and the type.
//
// Bytes are held for one reason: attaching a file to a chat or
// generator tab needs the real thing, not a reference. Everything else
// about an asset — the thumbnail, the description, the source — stays
// on the record, so the grid never touches this store.
//
// The backend is injectable so tests can drive the policy without an
// IndexedDB; `blobs` is the real one every page imports.

export const DB_NAME = 'edge-studio-files';
export const STORE_NAME = 'blobs';
const DB_VERSION = 1;

// Above this a file is kept as a reference — thumbnail, name, size, and
// a Drive link if there is one — but its bytes are not held and it
// cannot be attached. Chrome's message passing is the real constraint:
// an attachment crosses from an extension page to a content script as
// an encoded payload, and that stops being dependable long before video
// file sizes.
export const MAX_STORED_BYTES = 50 * 1024 * 1024;

export function isTooLarge(size) {
  return Number(size) > MAX_STORED_BYTES;
}

export function formatBytes(size) {
  const n = Number(size) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function newBlobId() {
  return `blob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------- the IndexedDB backend ----------

function indexedDbBackend({ indexedDB = globalThis.indexedDB, dbName = DB_NAME } = {}) {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  function run(mode, work) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, mode);
          const store = tx.objectStore(STORE_NAME);
          let result;
          try {
            result = work(store);
          } catch (error) {
            reject(error);
            return;
          }
          tx.oncomplete = () => resolve(result && result.__request ? result.__request.result : result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        })
    );
  }

  const request = (req) => ({ __request: req });

  return {
    async get(id) {
      return run('readonly', (store) => request(store.get(id)));
    },
    async put(record) {
      await run('readwrite', (store) => request(store.put(record)));
      return record;
    },
    async delete(id) {
      await run('readwrite', (store) => request(store.delete(id)));
    },
    async keys() {
      return run('readonly', (store) => request(store.getAllKeys()));
    },
    async all() {
      return run('readonly', (store) => request(store.getAll()));
    },
  };
}

// ---------- the store ----------

export function createBlobStore({ backend } = {}) {
  const store = backend || indexedDbBackend();

  return {
    // `data` is a Blob or File. Returns the stored record's metadata —
    // never the bytes, so a caller can't accidentally hold a copy.
    async put(id, data, { name, type } = {}) {
      const size = data.size ?? data.byteLength ?? 0;
      if (isTooLarge(size)) {
        throw new Error(
          `"${name || id}" is ${formatBytes(size)} — over the ${formatBytes(MAX_STORED_BYTES)} limit for a stored file.`
        );
      }
      const record = {
        id,
        blob: data,
        name: name || data.name || id,
        type: type || data.type || 'application/octet-stream',
        size,
        addedAt: new Date().toISOString(),
      };
      await store.put(record);
      return meta(record);
    },

    async get(id) {
      if (!id) return null;
      return (await store.get(id)) || null;
    },

    async getBlob(id) {
      const record = await this.get(id);
      return record ? record.blob : null;
    },

    async has(id) {
      return !!(id && (await store.get(id)));
    },

    async remove(id) {
      if (id) await store.delete(id);
    },

    async keys() {
      return store.keys();
    },

    // What the byte store is costing, for Settings.
    async usage() {
      const records = await store.all();
      return {
        count: records.length,
        bytes: records.reduce((total, record) => total + (record.size || 0), 0),
      };
    },

    // Drops bytes for assets that no longer exist. Called after a
    // delete, and on demand from Settings — an interrupted delete
    // would otherwise leave bytes with nothing pointing at them.
    async pruneExcept(keepIds) {
      const keep = new Set(keepIds);
      const ids = await store.keys();
      const orphans = ids.filter((id) => !keep.has(id));
      for (const id of orphans) await store.delete(id);
      return orphans.length;
    },
  };
}

function meta(record) {
  return { id: record.id, name: record.name, type: record.type, size: record.size, addedAt: record.addedAt };
}

export const blobs = createBlobStore();
