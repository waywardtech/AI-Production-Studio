// File intake: what a file is, where its bytes go, and the size limit
// that decides whether it can ever be attached to a chat.
//
// files.js needs a DOM for thumbnails, so only its pure half is
// exercised here; the byte store is driven through an injected backend
// rather than a fake IndexedDB, because what's worth testing is the
// policy around the bytes, not IndexedDB itself.
import { makeChecker } from './fake-chrome.mjs';
import { EXTENSION } from './paths.mjs';

const { eq, done } = makeChecker();

// A Blob stand-in good enough for the store: it only ever reads .size,
// .type and .name, and hands the object straight back.
const fakeFile = (name, type, size) => ({ name, type, size });

const blobsModule = await import(new URL('shared/blobs.js', EXTENSION));
const { MAX_STORED_BYTES, createBlobStore, formatBytes, isTooLarge, newBlobId } = blobsModule;

function memoryBackend() {
  const map = new Map();
  return {
    async get(id) { return map.get(id) || undefined; },
    async put(record) { map.set(record.id, record); return record; },
    async delete(id) { map.delete(id); },
    async keys() { return [...map.keys()]; },
    async all() { return [...map.values()]; },
    map,
  };
}

console.log('--- size limit ---');
{
  eq(isTooLarge(MAX_STORED_BYTES - 1), false, 'just under the limit is storable');
  eq(isTooLarge(MAX_STORED_BYTES), false, 'exactly at the limit is storable');
  eq(isTooLarge(MAX_STORED_BYTES + 1), true, 'a byte over the limit is not');
  eq(formatBytes(512), '512 B', 'bytes');
  eq(formatBytes(2048), '2 KB', 'kilobytes');
  eq(formatBytes(5 * 1024 * 1024), '5.0 MB', 'megabytes');
  eq(formatBytes(3 * 1024 * 1024 * 1024), '3.00 GB', 'gigabytes');
}

console.log('--- the byte store ---');
{
  const backend = memoryBackend();
  const store = createBlobStore({ backend });

  const meta = await store.put('b1', fakeFile('still.png', 'image/png', 1234));
  eq(meta, { id: 'b1', name: 'still.png', type: 'image/png', size: 1234, addedAt: meta.addedAt }, 'put returns metadata only');
  eq('blob' in meta, false, 'metadata never carries the bytes');
  eq(await store.has('b1'), true, 'a stored blob is found');
  eq((await store.getBlob('b1')).name, 'still.png', 'the blob itself comes back');

  eq(await store.has('nope'), false, 'an unknown id is not found');
  eq(await store.get(null), null, 'a null id reads as nothing rather than throwing');

  let refused = null;
  try {
    await store.put('big', fakeFile('cut.mov', 'video/quicktime', MAX_STORED_BYTES + 1));
  } catch (error) {
    refused = error.message;
  }
  eq(/over the .* limit/.test(refused || ''), true, 'an oversized file is refused, and says so');
  eq(await store.has('big'), false, 'nothing is written when it is refused');

  await store.put('b2', fakeFile('ref.jpg', 'image/jpeg', 10));
  eq((await store.usage()), { count: 2, bytes: 1244 }, 'usage counts what is held');

  await store.remove('b1');
  eq(await store.has('b1'), false, 'remove drops the bytes');

  await store.put('b3', fakeFile('orphan.png', 'image/png', 5));
  eq(await store.pruneExcept(['b2']), 1, 'prune reports what it dropped');
  eq(await store.keys(), ['b2'], 'prune keeps exactly what was asked for');

  eq(newBlobId() !== newBlobId(), true, 'blob ids are unique');
}

console.log('--- what a file is ---');
{
  // files.js touches `document` at import time only through functions,
  // so importing it in Node is safe as long as nothing DOM-ish is called.
  globalThis.Image = class {};
  const files = await import(new URL('studio/lib/files.js', EXTENSION));

  const kind = (name, type = '') => files.fileKind({ name, type });
  eq(kind('still.png', 'image/png'), 'image', 'an image by mime type');
  eq(kind('plate.HEIC', 'image/heic'), 'image', 'an unusual image is still an image');
  eq(kind('take-3.mp4', 'video/mp4'), 'video', 'a clip');
  eq(kind('room-tone.wav', 'audio/wav'), 'audio', 'audio');
  eq(kind('scene-4.fountain', ''), 'script', 'a screenplay with no mime type');
  eq(kind('subs.srt', ''), 'script', 'subtitles count as a script');
  eq(kind('treatment.pdf', 'application/pdf'), 'document', 'a PDF');
  eq(kind('notes.docx', ''), 'document', 'a Word file by extension');
  eq(kind('notes.md', 'text/markdown'), 'text', 'markdown');
  eq(kind('data.json', 'application/json'), 'text', 'JSON');
  eq(kind('archive.zip', 'application/zip'), 'other', 'anything else');

  eq(files.isImage({ name: 'a.png', type: 'image/png' }), true, 'isImage agrees with fileKind');
  eq(files.isImage({ name: 'a.mp4', type: 'video/mp4' }), false, 'a clip is not an image');

  eq(files.isReadableText({ name: 'scene.fountain', type: '' }), true, 'a fountain script is read as text');
  eq(files.isReadableText({ name: 'script.fdx', type: '' }), false, 'Final Draft is XML in a wrapper — kept as bytes');
  eq(files.isReadableText({ name: 'treatment.pdf', type: 'application/pdf' }), false, 'a PDF is not text');
  eq(files.isReadableText({ name: 'notes.txt', type: 'text/plain' }), true, 'plain text is');

  eq(files.baseName('take-3.final.mp4'), 'take-3.final', 'the extension comes off the name');
  eq(files.baseName('LICENSE'), 'LICENSE', 'a name with no extension survives');
  eq(files.baseName(''), 'Untitled', 'an empty name gets a placeholder');

  const ref = files.fileRef(fakeFile('take-3.mp4', 'video/mp4', 999));
  eq(ref.kind, 'video', 'a reference records the kind');
  eq([ref.stored, ref.blobId, ref.tooLarge], [false, null, false], 'a fresh reference holds no bytes yet');

  const big = files.fileRef(fakeFile('master.mov', 'video/quicktime', MAX_STORED_BYTES + 1));
  eq(big.tooLarge, true, 'an oversized file is marked before anything tries to store it');
}

console.log('--- the attachment transfer ---');
{
  // attach.js talks to chrome.runtime; only its encoding half is pure,
  // and that is the half that would corrupt a file if it were wrong.
  globalThis.btoa = (binary) => Buffer.from(binary, 'binary').toString('base64');
  const attach = await import(new URL('shared/attach.js', EXTENSION));

  const roundTrip = (bytes) => {
    const encoded = attach.bytesToBase64(new Uint8Array(bytes));
    return [...Buffer.from(encoded, 'base64')];
  };

  eq(roundTrip([]), [], 'an empty file encodes to nothing');
  eq(roundTrip([0, 1, 254, 255]), [0, 1, 254, 255], 'byte values survive, including 0 and 255');

  // The encoder walks the array in windows; the bug it guards against
  // only shows up past one window, so check either side of the seam.
  const long = Array.from({ length: 8192 * 2 + 5 }, (_, i) => i % 256);
  eq(roundTrip(long), long, 'a file longer than the encode window survives intact');

  eq(attach.chunkCount(0), 0, 'an empty file needs no chunks');
  eq(attach.chunkCount(1), 1, 'a single byte is one chunk');
  eq(attach.chunkCount(1.5 * 1024 * 1024), 1, 'exactly one chunk stays one');
  eq(attach.chunkCount(1.5 * 1024 * 1024 + 1), 2, 'a byte over spills into a second');
  eq(attach.chunkCount(MAX_STORED_BYTES), 34, 'the largest storable file is ~34 messages, not hundreds');
}

done();
