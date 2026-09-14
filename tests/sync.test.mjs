// The Google Docs sync engine against a simulated Drive.
import { installFakeChrome, makeChecker } from './fake-chrome.mjs';
import { createFakeDrive } from './fake-drive.mjs';
import { EXTENSION } from './paths.mjs';

const fake = installFakeChrome();
const store = await import(new URL('shared/store.js', EXTENSION));
const model = await import(new URL('shared/model.js', EXTENSION));
const { createDrive } = await import(new URL('shared/drive.js', EXTENSION));
const { createSyncEngine } = await import(new URL('shared/sync.js', EXTENSION));
const { NeedsReconnectError } = await import(new URL('shared/google-auth.js', EXTENSION));
const studioModel = await import(new URL('studio/lib/model.js', EXTENSION));
const { eq, done } = makeChecker();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const driveFake = createFakeDrive();
const client = createDrive({ fetchImpl: driveFake.fetchImpl, auth: driveFake.auth() });
const engine = () =>
  createSyncEngine({
    drive: client,
    productionContext: (production) => ({
      assembleShot: (scene) => scene.blocks.map((b) => b.text).filter(Boolean).join(' / '),
      targetLabel: 'Sora',
      profileLabel: 'General shot',
    }),
    blobSource: bytes,
  });

// Stands in for the IndexedDB byte store the extension uses.
const bytes = {
  held: new Map(),
  async getBlob(id) {
    return this.held.get(id) || null;
  },
};
const docText = (id) => driveFake.files.get(id).content;

// ---------- seed one project's worth of work ----------
await store.setSetting('google', { connected: true });
const project = await store.put('projects', { ...model.newProject('Apex'), id: 'prj-apex' });
const prompt = await store.put('prompts', model.newPrompt({
  projectId: project.id, title: 'Kickoff brief', tags: ['launch'],
  blocks: [{ id: 'b1', type: 'scenario', text: 'A launch week.' }, { id: 'b2', type: 'ask', text: 'Draft three hooks.' }],
}));
const reply = await store.put('replies', model.newReply({
  projectId: project.id, title: 'Hooks from ChatGPT', text: 'One. Two. Three.',
  source: { platform: 'ChatGPT', tabLabel: 'Writer', url: 'https://chatgpt.com/c/1' },
}));
const production = studioModel.newProduction({ projectId: project.id, name: 'Opening' });
production.scenes[0].blocks[0].text = 'Hangar at dawn';
await store.put('productions', production);
const script = await store.put('documents', model.newDocument({
  projectId: project.id, productionId: production.id, box: 'inbox', kind: 'script', title: 'Page 12', text: 'INT. HANGAR - DAWN',
}));
const report = await store.put('documents', model.newDocument({
  projectId: project.id, productionId: production.id, box: 'outbox', kind: 'report', title: 'Dailies — day one', text: '# Day one',
}));
await store.put('assets', studioModel.newAsset({ projectId: project.id, name: 'Hangar still', category: 'location' }));

console.log('--- first sync builds the folder tree and the Docs ---');
{
  const summary = await engine().run();
  eq([summary.pushed, summary.errors.length], [7, 0], 'all seven records pushed, no errors');

  const [root] = driveFake.byName('Edge Studio');
  const [apex] = driveFake.byName('Apex');
  eq([!!root, apex.parents[0] === root.id], [true, true], 'Edge Studio/Apex');
  eq(driveFake.childrenOf(apex.id).map((f) => f.name).sort(), ['Assets', 'Productions', 'Prompts', 'Replies'], 'project holds Prompts, Replies, Productions, Assets');

  const [promptsFolder] = driveFake.childrenOf(apex.id).filter((f) => f.name === 'Prompts');
  const [promptDoc] = driveFake.childrenOf(promptsFolder.id);
  eq([promptDoc.name, promptDoc.mimeType], ['Kickoff brief', 'application/vnd.google-apps.document'], 'the prompt is a Google Doc in Prompts');
  eq([promptDoc.content.includes('[Scenario]\nA launch week.'), promptDoc.content.includes('[Ask]\nDraft three hooks.')], [true, true],
    'its blocks read as [Heading] sections');
  eq(promptDoc.description.includes('Tags: launch'), true, 'tags go into the Drive description, so Drive search finds them');

  const [productionsFolder] = driveFake.childrenOf(apex.id).filter((f) => f.name === 'Productions');
  const [opening] = driveFake.childrenOf(productionsFolder.id);
  eq(driveFake.childrenOf(opening.id).map((f) => f.name).sort(), ['In-box', 'Opening — shot list', 'Out-box'],
    'a production folder holds its shot list, In-box and Out-box');
  const inbox = driveFake.childrenOf(opening.id).find((f) => f.name === 'In-box');
  const outbox = driveFake.childrenOf(opening.id).find((f) => f.name === 'Out-box');
  eq([driveFake.childrenOf(inbox.id).map((f) => f.name), driveFake.childrenOf(outbox.id).map((f) => f.name)],
    [['Page 12'], ['Dailies — day one']], 'the script lands in In-box, the report in Out-box');
  eq(docText(driveFake.childrenOf(inbox.id)[0].id), 'INT. HANGAR - DAWN', 'a script Doc is just the script — no header');
  eq(driveFake.appDataFiles().length, 7, 'one hidden index file per record, including the asset');

  const meta = await store.getSyncMeta('prompts', prompt.id);
  eq([meta.docId === promptDoc.id, meta.syncedUpdatedAt === prompt.updatedAt, !!meta.indexFileId], [true, true, true],
    'sync bookkeeping recorded for the record');
  eq((await store.getSetting('google')).status, 'idle', 'status back to idle');
}

console.log('\n--- a sync with nothing to do writes nothing ---');
{
  const mark = driveFake.requests.length;
  const summary = await engine().run();
  eq([summary.pushed, summary.pulled, summary.readBack], [0, 0, 0], 'nothing pushed, pulled or read back');
  eq(driveFake.mutations(mark).length, 0, 'no create/update/trash requests at all');
}

console.log('\n--- a local edit updates the same Doc ---');
{
  const before = (await store.getSyncMeta('prompts', prompt.id)).docId;
  await sleep(5);
  prompt.blocks[1].text = 'Draft five hooks.';
  await store.put('prompts', prompt);
  const docsBefore = driveFake.files.size;
  await engine().run();
  const meta = await store.getSyncMeta('prompts', prompt.id);
  eq([meta.docId === before, driveFake.files.size === docsBefore], [true, true], 'same Doc id, no new file');
  eq(docText(before).includes('[Ask]\nDraft five hooks.'), true, 'the Doc has the new text');
}

console.log('\n--- an edit made in Google Docs is read back ---');
{
  const meta = await store.getSyncMeta('replies', reply.id);
  await sleep(5);
  driveFake.editDoc(meta.docId, docText(meta.docId).replace('One. Two. Three.', 'One. Two. Three. Four (added in Docs).'));
  const mark = driveFake.requests.length;
  const summary = await engine().run();
  eq(summary.readBack, 1, 'one Doc read back');
  eq((await store.get('replies', reply.id)).text, 'One. Two. Three. Four (added in Docs).', "the reply's text now matches the Doc");
  const rewroteDoc = driveFake.mutations(mark).some((r) => r.path.endsWith(`/files/${meta.docId}`));
  eq(rewroteDoc, false, "the Doc isn't re-uploaded after being read (which would loop)");
  const again = await engine().run();
  eq([again.readBack, again.pushed], [0, 0], 'and the next sync is quiet');
}

console.log('\n--- prompts: editing blocks in Docs ---');
{
  const meta = await store.getSyncMeta('prompts', prompt.id);
  await sleep(5);
  const edited = docText(meta.docId)
    .replace('A launch week.', 'A launch week, rewritten in Docs.')
    .replace('[Ask]\nDraft five hooks.', '[Ask]\nDraft five hooks.\n\n[Format]\nA numbered list.');
  driveFake.editDoc(meta.docId, edited, 'Kickoff brief v2');
  await engine().run();
  const stored = await store.get('prompts', prompt.id);
  eq(stored.blocks.map((b) => [b.type, b.text]),
    [['scenario', 'A launch week, rewritten in Docs.'], ['ask', 'Draft five hooks.'], ['format', 'A numbered list.']],
    'edited text and a new [Format] heading become blocks');
  eq([stored.blocks[0].id, stored.title], ['b1', 'Kickoff brief v2'], 'existing block ids kept; renaming the Doc renames the prompt');

  await sleep(5);
  driveFake.editDoc(meta.docId, 'someone deleted every heading');
  await engine().run();
  eq((await store.get('prompts', prompt.id)).blocks.length, 3, 'a Doc with no headings left does not wipe the blocks');
}

console.log('\n--- both sides edited: the later edit wins ---');
{
  const r = await store.get('replies', reply.id);
  const meta = await store.getSyncMeta('replies', reply.id);
  driveFake.editDoc(meta.docId, docText(meta.docId).replace(/Four.*$/, 'edited in Docs first'));
  await sleep(10);
  r.text = 'edited in Edge Studio later';
  await store.put('replies', r);
  await engine().run();
  eq([(await store.get('replies', reply.id)).text, docText(meta.docId).endsWith('edited in Edge Studio later')], [
    'edited in Edge Studio later', true,
  ], 'the local edit was later, so it wins and rewrites the Doc');
}

console.log('\n--- renaming and deleting ---');
{
  project.name = 'Apex Launch';
  await store.put('projects', project);
  await engine().run();
  eq([driveFake.byName('Apex').length, driveFake.byName('Apex Launch').length], [0, 1], 'renaming a project renames its folder (no second folder)');

  const meta = await store.getSyncMeta('documents', report.id);
  await store.remove('documents', report.id);
  eq(!!(await store.getIncludingDeleted('documents', report.id)).deletedAt, true, 'deleting while connected leaves a tombstone');
  const summary = await engine().run();
  eq([driveFake.files.get(meta.docId).trashed, summary.trashed], [true, 1], 'the Doc goes to Drive trash — recoverable, not destroyed');
  eq(await store.getIncludingDeleted('documents', report.id), null, 'and the tombstone is cleared locally');
  const index = driveFake.files.get(meta.indexFileId);
  eq(index.appProperties.edgeStudioDeleted, '1', 'the index records the deletion for other machines');
}

console.log('\n--- a Doc trashed by hand in Drive comes back ---');
{
  const meta = await store.getSyncMeta('replies', reply.id);
  driveFake.trashExternally(meta.docId);
  const r = await store.get('replies', reply.id);
  r.text = 'still here';
  await store.put('replies', r);
  await engine().run();
  const next = await store.getSyncMeta('replies', reply.id);
  eq([next.docId !== meta.docId, !!driveFake.files.get(next.docId).trashed, docText(next.docId).endsWith('still here')],
    [true, false, true], 'the record still exists, so its Doc is recreated rather than the reply being lost');
}

console.log('\n--- a second machine catches up without duplicating anything ---');
{
  // Everything on "machine A" so far. Now machine B: empty local storage,
  // same Google account and Drive.
  const machineA = fake.raw();
  fake.areas.local.clear();
  await store.setSetting('google', { connected: true });

  const summary = await engine().run();
  eq(summary.pulled >= 6, true, `records pulled from Drive (${summary.pulled})`);
  eq((await store.get('prompts', prompt.id)).blocks.map((b) => b.type), ['scenario', 'ask', 'format'], 'the prompt arrives with its blocks');
  eq((await store.get('productions', production.id)).scenes[0].blocks[0].text, 'Hangar at dawn', 'the production arrives with its scenes');
  eq(await store.get('documents', report.id), null, "the deleted report doesn't come back");
  eq((await store.getSyncMeta('prompts', prompt.id)).docId, machineA[`es:sync:prompts:${prompt.id}`].docId,
    'it knows which Doc is the prompt, from the index');

  const filesBefore = driveFake.files.size;
  const second = await engine().run();
  eq([second.pushed, driveFake.files.size === filesBefore, driveFake.byName('Edge Studio').length], [0, true, 1],
    'no duplicate folders or Docs, and only one Edge Studio folder');

  // Machine B edits; machine A's view of Drive picks it up.
  const p = await store.get('prompts', prompt.id);
  p.tags = ['launch', 'from-b'];
  await store.put('prompts', p);
  await engine().run();
  const machineB = fake.raw();
  fake.areas.local.clear();
  Object.entries(machineA).forEach(([k, v]) => fake.areas.local.set(k, v));
  const back = await engine().run();
  eq([(await store.get('prompts', prompt.id)).tags, back.pulled >= 1], [['launch', 'from-b'], true], "machine A pulls machine B's edit");
  Object.keys(machineB); // keep reference for readability
}

console.log('\n--- asset files ---');
{
  // An asset imported on this machine: the record keeps a reference, the
  // bytes sit in the byte store under a blob id.
  const clip = await store.put('assets', studioModel.newAsset({
    projectId: project.id,
    name: 'Hangar plate',
    category: 'location',
    fileRef: { name: 'hangar.jpg', size: 9, type: 'image/jpeg', kind: 'image', blobId: 'blob-1', stored: true },
  }));
  bytes.held.set('blob-1', new Blob(['JPEGBYTES']));

  await engine().run();

  // By this point earlier sections have renamed the project, so find its
  // folder through the sync bookkeeping rather than by name.
  const projectMeta = await store.getSyncMeta('projects', project.id);
  const [assetsFolder] = driveFake.childrenOf(projectMeta.folderId).filter((f) => f.name === 'Assets');
  const uploaded = driveFake.childrenOf(assetsFolder.id);
  eq(uploaded.map((f) => [f.name, f.mimeType]), [['hangar.jpg', 'image/jpeg']], 'the file goes up under its own name and type');
  eq(uploaded[0].content, 'JPEGBYTES', 'the bytes arrive intact');
  eq(uploaded[0].appProperties.edgeStudioBlobId, 'blob-1', 'the file is tagged with the blob it came from');

  const meta = await store.getSyncMeta('assets', clip.id);
  eq([meta.fileId === uploaded[0].id, meta.fileBlobId, meta.fileName], [true, 'blob-1', 'hangar.jpg'], 'sync meta remembers the upload, not the record');
  eq('fileId' in clip, false, 'nothing about Drive is written onto the record');

  // Editing the description must not re-send the bytes.
  const before = driveFake.requests.length;
  clip.description = 'Wide, low sun';
  await store.put('assets', clip);
  await engine().run();
  const mutations = driveFake.mutations(before);
  // A new upload is a POST to the upload endpoint; rewriting the index
  // is a PATCH to the existing one. Only the second should happen.
  eq(mutations.filter((r) => r.method === 'POST' && r.path === '/upload/drive/v3/files').length, 0,
    'the bytes are not uploaded again');
  eq(mutations.some((r) => r.method === 'PATCH' && r.path.startsWith('/upload/drive/v3/files/')), true,
    'but the index is rewritten with the new description');
  eq(driveFake.childrenOf(assetsFolder.id).length, 1, 'and no second copy appears in Assets');

  // Renaming the underlying file renames it in Drive in place.
  clip.fileRef = { ...clip.fileRef, name: 'hangar-plate.jpg' };
  await store.put('assets', clip);
  await engine().run();
  eq(driveFake.childrenOf(assetsFolder.id).map((f) => f.name), ['hangar-plate.jpg'], 'a rename moves the existing file, not a new one');

  // Replacing the bytes uploads the new file and trashes the old.
  clip.fileRef = { ...clip.fileRef, blobId: 'blob-2', name: 'hangar-v2.jpg' };
  bytes.held.set('blob-2', new Blob(['NEWBYTES']));
  await store.put('assets', clip);
  await engine().run();
  const live = driveFake.childrenOf(assetsFolder.id).filter((f) => !f.trashed);
  eq(live.map((f) => f.content), ['NEWBYTES'], 'the replacement is what is left in Assets');
  eq(driveFake.childrenOf(assetsFolder.id).filter((f) => f.trashed).length, 1, 'the old version is trashed, not deleted');

  // A reference-only asset — too big to hold, or imported on another
  // machine — has nothing to upload and must not fail the run.
  const huge = await store.put('assets', studioModel.newAsset({
    projectId: project.id,
    name: 'Master cut',
    fileRef: { name: 'master.mov', size: 900e6, type: 'video/quicktime', kind: 'video', blobId: 'blob-missing', stored: false },
  }));
  const summary = await engine().run();
  eq(summary.errors.length, 0, 'an asset whose bytes are not here syncs without error');
  eq((await store.getSyncMeta('assets', huge.id)).fileId, null, 'and no file is invented for it');
  eq(driveFake.childrenOf(assetsFolder.id).filter((f) => !f.trashed).length, 1, 'Assets holds only what was actually uploaded');

  // Deleting takes the Drive file with it.
  await store.remove('assets', clip.id);
  await engine().run();
  eq(driveFake.files.get(live[0].id).trashed, true, 'deleting the asset trashes its file');
}

console.log('\n--- auth failures ---');
{
  driveFake.reject401Once();
  const p = await store.get('prompts', prompt.id);
  p.status = 'In Review';
  await store.put('prompts', p);
  const summary = await engine().run();
  eq([summary.errors.length, (await store.getSyncMeta('prompts', prompt.id)).syncedUpdatedAt === p.updatedAt], [0, true],
    'a single rejected token is renewed and the request retried');

  const dead = createSyncEngine({
    drive: createDrive({
      fetchImpl: driveFake.fetchImpl,
      auth: { getAccessToken: async () => { throw new NeedsReconnectError(); }, invalidateToken: async () => {} },
    }),
  });
  await dead.run();
  eq((await store.getSetting('google')).status, 'reconnect', 'when Google needs a click-through, status says reconnect');

  await store.updateSetting('google', { connected: false });
  eq((await engine().run()).skipped, 'not-connected', 'nothing happens while disconnected');
}

done();
