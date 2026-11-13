// Hardening cycle 1: the process dies mid-render.
//
// A job's status lives on disk, the work lives in a process. When the
// process goes, the record still says "running" and nothing is running.
// These cases restart the studio on the same data file and check that
// interrupted work is picked up — once, without redoing or duplicating
// anything that had already finished.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeChecker, seedFilm, sleep, testStudio } from './helpers.mjs';
import { createStore } from '../src/store.mjs';

const { eq, done } = makeChecker();
const dataFile = () => join(mkdtempSync(join(tmpdir(), 'studio-')), 'studio.json');
const never = () => new Promise(() => {});

// A second studio on the same file is what a restarted server is.
const restart = (file, options = {}) => {
  const next = testStudio({ store: createStore({ file }), ...options });
  const recovered = next.studio.queue.recover ? next.studio.queue.recover() : null;
  return { ...next, recovered };
};

console.log('--- killed while a render was in flight ---');
{
  const file = dataFile();
  const before = testStudio({ store: createStore({ file }), faults: never, queueOptions: { timeoutMs: 60_000 } });
  const film = seedFilm(before.studio);
  const { job } = before.studio.render(film.shots[0].id, { seed: 1 });
  before.studio.queue.pump(); // starts it; the model never answers
  await sleep(30);
  eq(before.studio.store.get('jobs', job.id).status, 'running', 'the job is running when the process dies');

  const after = restart(file);
  eq(after.recovered?.requeued, 1, 'on restart the interrupted job is found');
  await Promise.race([after.studio.queue.drain(), sleep(2000)]);
  const recoveredJob = after.studio.store.get('jobs', job.id);
  eq(recoveredJob.status, 'succeeded', 'and it completes — it used to sit at "running" for good');
  eq(after.studio.takesOf(film.shots[0].id).length, 1, 'producing its take');
  eq(recoveredJob.attempts, 1, "the interruption isn't counted against the job's attempts");
  eq(typeof recoveredJob.recoveredAt, 'number', 'and the job records that it was recovered');
}

console.log('\n--- killed after the take was written, before the job was marked done ---');
{
  // The narrowest window, and the expensive one: the output exists, the
  // record doesn't say so. Re-running must not spend a second render or
  // leave the shot with two copies of one take.
  const file = dataFile();
  const before = testStudio({ store: createStore({ file }) });
  const film = seedFilm(before.studio);
  const { job, recipe } = before.studio.render(film.shots[0].id, { seed: 2 });
  await before.studio.queue.drain();
  eq(before.studio.takesOf(film.shots[0].id).length, 1, 'the render finished and wrote its take');

  // Put the file in the state that crash would leave: take present, job
  // still "running".
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  disk.jobs = disk.jobs.map((j) => (j.id === job.id ? { ...j, status: 'running', result: null, finishedAt: null } : j));
  writeFileSync(file, JSON.stringify(disk));

  const after = restart(file);
  await Promise.race([after.studio.queue.drain(), sleep(2000)]);
  eq(after.studio.store.get('jobs', job.id).status, 'succeeded', 'the job is closed out');
  eq(after.studio.takesOf(film.shots[0].id).length, 1, 'with still exactly one take');
  eq(after.adapters.calls.get(recipe.id) || 0, 0, 'and without calling the model again — the work was already paid for');
  eq(after.studio.store.get('jobs', job.id).result?.takeId, after.studio.takesOf(film.shots[0].id)[0].id, 'the job points at the take that was already there');
}

console.log('\n--- a batch interrupted half way ---');
{
  const file = dataFile();
  let released = 0;
  const before = testStudio({
    store: createStore({ file }),
    // The first shot renders; the rest hang, as if the process died mid-batch.
    faults: () => (released++ === 0 ? undefined : never()),
    queueOptions: { timeoutMs: 60_000, concurrency: 1 },
  });
  const film = seedFilm(before.studio);
  const { batch } = before.studio.rerender(film.shots.map((s) => s.id));
  before.studio.queue.pump();
  await sleep(60);
  before.studio.queue.pump();
  await sleep(30);
  const done1 = before.studio.store.list('jobs', (j) => j.status === 'succeeded').map((j) => j.payload.recipeId);
  eq(done1.length, 1, 'one of three shots had finished');

  const after = restart(file);
  await Promise.race([after.studio.queue.drain(), sleep(3000)]);
  eq(after.studio.store.list('jobs', (j) => j.batchId === batch.id).map((j) => j.status), ['succeeded', 'succeeded', 'succeeded'], 'after restart the whole batch completes');
  eq(film.shots.map((s) => after.studio.takesOf(s.id).length), [1, 1, 1], 'one take per shot');
  eq(after.adapters.calls.get(done1[0]) || 0, 0, 'and the shot that had finished was not rendered a second time');
}

console.log('\n--- a job that takes the process down every time ---');
{
  // Without a limit, a render that crashes the server would be picked
  // up on every restart and crash it again, forever.
  const file = dataFile();
  let current = testStudio({ store: createStore({ file }), faults: never, queueOptions: { timeoutMs: 60_000 } });
  const film = seedFilm(current.studio);
  const { job } = current.studio.render(film.shots[0].id, { seed: 3 });
  const statuses = [];
  for (let life = 0; life < 5; life += 1) {
    current.studio.queue.pump();
    await sleep(20);
    current = restart(file, { faults: never, queueOptions: { timeoutMs: 60_000 } });
    statuses.push(current.studio.store.get('jobs', job.id).status);
  }
  eq(statuses.at(-1), 'failed', 'after repeated interruptions the job is stopped rather than retried forever');
  const stopped = current.studio.store.get('jobs', job.id);
  eq([stopped.error?.class, stopped.error?.retryable], ['interrupted', false], 'classified as interrupted, and left for a person to decide');
  eq(statuses.filter((s) => s === 'queued').length, 3, 'having been given three chances');
}

console.log('\n--- restart with nothing wrong ---');
{
  const file = dataFile();
  const before = testStudio({ store: createStore({ file }) });
  const film = seedFilm(before.studio);
  before.studio.render(film.shots[0].id, { seed: 4 });
  await before.studio.queue.drain();
  const after = restart(file);
  eq(after.recovered, { requeued: 0, stopped: 0 }, 'a clean restart recovers nothing');
  await after.studio.queue.drain();
  eq([after.studio.takesOf(film.shots[0].id).length, after.adapters.calls.size], [1, 0], 'and re-renders nothing');
}

done();
