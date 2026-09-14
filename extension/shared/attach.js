// Handing an asset's file over to a chat or generator tab (M5-4).
//
// The prompt goes into the composer; this puts the files it talks about
// in beside it. Neither is sent — pressing send stays with Dan, the same
// rule the rest of the extension follows.
//
// Bytes cross three boundaries to get there: page → background worker →
// content script, and chrome.runtime messages are JSON, so a Blob can't
// simply be passed along. They go as base64 in chunks small enough that
// no single message is doing something Chrome's messaging was never
// built for. The content script assembles them and only then makes the
// File objects.

import { blobs, formatBytes } from './blobs.js';

// Raw bytes per message. Base64 inflates by a third, so this is around
// 2 MB on the wire — comfortably inside what messaging handles, and few
// enough messages that a 50 MB file is ~34 of them, not hundreds.
const CHUNK_BYTES = 1.5 * 1024 * 1024;
// String.fromCharCode is applied to a window at a time; the whole array
// at once overflows the argument list on a large file.
const ENCODE_WINDOW = 8192;

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += ENCODE_WINDOW) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + ENCODE_WINDOW));
  }
  return btoa(binary);
}

export function chunkCount(size, chunkBytes = CHUNK_BYTES) {
  return Math.ceil(size / chunkBytes) || 0;
}

function relay(type, payload) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

// Which assets can actually be handed over. An asset whose bytes aren't
// on this machine — imported elsewhere, or too big to hold — can't be,
// and the caller shows that rather than failing at the last moment.
export async function attachableFiles(assets) {
  const ready = [];
  const missing = [];

  for (const asset of assets) {
    const ref = asset.fileRef;
    if (!ref || !ref.blobId) continue;
    const blob = await blobs.getBlob(ref.blobId);
    if (blob) ready.push({ asset, name: ref.name || asset.name, type: ref.type || blob.type, blob });
    else missing.push(asset);
  }

  return { ready, missing };
}

// Sends the files to one tab. Resolves to the content script's own
// answer, including which way it got them in, or a failure with a
// reason worth showing.
export async function sendFilesToTab(tabId, files, { onProgress = null } = {}) {
  if (!files.length) return { success: false, reason: 'No files to attach.' };

  const transferId = `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const begin = await relay('EDGE_STUDIO_ATTACH_BEGIN', {
    tabId,
    transferId,
    files: files.map((file) => ({ name: file.name, type: file.type, size: file.blob.size })),
  });
  if (!begin || !begin.success) {
    return { success: false, reason: begin?.reason || 'That tab did not accept the transfer.' };
  }

  const total = files.reduce((sum, file) => sum + file.blob.size, 0);
  let sent = 0;

  for (let index = 0; index < files.length; index += 1) {
    const buffer = new Uint8Array(await files[index].blob.arrayBuffer());
    for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
      const slice = buffer.subarray(offset, offset + CHUNK_BYTES);
      const chunk = await relay('EDGE_STUDIO_ATTACH_CHUNK', {
        tabId,
        transferId,
        index,
        base64: bytesToBase64(slice),
      });
      if (!chunk || !chunk.success) {
        return { success: false, reason: chunk?.reason || `Sending "${files[index].name}" failed part way.` };
      }
      sent += slice.length;
      if (onProgress) onProgress({ sent, total, name: files[index].name });
    }
  }

  const result = await relay('EDGE_STUDIO_ATTACH_COMMIT', { tabId, transferId });
  if (!result || !result.success) {
    return { success: false, reason: result?.reason || 'The page would not take the files.' };
  }
  return { ...result, bytes: total };
}

// A one-line account of what happened, for a toast.
export function describeAttachment(result, { missing = [] } = {}) {
  if (!result.success) return result.reason;
  const how = result.method === 'file-input' ? '' : ` (via ${result.method})`;
  const skipped = missing.length ? ` ${missing.length} couldn't be — not on this machine.` : '';
  return `${result.count} file${result.count === 1 ? '' : 's'}${how} attached, ${formatBytes(result.bytes)}.${skipped}`;
}
