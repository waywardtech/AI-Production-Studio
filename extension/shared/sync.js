// Keeps the record store and Google Drive in step.
//
// What ends up in Drive, all inside one "Edge Studio" folder:
//
//   Edge Studio/
//     <Project>/                  a folder per project
//       Prompts/                  a Google Doc per saved prompt
//       Replies/                  a Google Doc per saved reply
//       Productions/
//         <Production>/           a folder per production, holding its
//                                 generated "shot list" Doc
//           In-box/               a Google Doc per script or note
//           Out-box/              a Google Doc per dailies report
//
// Plus, in Drive's hidden app-data folder, one small JSON index file per
// record. The Docs are for people; the index is what lets another
// machine rebuild blocks, scenes, tags and the links between records
// without guessing from the Docs' text.
//
// Each run does three things, in this order:
//
//   1. Pull   — index files newer than the local record are brought in.
//               This is how a second machine catches up.
//   2. Read   — Docs edited in Google Docs since Edge Studio last wrote
//               them are read back into their records (prompts, replies,
//               in-box/out-box documents). A local edit made after the
//               Doc was changed wins instead.
//   3. Push   — records created, changed or deleted locally since their
//               last sync are written out: Doc, folder, index. Deleting
//               moves the Doc or folder to Drive's trash, never destroys.
//
// All folders and Docs are found again by the ids recorded after they
// were made (and by app properties set on them, on a fresh machine), not
// by name — so renaming a folder in Drive doesn't make a second one.

import * as defaultStore from './store.js';
import { COLLECTIONS } from './store.js';
import { DEFAULT_BLOCK_TYPES } from './model.js';
import {
  docToDocumentText,
  docToPromptBlocks,
  docToReplyText,
  documentToDoc,
  productionToDoc,
  promptToDoc,
  replyToDoc,
} from './docs-format.js';
import { DriveError } from './drive.js';
import { NeedsReconnectError } from './google-auth.js';

export const ROOT_FOLDER_NAME = 'Edge Studio';
export const INDEX_SCHEMA = 1;

// Parents before children: a production's folder lives in its project's
// folder, a document's Doc lives in its production's In-box or Out-box.
const PUSH_ORDER = ['projects', 'productions', 'prompts', 'replies', 'documents', 'assets'];
const READ_BACK = new Set(['prompts', 'replies', 'documents']);

const isNotFound = (error) => error instanceof DriveError && error.status === 404;

export function createSyncEngine({
  drive,
  store = defaultStore,
  // (production) => { assembleShot(scene), targetLabel, profileLabel } —
  // supplied by the background worker, which can load the studio's pure
  // prompt assembly. Kept out of here so this module has no studio code.
  productionContext = () => ({ assembleShot: () => '', targetLabel: '', profileLabel: '' }),
  // An asset's bytes live in IndexedDB (shared/blobs.js), which this
  // module shouldn't have to know about — and which doesn't exist in the
  // tests. Injected for both reasons.
  blobSource = { getBlob: async () => null },
  now = () => new Date().toISOString(),
} = {}) {
  let summary;

  // ---------- folders ----------

  async function ensureRoot() {
    const google = (await store.getSetting('google', {})) || {};
    if (google.rootFolderId) {
      const existing = await drive.getFile(google.rootFolderId);
      if (existing && !existing.trashed) return existing.id;
    }
    // A fresh machine, or the folder was trashed: look for one Edge
    // Studio made before creating another.
    const found = (await drive.findByAppProperty('edgeStudioRole', 'root')).find((f) => !f.trashed);
    const root = found || (await drive.createFolder({ name: ROOT_FOLDER_NAME, appProperties: { edgeStudioRole: 'root' } }));
    if (!found) summary.created += 1;
    await store.updateSetting('google', { rootFolderId: root.id, rootFolderUrl: root.webViewLink || null });
    return root.id;
  }

  // Finds (or makes) one folder, identified by app properties rather than
  // by name, and keeps its name in line with the record it stands for.
  async function ensureFolder({ knownId, name, parentId, role, ownerKey, ownerId }) {
    if (knownId) {
      const file = await drive.getFile(knownId);
      if (file && !file.trashed) {
        if (file.name !== name) await drive.update(file.id, { name });
        return file;
      }
    }
    const candidates = await drive.findByAppProperty('edgeStudioRole', role, { parentId });
    const found = candidates.find((f) => !f.trashed && (!ownerKey || f.appProperties?.[ownerKey] === ownerId));
    if (found) {
      if (found.name !== name) await drive.update(found.id, { name });
      return found;
    }
    summary.created += 1;
    return drive.createFolder({
      name,
      parentId,
      appProperties: { edgeStudioRole: role, ...(ownerKey ? { [ownerKey]: ownerId } : {}) },
    });
  }

  async function projectFolders(project, meta, rootId) {
    const folder = await ensureFolder({
      knownId: meta.folderId, name: project.name, parentId: rootId,
      role: 'project', ownerKey: 'edgeStudioProjectId', ownerId: project.id,
    });
    const sub = async (known, name, role) =>
      (await ensureFolder({ knownId: known, name, parentId: folder.id, role })).id;
    return {
      folderId: folder.id,
      folderUrl: folder.webViewLink || null,
      prompts: await sub(meta.prompts, 'Prompts', 'prompts'),
      replies: await sub(meta.replies, 'Replies', 'replies'),
      productions: await sub(meta.productions, 'Productions', 'productions'),
      assets: await sub(meta.assets, 'Assets', 'assets'),
    };
  }

  async function productionFolders(production, meta, parentId) {
    const folder = await ensureFolder({
      knownId: meta.folderId, name: production.name, parentId,
      role: 'production', ownerKey: 'edgeStudioProductionId', ownerId: production.id,
    });
    const sub = async (known, name, role) =>
      (await ensureFolder({ knownId: known, name, parentId: folder.id, role })).id;
    return {
      folderId: folder.id,
      folderUrl: folder.webViewLink || null,
      inbox: await sub(meta.inbox, 'In-box', 'inbox'),
      outbox: await sub(meta.outbox, 'Out-box', 'outbox'),
    };
  }

  // A record's parent has to exist in Drive before the record can go in
  // it. Syncs the parent on demand if this run hasn't reached it yet.
  async function parentMeta(collection, id) {
    let meta = await store.getSyncMeta(collection, id);
    if (meta && meta.folderId) return meta;
    const parent = await store.get(collection, id);
    if (!parent) return null;
    await pushRecord(collection, parent);
    meta = await store.getSyncMeta(collection, id);
    return meta && meta.folderId ? meta : null;
  }

  // ---------- Docs ----------

  // Writes a Doc's content, creating it if it doesn't exist (never made,
  // or trashed/deleted in Drive — the record still exists, so the Doc
  // comes back rather than the record being lost).
  async function upsertDoc(docId, { parentId, name, text, description, appProperties }) {
    if (docId) {
      try {
        const updated = await drive.updateDoc(docId, { name, text, description });
        if (updated && !updated.trashed) return updated;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    summary.created += 1;
    return drive.createDoc({ name, parentId, text, description, appProperties });
  }

  // An asset's bytes, mirrored into the project's Assets folder.
  //
  // Bytes are uploaded once and identified by their blob id: editing an
  // asset's name or description changes the record, not the file, and
  // must not re-upload a 40 MB clip. A machine that doesn't hold the
  // bytes (they were imported somewhere else, or the file was too big to
  // keep) has nothing to upload and says so by leaving the file alone.
  async function assetFile(record, meta, projectMeta) {
    const ref = record.fileRef;
    if (!ref || !ref.blobId) return {};

    const keep = {
      fileId: meta.fileId || null,
      fileUrl: meta.fileUrl || null,
      fileBlobId: meta.fileBlobId || null,
      fileName: meta.fileName || null,
      fileSize: meta.fileSize || null,
    };

    // Already up there, and it's the same bytes: at most a rename.
    if (keep.fileId && keep.fileBlobId === ref.blobId) {
      if (ref.name && keep.fileName !== ref.name) {
        try {
          await drive.update(keep.fileId, { name: ref.name });
          keep.fileName = ref.name;
        } catch (error) {
          if (!isNotFound(error)) throw error;
          // Gone from Drive — fall through and upload it again.
          keep.fileId = null;
        }
      }
      if (keep.fileId) return keep;
    }

    const blob = await blobSource.getBlob(ref.blobId);
    if (!blob) return keep;

    const uploaded = await drive.uploadFile({
      name: ref.name || record.name,
      parentId: projectMeta.assets,
      blob,
      mimeType: ref.type,
      appProperties: { edgeStudioRecord: `assets:${record.id}`, edgeStudioBlobId: ref.blobId },
    });
    summary.created += 1;

    // Replacing the bytes leaves the old file behind; trash it so the
    // Assets folder doesn't accumulate every version of every import.
    if (keep.fileId && keep.fileId !== uploaded.id) await drive.trash(keep.fileId);

    return {
      fileId: uploaded.id,
      fileUrl: uploaded.webViewLink || null,
      fileBlobId: ref.blobId,
      fileName: uploaded.name,
      fileSize: blob.size ?? ref.size ?? null,
    };
  }

  async function docFor(collection, record, meta, rootId) {
    if (collection === 'projects') {
      return { remote: await projectFolders(record, meta, rootId) };
    }

    const projectMeta = await parentMeta('projects', record.projectId);
    if (!projectMeta) throw new Error(`its project (${record.projectId}) isn't available`);

    if (collection === 'productions') {
      const folders = await productionFolders(record, meta, projectMeta.productions);
      const format = productionToDoc(record, await productionContext(record));
      const doc = await upsertDoc(meta.docId, {
        parentId: folders.folderId, ...format,
        appProperties: { edgeStudioRecord: `productions:${record.id}` },
      });
      return { remote: folders, doc, parentId: folders.folderId };
    }

    if (collection === 'assets') return { remote: await assetFile(record, meta, projectMeta) };

    let parentId;
    let format;
    if (collection === 'prompts') {
      const app = (await store.getSetting('app', {})) || {};
      format = promptToDoc(record, app.blockTypes || DEFAULT_BLOCK_TYPES);
      parentId = projectMeta.prompts;
    } else if (collection === 'replies') {
      format = replyToDoc(record);
      parentId = projectMeta.replies;
    } else {
      format = documentToDoc(record);
      const productionMeta = record.productionId ? await parentMeta('productions', record.productionId) : null;
      parentId = productionMeta
        ? record.box === 'outbox' ? productionMeta.outbox : productionMeta.inbox
        : projectMeta.folderId;
    }

    const doc = await upsertDoc(meta.docId, {
      parentId, ...format,
      appProperties: { edgeStudioRecord: `${collection}:${record.id}` },
    });
    return { remote: {}, doc, parentId };
  }

  // ---------- the index ----------

  async function writeIndex(collection, record, meta, remote) {
    const data = { schema: INDEX_SCHEMA, collection, record, remote };
    const appProperties = {
      edgeStudioCollection: collection,
      edgeStudioId: record.id,
      edgeStudioUpdatedAt: record.updatedAt,
      edgeStudioDeleted: record.deletedAt ? '1' : '0',
    };
    if (meta.indexFileId) {
      try {
        return await drive.appData.update(meta.indexFileId, { data, appProperties });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return drive.appData.create({ name: `edge-studio-${collection}-${record.id}.json`, data, appProperties });
  }

  // ---------- push ----------

  const pushedThisRun = new Set();

  async function pushRecord(collection, record) {
    const key = `${collection}:${record.id}`;
    if (pushedThisRun.has(key)) return;
    pushedThisRun.add(key);

    const meta = (await store.getSyncMeta(collection, record.id)) || {};

    if (record.deletedAt) {
      if (meta.docId) await drive.trash(meta.docId);
      if (meta.fileId) await drive.trash(meta.fileId);
      if (meta.folderId) await drive.trash(meta.folderId);
      if (meta.indexFileId) await writeIndex(collection, record, meta, {});
      await store.purge(collection, record.id);
      if (meta.docId || meta.fileId || meta.folderId) summary.trashed += 1;
      return;
    }

    const bytesPending =
      collection === 'assets' && !!record.fileRef?.blobId && meta.fileBlobId !== record.fileRef.blobId;

    const upToDate =
      meta.syncedUpdatedAt === record.updatedAt &&
      meta.indexFileId &&
      !bytesPending &&
      (collection === 'assets' || collection === 'projects' ? true : !!meta.docId) &&
      (collection === 'projects' || collection === 'productions' ? !!meta.folderId : true);
    if (upToDate) return;

    const rootId = await rootPromise;
    const { remote, doc, parentId } = await docFor(collection, record, meta, rootId);

    const nextRemote = {
      ...remote,
      ...(doc ? { docId: doc.id, docUrl: doc.webViewLink || null, docModifiedTime: doc.modifiedTime, parentId } : {}),
    };
    const indexFile = await writeIndex(collection, record, meta, nextRemote);

    await store.setSyncMeta(collection, record.id, {
      ...meta,
      ...nextRemote,
      indexFileId: indexFile.id,
      syncedUpdatedAt: record.updatedAt,
      syncedAt: now(),
      error: null,
    });
    summary.pushed += 1;
  }

  // ---------- pull ----------

  async function pull() {
    const files = await drive.appData.list();
    for (const file of files) {
      const props = file.appProperties || {};
      const collection = props.edgeStudioCollection;
      const id = props.edgeStudioId;
      if (!COLLECTIONS.includes(collection) || !id) continue;

      const remoteUpdatedAt = props.edgeStudioUpdatedAt || '';
      const meta = (await store.getSyncMeta(collection, id)) || {};
      if (meta.indexFileId === file.id && meta.syncedUpdatedAt === remoteUpdatedAt) continue;

      const local = await store.getIncludingDeleted(collection, id);
      if (local && (local.updatedAt || '') >= remoteUpdatedAt) {
        // Ours is as new or newer; push handles it. Remember which index
        // file it is so push updates it instead of making a duplicate.
        if (meta.indexFileId !== file.id) await store.setSyncMeta(collection, id, { ...meta, indexFileId: file.id });
        continue;
      }

      const payload = await drive.appData.read(file.id);
      if (!payload || !payload.record) continue;

      if (payload.record.deletedAt) {
        if (local) {
          await store.purge(collection, id);
          summary.pulled += 1;
        }
        continue;
      }

      await store.put(collection, payload.record, { fromSync: true });
      await store.setSyncMeta(collection, id, {
        ...(payload.remote || {}),
        indexFileId: file.id,
        syncedUpdatedAt: payload.record.updatedAt,
        syncedAt: now(),
        error: null,
      });
      summary.pulled += 1;
    }
  }

  // ---------- read back ----------

  async function readBack() {
    const candidates = [];
    for (const collection of READ_BACK) {
      for (const record of await store.list(collection)) {
        const meta = await store.getSyncMeta(collection, record.id);
        if (meta && meta.docId && meta.parentId) candidates.push({ collection, record, meta });
      }
    }
    if (candidates.length === 0) return;

    // One listing per folder rather than one request per Doc.
    const files = new Map();
    for (const parentId of new Set(candidates.map((c) => c.meta.parentId))) {
      try {
        (await drive.listChildren(parentId)).forEach((f) => files.set(f.id, f));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    const app = (await store.getSetting('app', {})) || {};
    const blockTypes = app.blockTypes || DEFAULT_BLOCK_TYPES;

    for (const { collection, record, meta } of candidates) {
      const file = files.get(meta.docId);
      if (!file || !meta.docModifiedTime || !(file.modifiedTime > meta.docModifiedTime)) continue;

      // Both sides changed since the last sync: the later edit wins. If
      // that's the local one, push rewrites the Doc as usual.
      const changedLocally = record.updatedAt !== meta.syncedUpdatedAt;
      if (changedLocally && record.updatedAt > file.modifiedTime) continue;

      const text = await drive.exportText(meta.docId);
      let changed = false;

      if (collection === 'prompts') {
        const blocks = docToPromptBlocks(text, record, blockTypes);
        if (blocks && JSON.stringify(blocks.map((b) => [b.type, b.text])) !== JSON.stringify(record.blocks.map((b) => [b.type, b.text]))) {
          record.blocks = blocks;
          changed = true;
        }
      } else if (collection === 'replies') {
        const next = docToReplyText(text);
        if (next !== record.text) {
          record.text = next;
          changed = true;
        }
      } else {
        const next = docToDocumentText(text);
        if (next !== (record.text || '').trim()) {
          record.text = next;
          changed = true;
        }
      }

      const title = collection === 'documents' || collection === 'prompts' || collection === 'replies' ? record.title : null;
      if (title !== null && file.name && file.name !== title) {
        record.title = file.name;
        changed = true;
      }

      if (changed) {
        await store.put(collection, record);
        const remote = { docId: meta.docId, docUrl: meta.docUrl, parentId: meta.parentId, docModifiedTime: file.modifiedTime };
        // The Doc already holds this text, so only the index is rewritten;
        // re-uploading would bump the Doc's modifiedTime and read it back
        // again next run.
        const indexFile = await writeIndex(collection, record, meta, remote);
        await store.setSyncMeta(collection, record.id, {
          ...meta, ...remote, indexFileId: indexFile.id,
          syncedUpdatedAt: record.updatedAt, syncedAt: now(), error: null,
        });
        summary.readBack += 1;
      } else {
        await store.setSyncMeta(collection, record.id, { ...meta, docModifiedTime: file.modifiedTime });
      }
    }
  }

  // ---------- one run ----------

  let rootPromise = null;

  async function run() {
    summary = { pushed: 0, pulled: 0, readBack: 0, trashed: 0, created: 0, errors: [] };
    pushedThisRun.clear();

    const google = (await store.getSetting('google', {})) || {};
    if (!google.connected) return { ...summary, skipped: 'not-connected' };

    await store.updateSetting('google', { status: 'syncing' });

    try {
      rootPromise = ensureRoot();
      await rootPromise;
      await pull();
      await readBack();

      for (const collection of PUSH_ORDER) {
        for (const record of await store.list(collection, { includeDeleted: true })) {
          try {
            await pushRecord(collection, record);
          } catch (error) {
            if (error instanceof NeedsReconnectError) throw error;
            summary.errors.push({ collection, id: record.id, message: error.message });
            await store.setSyncMeta(collection, record.id, {
              ...((await store.getSyncMeta(collection, record.id)) || {}),
              error: error.message,
            });
          }
        }
      }

      await store.updateSetting('google', {
        status: summary.errors.length ? 'error' : 'idle',
        lastSyncAt: now(),
        lastError: summary.errors.length
          ? `${summary.errors.length} item${summary.errors.length === 1 ? '' : 's'} didn't sync: ${summary.errors[0].message}`
          : null,
      });
    } catch (error) {
      const reconnect = error instanceof NeedsReconnectError;
      await store.updateSetting('google', {
        status: reconnect ? 'reconnect' : 'error',
        lastError: reconnect ? 'Google needs you to reconnect.' : error.message,
      });
      summary.errors.push({ message: error.message, fatal: true });
    }

    return summary;
  }

  return { run };
}
