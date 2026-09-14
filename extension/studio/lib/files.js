// Reading picked, dropped and downloaded files.
//
// What's kept depends on what the file is for. An asset's *record* keeps
// only a reference — name, size, type and a small thumbnail — because
// that's all the grid, the prompt and Drive sync ever need. The bytes go
// to shared/blobs.js, and only because attaching a file to a chat tab
// needs the real thing. Over MAX_STORED_BYTES the bytes are skipped and
// the asset stays reference-only, which the tile says plainly.
//
// Text files are different: a script's whole point is its text, so that
// is read into the record and the bytes aren't kept twice.

import { blobs, isTooLarge, newBlobId } from '../../shared/blobs.js';

const THUMB_MAX = 320;
// How far into a clip to look for a poster frame. Frame zero is often
// black, and a black tile tells you nothing about which clip it is.
const POSTER_SEEK_RATIO = 0.25;
const POSTER_SEEK_MAX_S = 2;

const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'fountain', 'json', 'csv', 'rtf', 'srt', 'vtt', 'fdx'];
const SCRIPT_EXTENSIONS = ['fountain', 'fdx', 'srt', 'vtt'];
const DOC_EXTENSIONS = ['pdf', 'doc', 'docx', 'odt', 'pages', 'rtf', 'ppt', 'pptx', 'xls', 'xlsx'];

// What a file is, in the terms the pipeline thinks in. `kind` drives the
// tile, the category a new asset lands in, and whether a thumbnail is
// worth attempting.
export const FILE_KINDS = {
  image: { label: 'Image', category: 'other' },
  video: { label: 'Video', category: 'other' },
  audio: { label: 'Audio', category: 'audio' },
  script: { label: 'Script', category: 'script' },
  document: { label: 'Document', category: 'script' },
  text: { label: 'Text', category: 'script' },
  other: { label: 'File', category: 'other' },
};

function extensionOf(name) {
  const parts = String(name || '').split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

export function fileKind({ name = '', type = '' } = {}) {
  const ext = extensionOf(name);
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (SCRIPT_EXTENSIONS.includes(ext)) return 'script';
  if (type === 'application/pdf' || DOC_EXTENSIONS.includes(ext)) return 'document';
  if (type.startsWith('text/') || type === 'application/json' || TEXT_EXTENSIONS.includes(ext)) return 'text';
  return 'other';
}

export function isImage(file) {
  return fileKind(file) === 'image';
}

// Text that belongs in the record rather than in the byte store: a
// script or note whose content is the point. A PDF is a document, not
// text — its bytes are what matter.
export function isReadableText(file) {
  const kind = fileKind(file);
  return kind === 'text' || (kind === 'script' && extensionOf(file.name) !== 'fdx');
}

export function baseName(name) {
  return String(name || '').replace(/\.[^.]+$/, '') || 'Untitled';
}

// The reference kept on the asset record. `stored` and `blobId` are
// filled in by storeBytes; `tooLarge` is why they sometimes aren't.
export function fileRef(file, extra = {}) {
  return {
    name: file.name,
    size: file.size,
    type: file.type || '',
    kind: fileKind(file),
    blobId: null,
    stored: false,
    tooLarge: isTooLarge(file.size),
    driveFileId: null,
    driveUrl: null,
    ...extra,
  };
}

export function readText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---------- thumbnails ----------

export function shrinkDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(drawToThumb(img, img.width, img.height, dataUrl));
    img.onerror = () => resolve(null);
    img.crossOrigin = 'anonymous';
    img.src = dataUrl;
  });
}

function drawToThumb(source, width, height, fallback = null) {
  const scale = Math.min(1, THUMB_MAX / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  try {
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    // A cross-origin image taints the canvas; the URL still works as a
    // thumbnail even when its pixels can't be read back.
    return fallback;
  }
}

// A still from the clip itself, so the grid shows which video it is
// rather than a generic film icon. Resolves to null if the browser
// can't decode the format — an honest blank beats a broken tile.
export function makeVideoPoster(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(value);
    };

    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      const seekTo = Math.min(video.duration * POSTER_SEEK_RATIO, POSTER_SEEK_MAX_S);
      // A zero-length or still-unknown duration can't be seeked; take
      // whatever the first frame turns out to be instead.
      if (!Number.isFinite(seekTo) || seekTo <= 0) video.currentTime = 0;
      else video.currentTime = seekTo;
    };
    video.onseeked = () => finish(drawToThumb(video, video.videoWidth, video.videoHeight));
    video.onerror = () => finish(null);
    // Some containers never fire seeked; don't leave the import hanging.
    setTimeout(() => finish(null), 5000);

    video.src = url;
  });
}

export async function makeThumbnail(file) {
  const kind = fileKind(file);
  if (kind === 'image') return shrinkDataUrl(await readDataUrl(file));
  if (kind === 'video') return makeVideoPoster(file);
  return null;
}

// ---------- bytes ----------

// Puts a file's bytes in the byte store and returns the reference to
// keep on the asset. Over the limit, or if IndexedDB refuses, the
// reference comes back unstored rather than the import failing: a
// reference-only asset still describes itself in a prompt, it just
// can't be attached.
export async function storeBytes(file, { blobId = newBlobId() } = {}) {
  const ref = fileRef(file);
  if (ref.tooLarge) return ref;

  try {
    await blobs.put(blobId, file, { name: file.name, type: file.type });
    return { ...ref, blobId, stored: true };
  } catch (error) {
    console.error('[Edge Studio] Could not store file bytes:', error);
    return { ...ref, storeError: error.message };
  }
}

// ---------- writing out ----------

function saveAs(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoked on the next tick so the click has taken the URL first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Writes a file out of the extension page — the out-box's "Download"
// (M4-16). Extension pages can do this without the downloads
// permission because it's an ordinary anchor click.
export function downloadText(filename, text, type = 'text/markdown') {
  saveAs(new Blob([text], { type }), filename);
}

export function downloadBlob(filename, blob) {
  saveAs(blob, filename);
}
