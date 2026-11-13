// Stall simulation, vector A: a Drive that stops answering.
//
// Before the watchdogs, a request Google never answered left sync
// holding its lock for the life of the service worker, with "Syncing
// now…" on screen and nothing happening. Every case here uses a mock
// that genuinely never settles, and asserts recovery inside a bound —
// a test that merely "doesn't hang" would pass by luck.
import { installFakeChrome, makeChecker } from './fake-chrome.mjs';
import { createFakeDrive } from './fake-drive.mjs';
import { EXTENSION } from './paths.mjs';

const fake = installFakeChrome();
const store = await import(new URL('shared/store.js', EXTENSION));
const model = await import(new URL('shared/model.js', EXTENSION));
const { createDrive } = await import(new URL('shared/drive.js', EXTENSION));
const { createSyncEngine, clearStaleSyncing } = await import(new URL('shared/sync.js', EXTENSION));
const { StallError, createSingleFlight, withDeadline } = await import(new URL('shared/watchdog.js', EXTENSION));
const { eq, done } = makeChecker();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT = 80; // the deadline under test, shrunk from 30 s
const SLACK = 400; // generous: CI machines stall too

// Runs something and reports how it ended and how long it took, with a
// hard ceiling so a regression fails the assertion instead of hanging
// the suite.
async function timed(promise, ceiling = 5000) {
  const started = Date.now();
  const outcome = await Promise.race([
    promise.then((value) => ({ how: 'resolved', value }), (error) => ({ how: 'rejected', error })),
    sleep(ceiling).then(() => ({ how: 'HUNG' })),
  ]);
  return { ...outcome, ms: Date.now() - started };
}

// A fetch that never answers. It only ever ends by being aborted, which
// is how real fetch behaves when its signal fires.
function neverAnswers(log = { calls: 0, aborted: 0 }) {
  const fetchImpl = (href, { signal } = {}) =>
    new Promise((resolve, reject) => {
      log.calls += 1;
      signal?.addEventListener('abort', () => {
        log.aborted += 1;
        reject(signal.reason);
      });
    });
  return { fetchImpl, log };
}

const auth = { getAccessToken: async () => 'token-1', invalidateToken: async () => {} };

console.log('--- withDeadline ---');
{
  eq((await timed(withDeadline(async () => 'fine', { ms: TIMEOUT }))).value, 'fine', 'work that finishes passes straight through');

  const failed = await timed(withDeadline(async () => { throw new Error('its own failure'); }, { ms: TIMEOUT }));
  eq([failed.how, failed.error.message], ['rejected', 'its own failure'], "work's own error is not turned into a stall");

  const thrown = await timed(withDeadline(() => { throw new Error('thrown synchronously'); }, { ms: TIMEOUT }));
  eq(thrown.how, 'rejected', 'a synchronous throw becomes a rejection, not an escape');

  let seenSignal = null;
  const hung = await timed(withDeadline((signal) => { seenSignal = signal; return new Promise(() => {}); }, { ms: TIMEOUT, what: 'The probe' }));
  eq([hung.how, hung.error instanceof StallError, hung.error.code], ['rejected', true, 'stalled'], 'work that never settles is ended with a StallError');
  eq(hung.ms >= TIMEOUT - 5 && hung.ms < TIMEOUT + SLACK, true, `and ended on time (${hung.ms} ms against a ${TIMEOUT} ms deadline)`);
  eq(seenSignal.aborted, true, 'its signal is aborted, so work that honours it actually stops');
  eq(hung.error.message, "The probe didn't finish within 80 ms.", 'the error says what stalled and for how long');
}

console.log('\n--- one Drive request against a server that never answers ---');
{
  const { fetchImpl, log } = neverAnswers();
  const drive = createDrive({ fetchImpl, auth, timeoutMs: TIMEOUT });
  const result = await timed(drive.about());
  eq([result.how, result.error instanceof StallError], ['rejected', true], 'the request ends as a StallError instead of waiting forever');
  eq(result.ms < TIMEOUT + SLACK, true, `within its deadline (${result.ms} ms)`);
  eq([log.calls, log.aborted], [1, 1], 'and the underlying fetch was aborted, not abandoned');

  // The token step is inside the same deadline: a sign-in that never
  // returns is the same stall by another road.
  const stuckAuth = { getAccessToken: () => new Promise(() => {}), invalidateToken: async () => {} };
  const viaAuth = await timed(createDrive({ fetchImpl, auth: stuckAuth, timeoutMs: TIMEOUT }).about());
  eq(viaAuth.error instanceof StallError, true, 'a token renewal that never returns is caught by the same deadline');
}

console.log('\n--- a whole sync against a Drive that is down ---');
const driveFake = createFakeDrive();
let hang = () => false; // (method, path, options) => should this request never answer?
const flaky = (href, options = {}) => {
  const url = new URL(href);
  if (hang(options.method || 'GET', url.pathname, options)) return neverAnswers().fetchImpl(href, options);
  return driveFake.fetchImpl(href, options);
};
// Creating a Google Doc, specifically. The hidden index file goes up
// through the same endpoint, and a test that stalls on "any upload"
// trips on the project's index first — which ends the run for a
// different reason and proves nothing about the records after it.
const isDocCreate = (method, path, options) =>
  method === 'POST' &&
  path === '/upload/drive/v3/files' &&
  typeof options.body === 'string' &&
  options.body.includes('application/vnd.google-apps.document');
const engine = () => createSyncEngine({ drive: createDrive({ fetchImpl: flaky, auth: driveFake.auth(), timeoutMs: TIMEOUT }) });

await store.setSetting('google', { connected: true });
const project = await store.put('projects', { ...model.newProject('Apex'), id: 'prj-apex' });
for (let i = 1; i <= 6; i += 1) {
  await store.put('prompts', model.newPrompt({ projectId: project.id, title: `Prompt ${i}`, blocks: [{ id: 'b', type: 'ask', text: `Ask ${i}` }] }));
}

{
  hang = () => true;
  const result = await timed(engine().run());
  eq(result.how, 'resolved', 'the run ends by itself — it used to hold its lock for the life of the worker');
  eq(result.ms < TIMEOUT + SLACK, true, `in bounded time (${result.ms} ms)`);
  const google = await store.getSetting('google');
  eq(google.status, 'error', 'the stored status is "error", not a "syncing" that never ends');
  eq(/didn't finish within 80 ms/.test(google.lastError) && /Nothing was lost/.test(google.lastError), true,
    'Settings is told what happened and that nothing was lost');
  eq(result.value.errors[0].fatal, true, 'the summary records it as fatal to the run');
}

console.log('\n--- Drive answers reads, then hangs on the first write ---');
{
  // Six prompts are waiting. If a stall were treated as that record's
  // own problem, the run would wait out the deadline six times.
  let stalledWrites = 0;
  hang = (method, path, options) => {
    const stalls = isDocCreate(method, path, options);
    if (stalls) stalledWrites += 1;
    return stalls;
  };
  const result = await timed(engine().run());
  eq(result.how, 'resolved', 'the run ends');
  eq(stalledWrites, 1, 'after exactly one stalled write — it does not go on to try the other five');
  eq(result.ms < TIMEOUT * 2 + SLACK, true, `so it costs one deadline, not six (${result.ms} ms)`);
  eq((await store.getSetting('google')).status, 'error', 'and reports the error');
}

console.log('\n--- Drive comes back ---');
{
  hang = () => false;
  const result = await timed(engine().run());
  eq([result.how, result.value.errors.length], ['resolved', 0], 'the next run completes cleanly');
  eq((await store.getSetting('google')).status, 'idle', 'status returns to idle');
  eq(driveFake.byName('Apex').length, 1, 'one project folder — the interrupted run left no duplicate');
  const docs = [...driveFake.files.values()].filter((f) => /^Prompt \d$/.test(f.name));
  eq(docs.map((f) => f.name).sort(), ['Prompt 1', 'Prompt 2', 'Prompt 3', 'Prompt 4', 'Prompt 5', 'Prompt 6'],
    'every prompt has exactly one Doc');
  const quiet = await engine().run();
  eq([quiet.pushed, quiet.errors.length], [0, 0], 'and there is nothing left over to push');
}

console.log('\n--- a run that has been given up on must not carry on ---');
{
  // The watchdog cannot cancel a stuck run; it can only abort its
  // signal. If the run un-sticks later it must stop at the next step,
  // or it would be writing beside the run that replaced it.
  for (let i = 7; i <= 9; i += 1) {
    await store.put('prompts', model.newPrompt({ projectId: project.id, title: `Late ${i}`, blocks: [{ id: 'b', type: 'ask', text: 'x' }] }));
  }
  const controller = new AbortController();
  let uploads = 0;
  hang = (method, path, options) => {
    if (isDocCreate(method, path, options)) {
      uploads += 1;
      // Given up on while its first new Doc is going up.
      if (uploads === 1) controller.abort(new StallError('Sync', 123));
    }
    return false;
  };
  const result = await timed(engine().run({ signal: controller.signal }));
  const late = [...driveFake.files.values()].filter((f) => /^Late \d$/.test(f.name));
  eq(result.how, 'resolved', 'the abandoned run ends');
  eq(late.length, 1, 'having finished the one request in flight and started no others');
  eq((await store.getSetting('google')).status, 'error', 'and says it stopped');

  hang = () => false;
  await engine().run();
  eq([...driveFake.files.values()].filter((f) => /^Late \d$/.test(f.name)).length, 3,
    'the replacement run finishes the job, with no duplicates');
}

console.log('\n--- the lock itself: one run at a time, never held forever ---');
{
  const STALL = 100;

  // A run that never settles and ignores its signal — the worst case.
  let stalls = 0;
  let seen = null;
  const stuck = createSingleFlight(({ signal }) => { seen = signal; return new Promise(() => {}); }, {
    stallMs: STALL, what: 'Sync', onStall: () => { stalls += 1; },
  });
  const first = await timed(stuck.start());
  eq(first.how, 'resolved', 'a stuck run releases the lock instead of holding it');
  eq(first.ms >= STALL - 5 && first.ms < STALL + SLACK, true, `after the stall limit (${first.ms} ms against ${STALL} ms)`);
  eq([stalls, stuck.isRunning(), seen.aborted], [1, false, true], 'the stall is reported once, the lock is free, the run is told to stop');

  // The next request gets a fresh run rather than the old stuck promise.
  let starts = 0;
  let stuckOnce = true;
  const recovering = createSingleFlight(() => {
    starts += 1;
    if (stuckOnce) { stuckOnce = false; return new Promise(() => {}); }
    return 'synced';
  }, { stallMs: STALL });
  await timed(recovering.start());
  const second = await timed(recovering.start());
  eq([second.value, starts], ['synced', 2], 'after a stall, the next request starts a new run and it completes');
}

{
  // Progress, not elapsed time: a long run that keeps moving is left alone.
  const STALL = 100;
  let stalls = 0;
  const steady = createSingleFlight(async ({ beat }) => {
    for (let i = 0; i < 8; i += 1) { await sleep(40); beat(); }
    return 'finished';
  }, { stallMs: STALL, onStall: () => { stalls += 1; } });
  const result = await timed(steady.start());
  eq([result.value, stalls], ['finished', 0], `a run three times longer than the stall limit finishes, because it kept reporting progress (${result.ms} ms)`);
}

{
  // Callers arriving mid-run share it, and one more pass follows.
  let runs = 0;
  const flight = createSingleFlight(async () => { runs += 1; await sleep(30); return runs; }, { stallMs: 1000 });
  const [a, b, c] = await Promise.all([flight.start(), flight.start(), flight.start()]);
  eq([a === b && b === c, runs], [true, 2], 'three overlapping requests become one run plus one follow-up pass, not three');
}

{
  // Something that asks for another pass every single time.
  let runs = 0;
  let capped = 0;
  let flight;
  flight = createSingleFlight(async () => { runs += 1; flight.start(); }, {
    stallMs: 1000, maxConsecutive: 5, onRerunsCapped: () => { capped += 1; },
  });
  const result = await timed(flight.start());
  eq([result.how, runs, capped], ['resolved', 5, 1], 'a trigger that never stops is cut off after five passes and handed back');
  eq(flight.isRunning(), false, 'with the lock released');
}

console.log('\n--- a worker killed mid-sync ---');
{
  await store.updateSetting('google', { status: 'syncing', lastError: null });
  eq(await clearStaleSyncing(), true, 'a "syncing" found at worker start-up is recognised as stale');
  const google = await store.getSetting('google');
  eq([google.status, /interrupted/.test(google.lastError)], ['error', true], 'and replaced with something true');
  await store.updateSetting('google', { status: 'idle', lastError: null });
  eq(await clearStaleSyncing(), false, 'an idle status is left alone');
  eq((await store.getSetting('google')).status, 'idle', 'untouched');
}

done();
