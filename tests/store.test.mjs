// The record store, projects and migration — the data layer every page
// sits on.
import { installFakeChrome, makeChecker } from './fake-chrome.mjs';
import { EXTENSION } from './paths.mjs';

const fake = installFakeChrome();
const store = await import(new URL('shared/store.js', EXTENSION));
const projects = await import(new URL('shared/projects.js', EXTENSION));
const migration = await import(new URL('shared/migrate.js', EXTENSION));
const model = await import(new URL('shared/model.js', EXTENSION));
const { eq, done } = makeChecker();

const reset = () => {
  fake.areas.local.clear();
  fake.areas.session.clear();
};

console.log('--- records ---');
{
  reset();
  const a = await store.put('prompts', model.newPrompt({ projectId: 'p1', title: 'One' }));
  eq(typeof a.createdAt === 'string' && a.createdAt === a.updatedAt, true, 'put stamps createdAt/updatedAt');
  const b = await store.put('prompts', model.newPrompt({ projectId: 'p2', title: 'Two' }));
  eq((await store.list('prompts')).length, 2, 'list returns every record');
  eq((await store.list('prompts', { projectId: 'p1' })).map((r) => r.title), ['One'], 'list narrows by project');
  eq(Object.keys(fake.raw()).sort(), [`es:prompts:${a.id}`, `es:prompts:${b.id}`].sort(), 'one storage key per record');

  a.title = 'One (edited)';
  const returned = await store.put('prompts', a);
  eq(returned === a, true, 'put updates and returns the same live object');
  eq((await store.get('prompts', a.id)).title, 'One (edited)', 'get reads the saved record');
}

console.log('\n--- two pages cannot clobber each other ---');
{
  reset();
  // Page A and page B each load the same two records into memory…
  await store.put('prompts', { id: 'x', projectId: 'p', title: 'X' });
  await store.put('prompts', { id: 'y', projectId: 'p', title: 'Y' });
  const pageA = await store.list('prompts');
  const pageB = await store.list('prompts');
  // …and each edits a different one from its stale copy.
  const ax = pageA.find((r) => r.id === 'x'); ax.title = 'X by A';
  const by = pageB.find((r) => r.id === 'y'); by.title = 'Y by B';
  await store.put('prompts', ax);
  await store.put('prompts', by);
  eq((await store.list('prompts')).map((r) => r.title).sort(), ['X by A', 'Y by B'],
    'both edits survive (the old one-array-per-list layout lost one)');
}

console.log('\n--- deleting ---');
{
  reset();
  const r = await store.put('replies', model.newReply({ projectId: 'p', title: 'R', text: 't' }));
  await store.remove('replies', r.id);
  eq(fake.raw()[`es:replies:${r.id}`], undefined, 'without Google, delete removes the record outright');

  await store.setSetting('google', { connected: true });
  const s = await store.put('replies', model.newReply({ projectId: 'p', title: 'S', text: 't' }));
  await store.remove('replies', s.id);
  eq(typeof fake.raw()[`es:replies:${s.id}`].deletedAt, 'string', 'with Google, delete leaves a tombstone for sync');
  eq(await store.get('replies', s.id), null, 'get hides tombstones');
  eq((await store.list('replies')).length, 0, 'list hides tombstones');
  eq((await store.list('replies', { includeDeleted: true })).length, 1, '…unless asked');
  await store.purge('replies', s.id);
  eq(fake.raw()[`es:replies:${s.id}`], undefined, 'purge removes the tombstone');
}

console.log('\n--- change notifications ---');
{
  reset();
  const events = [];
  const stop = store.subscribe((e) => events.push(...e));
  const rec = await store.put('prompts', { id: 'n1', projectId: 'p', title: 'N' });
  eq([events.at(-1).collection, events.at(-1).id, events.at(-1).self], ['prompts', 'n1', true], 'own write is marked self');

  // Simulate another page writing the same key directly.
  await chrome.storage.local.set({ 'es:prompts:n1': { ...rec, title: 'from elsewhere', updatedAt: '2099-01-01T00:00:00.000Z' } });
  eq([events.at(-1).record.title, events.at(-1).self], ['from elsewhere', false], "another context's write is not self");

  await store.setSetting('app', { activeProjectId: 'p' });
  eq([events.at(-1).kind, events.at(-1).name, events.at(-1).self], ['setting', 'app', true], 'settings changes are reported');

  await store.setSyncMeta('prompts', 'n1', { docId: 'abc' });
  eq(events.at(-1).kind, 'setting', 'sync bookkeeping writes are not reported to pages');
  stop();
}

console.log('\n--- settings ---');
{
  reset();
  await store.setSetting('app', { activeProjectId: 'a', blockTypes: [1] });
  await store.updateSetting('app', { activeProjectId: 'b' });
  eq(await store.getSetting('app'), { activeProjectId: 'b', blockTypes: [1] }, 'updateSetting changes one field, keeps the rest');
  eq(await store.getSetting('missing', 'fallback'), 'fallback', 'getSetting fallback');
}

console.log('\n--- projects ---');
{
  reset();
  const first = await projects.ensureActiveProject();
  eq([first.id, first.name], ['prj-first', 'My first project'], 'fresh install gets one project, with the fixed first id');
  const again = await projects.ensureActiveProject();
  eq([again.id, (await projects.listProjects()).length], ['prj-first', 1], 'calling again does not create a second');

  // Two pages starting at the same moment on a fresh install.
  reset();
  const [p1, p2] = await Promise.all([projects.ensureActiveProject(), projects.ensureActiveProject()]);
  eq([p1.id === p2.id, (await projects.listProjects()).length], [true, 1], 'concurrent first runs converge on one project');

  const apex = await projects.createProject('Apex');
  eq((await store.getSetting('app')).activeProjectId, apex.id, 'creating a project makes it active');
  eq((await projects.listProjects()).map((p) => p.name), ['Apex', 'My first project'], 'projects list alphabetically');

  await store.put('prompts', model.newPrompt({ projectId: apex.id, title: 'in apex' }));
  await store.put('replies', model.newReply({ projectId: apex.id, title: 'in apex', text: '' }));
  eq((await projects.projectContents(apex.id)).prompts, 1, 'projectContents counts what a delete would take');
  const fallback = await projects.deleteProject(apex.id);
  eq([(await store.list('prompts')).length, (await store.list('replies')).length, fallback.id], [0, 0, 'prj-first'],
    'deleting a project takes its records and falls back to another project');
}

console.log('\n--- migration ---');
const legacy = () => ({
  library: [{ id: 'prompt-1', title: 'Weekly', blocks: [{ id: 'b', type: 'ask', text: 'go' }], status: 'Draft', tags: ['work'], createdAt: '2026-08-01T00:00:00Z' }],
  responses: [{ id: 'response-1', title: 'R', text: 'reply text', status: 'Draft', source: { platform: 'ChatGPT' }, capturedAt: '2026-08-02T00:00:00Z', savedAt: '2026-08-02T00:01:00Z' }],
  blockTypes: [{ id: 'scenario', label: 'Scenario' }, { id: 'guard', label: 'Guard Rails' }],
  variableValues: { client: 'Acme' },
  usage: { services: [{ id: 'chatgpt', used: 1, limit: 40 }] },
  productions: [{
    id: 'prd-1', name: 'Opening', target: 'sora', profile: 'general', scenes: [{ id: 's1', name: 'S1' }], sequences: [],
    assets: [{ id: 'ast-1', name: 'Hangar', category: 'location', addedAt: '2026-08-03T00:00:00Z' }],
    inbox: [{ id: 'in-1', kind: 'script', name: 'page1.txt', text: 'INT. HANGAR', at: '2026-08-04T00:00:00Z' }],
    outbox: [
      { id: 'out-clip', kind: 'clip', renderId: 'r', sceneId: 's1', title: 'ghost', at: '2026-08-05T00:00:00Z' },
      { id: 'out-rep', kind: 'report', title: 'Dailies', body: '# day one', at: '2026-08-06T00:00:00Z' },
    ],
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-06T00:00:00Z',
  }],
  activeProductionId: 'prd-1',
});
{
  reset();
  await chrome.storage.local.set(legacy());
  const result = await migration.migrate();
  eq(result.migrated, true, 'migration runs on legacy data');
  const raw = fake.raw();
  eq(['library', 'responses', 'productions', 'blockTypes', 'usage'].filter((k) => k in raw), [], 'legacy keys are removed');
  eq(Object.keys(raw['es:backup:v1'].data).sort(),
    ['activeProductionId', 'blockTypes', 'library', 'productions', 'responses', 'usage', 'variableValues'],
    'everything that was there is kept in es:backup:v1');

  eq((await store.list('prompts', { projectId: 'prj-first' })).map((p) => [p.id, p.title, p.tags]), [['prompt-1', 'Weekly', ['work']]],
    'prompts land in the first project with ids and tags kept');
  eq((await store.list('replies')).map((r) => [r.id, r.projectId]), [['response-1', 'prj-first']], 'responses become replies');
  const prod = await store.get('productions', 'prd-1');
  eq(['assets' in prod, 'inbox' in prod, 'outbox' in prod, prod.projectId, prod.scenes.length], [false, false, false, 'prj-first', 1],
    'productions keep their scenes but no longer carry assets or boxes');
  eq((await store.list('assets')).map((a) => [a.id, a.projectId, a.createdAt]), [['ast-1', 'prj-first', '2026-08-03T00:00:00Z']],
    'assets move up to the project, keeping when they were added');
  const docs = await store.list('documents');
  eq(docs.map((d) => [d.id, d.box, d.kind]).sort(), [['in-1', 'inbox', 'script'], ['out-rep', 'outbox', 'report']],
    'in-box script and filed report become documents; the ghost clip entry does not');
  const app = await store.getSetting('app');
  eq([app.schemaVersion, app.activeProjectId, app.activeProductionId, app.blockTypes.length], [2, 'prj-first', 'prd-1', 2],
    'settings carried: active project/production and custom block types');
  eq([(await store.getSetting('variables')).values.client, (await store.getSetting('usage')).services[0].limit], ['Acme', 40],
    'remembered variables and usage figures carried');
  eq((await migration.migrate()).migrated, false, 'a second run is a no-op');
}
{
  // Two contexts racing: one finishes and the user edits, then the other writes.
  reset();
  await chrome.storage.local.set(legacy());
  const planned = migration.planMigration(legacy());
  const editedKey = 'es:prompts:prompt-1';
  await chrome.storage.local.set({ [editedKey]: { ...planned.records[editedKey], title: 'Edited after migration' } });
  await migration.migrate();
  eq((await store.get('prompts', 'prompt-1')).title, 'Edited after migration', 'migration never overwrites a record that already exists');
}
{
  reset();
  eq((await migration.migrate()).migrated, false, 'fresh install: nothing to migrate');
  eq((await store.getSetting('app')).schemaVersion, 2, '…but the schema version is recorded');
}

console.log('\n--- model ---');
eq(model.parseTags('Apex, work, APEX,, '), ['apex', 'work'], 'tags lowercase and deduplicated');
eq(model.newDocument({ projectId: 'p', box: 'nonsense', kind: 'nope', title: '' }).box, 'inbox', 'unknown box falls back to inbox');

done();
