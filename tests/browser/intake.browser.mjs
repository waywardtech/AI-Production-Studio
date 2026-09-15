// Importing files in the studio: what ends up as an asset, what ends up
// in the In-box, where the bytes go, and what happens on delete.
import { launchWithExtension, makeRunner, openPage } from './harness.mjs';
import { writeFixtures } from './fixtures.mjs';

const fixtures = writeFixtures();
const session = await launchWithExtension({ profile: 'intake' });
const run = makeRunner('intake');
const studio = await openPage(session, 'studio/studio.html');

// Reads the byte store the way the extension does, from a page that
// shares its origin.
const storedBlobs = () =>
  studio.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('edge-studio-files');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return new Promise((resolve, reject) => {
      const req = db.transaction('blobs').objectStore('blobs').getAll();
      req.onsuccess = () =>
        resolve(req.result.map((r) => ({ name: r.name, type: r.type, size: r.size, isBlob: r.blob instanceof Blob })));
      req.onerror = () => reject(req.error);
    });
  });

const assetRecords = () =>
  studio.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith('es:assets:'))
      .map(([, record]) => ({ name: record.name, ref: record.fileRef, thumb: record.thumb ? record.thumb.slice(0, 11) : null }));
  });

await run.step('the workspace renders', async () => {
  const scenes = await studio.locator('.scene-item').count();
  if (scenes !== 1) throw new Error(`expected one scene, saw ${scenes}`);
});

await run.step('a mixed batch sorts into assets and In-box scripts', async () => {
  await studio.locator('#asset-file-input').setInputFiles([fixtures.png, fixtures.pdf, fixtures.script]);
  await studio.waitForTimeout(2000);

  const tiles = await studio.locator('.asset-tile').count();
  if (tiles !== 2) throw new Error(`expected the png and pdf as assets, saw ${tiles} tiles`);

  const inbox = await studio.locator('#inbox-count').innerText();
  if (inbox !== '1') throw new Error(`in-box count is ${inbox}`);
  const drawer = await studio.locator('#drawer-body').innerText();
  if (!drawer.includes('scene-4.fountain')) throw new Error('the script is not listed in the In-box');
});

await run.step('each tile says what kind of file it is', async () => {
  const badges = (await studio.locator('.file-badge').allInnerTexts()).map((b) => b.trim().toLowerCase()).sort();
  if (JSON.stringify(badges) !== JSON.stringify(['document', 'image'])) {
    throw new Error(`badges were ${JSON.stringify(badges)}`);
  }
});

await run.step('bytes go to IndexedDB, references stay on the record', async () => {
  const held = await storedBlobs();
  if (held.length !== 2) throw new Error(`expected 2 stored blobs, saw ${held.length}`);
  if (!held.every((h) => h.isBlob && h.size > 0)) throw new Error(`not stored as blobs: ${JSON.stringify(held)}`);

  const records = await assetRecords();
  if (!records.every((r) => r.ref?.stored && r.ref.blobId)) {
    throw new Error(`records are missing byte references: ${JSON.stringify(records)}`);
  }
  if (records.some((r) => JSON.stringify(r.ref).length > 600)) {
    throw new Error('a reference is carrying more than it should');
  }
});

await run.step('the image gets a thumbnail and the PDF does not', async () => {
  const byKind = Object.fromEntries((await assetRecords()).map((r) => [r.ref.kind, r.thumb]));
  if (byKind.image !== 'data:image/') throw new Error(`image thumbnail was ${byKind.image}`);
  if (byKind.document !== null) throw new Error(`the PDF got a thumbnail: ${byKind.document}`);
});

await run.step('deleting an asset takes its bytes with it', async () => {
  await studio.locator('.asset-tile .asset-edit').first().click();
  await studio.waitForTimeout(300);
  await studio.locator('#modal').getByRole('button', { name: 'Delete' }).click();
  await studio.waitForTimeout(400);
  await studio.locator('#modal-confirm-btn').click();
  await studio.waitForTimeout(800);

  const held = await storedBlobs();
  if (held.length !== 1) throw new Error(`expected one blob left, saw ${held.length}`);
});

await run.step('From Drive explains the missing permission', async () => {
  await studio.locator('#asset-drive-btn').click();
  await studio.waitForTimeout(900);
  const body = await studio.locator('#modal-fields').innerText();
  if (!/Turn on Drive browsing in Settings/.test(body)) throw new Error(`the dialog said: ${body.slice(0, 160)}`);
  if (!(await studio.locator('#modal-fields').getByRole('button', { name: 'Open Settings' }).count())) {
    throw new Error('no way through to Settings');
  }
  await studio.locator('#modal-cancel-btn').click();
});

await run.step('settings reports what the byte store holds', async () => {
  const settings = await openPage(session, 'settings/settings.html');
  const usage = await settings.locator('#blob-usage').innerText();
  if (!/1 file · /.test(usage)) throw new Error(`usage read "${usage}"`);
  if (settings.collectedErrors.length) throw new Error(settings.collectedErrors.join(' | '));
});

if (studio.collectedErrors.length) run.fail(`studio logged: ${studio.collectedErrors.join(' | ')}`);

await session.close();
run.finish();
