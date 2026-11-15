// The job queue.
//
// Every generation runs as a job, and a job is built to be run more than
// once: it carries an idempotency key, and asking for the same key again
// returns the job that already exists instead of making a second one.
// "Render this recipe" twice is one render.
//
// While it runs, a job beats — heartbeatAt moves forward — and is held
// to a timeout. When it fails, the failure is classified before anything
// else happens, because the class decides the response: a transient
// fault is retried with backoff, a content-filter refusal is not retried
// at all, since the same recipe would only be refused again.
//
// A job can also be "waiting": the work is a person's (a hand-off to a
// chat subscription), so there is no process to time out or recover.
// It is never pumped; complete(), fail() or cancel() ends it.
//
// States:  queued → running → succeeded
//                         ↘ failed      (retry / fallback / resume put it back to queued)
//                         ↘ queued      (transient fault, attempts left)
//            running ──(process died)──→ queued, via recover() at start-up
//                                      ↘ failed, after too many interruptions

import { newId } from './ids.mjs';
import { classifyError } from './adapters.mjs';

export function createQueue({
  store,
  handlers,
  now = () => Date.now(),
  timers = globalThis,
  timeoutMs = 60_000,
  heartbeatMs = 1000,
  maxAttempts = 3,
  backoffMs = (attempt) => 200 * 2 ** attempt,
  concurrency = 2,
}) {
  const active = new Map(); // jobId → promise, this process only

  const byKey = (key) => store.list('jobs', (job) => job.key === key && job.status !== 'cancelled')[0] || null;

  function enqueue({ key, kind, payload = {}, batchId = null, ...extra }) {
    const existing = byKey(key);
    if (existing) return { ...existing, deduped: true };
    const job = {
      id: newId('job'), key, kind, payload, batchId,
      status: 'queued', attempts: 0, maxAttempts, timeoutMs,
      createdAt: now(), runAfter: 0, startedAt: null, heartbeatAt: null, finishedAt: null,
      error: null, result: null, ...extra,
    };
    store.put('jobs', job);
    return job;
  }

  async function runJob(job) {
    job = { ...job, status: 'running', attempts: job.attempts + 1, startedAt: now(), heartbeatAt: now(), error: null };
    store.put('jobs', job);

    const beat = () => {
      const current = store.get('jobs', job.id);
      if (current && current.status === 'running') store.put('jobs', { ...current, heartbeatAt: now() });
    };
    const heart = timers.setInterval(beat, heartbeatMs);
    const controller = new AbortController();
    const timeoutError = Object.assign(new Error(`No result after ${Math.round(job.timeoutMs / 1000)} s.`), { kind: 'timeout' });
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = timers.setTimeout(() => { controller.abort(timeoutError); reject(timeoutError); }, job.timeoutMs);
    });

    try {
      const work = Promise.resolve().then(() => handlers[job.kind](job, { signal: controller.signal, beat }));
      work.catch(() => {});
      const result = await Promise.race([work, deadline]);
      store.put('jobs', { ...store.get('jobs', job.id), status: 'succeeded', result, finishedAt: now(), heartbeatAt: now() });
    } catch (error) {
      const classified = classifyError(error);
      const current = store.get('jobs', job.id);
      const again = classified.retryable && current.attempts < current.maxAttempts;
      store.put('jobs', {
        ...current,
        status: again ? 'queued' : 'failed',
        runAfter: again ? now() + backoffMs(current.attempts) : 0,
        error: { ...classified, attempt: current.attempts, willRetry: again },
        finishedAt: again ? null : now(),
      });
    } finally {
      timers.clearInterval(heart);
      timers.clearTimeout(timer);
    }
  }

  // Starts whatever is due, up to the concurrency limit.
  function pump() {
    const due = store
      .list('jobs', (job) => job.status === 'queued' && job.runAfter <= now() && !active.has(job.id))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const job of due) {
      if (active.size >= concurrency) break;
      const run = runJob(job).finally(() => active.delete(job.id));
      active.set(job.id, run);
    }
    return Promise.all([...active.values()]);
  }

  // Runs until nothing is queued or running. For tests and batch calls.
  async function drain() {
    for (;;) {
      await pump();
      const waiting = store.list('jobs', (job) => job.status === 'queued');
      if (waiting.length === 0 && active.size === 0) return;
      const next = Math.min(...waiting.map((job) => job.runAfter));
      const wait = Math.max(0, next - now());
      if (wait > 0) await new Promise((resolve) => timers.setTimeout(resolve, wait));
    }
  }

  // Puts a failed job back in line, with a fresh set of attempts.
  function retry(jobId) {
    const job = store.get('jobs', jobId);
    if (!job) throw new Error('No such job.');
    if (job.status !== 'failed') return job;
    // Work that was a person's goes back to the person, not to a model.
    return store.put('jobs', { ...job, status: job.byHand ? 'waiting' : 'queued', attempts: 0, runAfter: 0, error: null, finishedAt: null, retriedAt: now() });
  }

  // Re-queues what failed in a batch and leaves what succeeded alone.
  function resumeBatch(batchId) {
    const jobs = store.list('jobs', (job) => job.batchId === batchId);
    const failed = jobs.filter((job) => job.status === 'failed');
    failed.forEach((job) => retry(job.id));
    return { requeued: failed.length, alreadyDone: jobs.filter((job) => job.status === 'succeeded').length, total: jobs.length };
  }

  // Called once, at start-up, before anything is pumped.
  //
  // A job's status is on disk; the work was in a process that no longer
  // exists. At start-up nothing is running in this process yet, so every
  // record that says "running" is an orphan by definition — there is no
  // heartbeat to consult and no guess to make. Each goes back in line.
  //
  // The interruption is not the job's fault, so it does not cost one of
  // its attempts. But a job that is interrupted again and again is
  // probably what is bringing the process down, so it gets a limited
  // number of recoveries and is then stopped for a person to look at.
  function recover({ maxRecoveries = 3 } = {}) {
    let requeued = 0;
    let stopped = 0;
    store.list('jobs', (job) => job.status === 'running' && !active.has(job.id)).forEach((job) => {
      const recoveries = (job.recoveries || 0) + 1;
      if (recoveries > maxRecoveries) {
        stopped += 1;
        store.put('jobs', {
          ...job, status: 'failed', finishedAt: now(),
          error: {
            class: 'interrupted', retryable: false, action: 'inspect', attempt: job.attempts, willRetry: false,
            message: `Interrupted ${recoveries} times in a row.`,
            advice: 'This job was running each time the studio stopped. It may be the cause — check the shot before retrying.',
          },
        });
        return;
      }
      requeued += 1;
      store.put('jobs', { ...job, status: 'queued', attempts: Math.max(0, job.attempts - 1), runAfter: 0, startedAt: null, recoveries, recoveredAt: now() });
    });
    return { requeued, stopped };
  }

  // For work finished outside the queue.
  const waitingJob = (jobId) => {
    const job = store.get('jobs', jobId);
    if (!job) throw new Error('No such job.');
    if (job.status !== 'waiting') throw Object.assign(new Error(`This job is ${job.status}, not waiting.`), { refusal: true });
    return job;
  };
  const complete = (jobId, result) => store.put('jobs', { ...waitingJob(jobId), status: 'succeeded', result, finishedAt: now() });
  const fail = (jobId, error) => store.put('jobs', { ...waitingJob(jobId), status: 'failed', finishedAt: now(), error: { ...classifyError(error), attempt: 1, willRetry: false } });
  const cancel = (jobId) => store.put('jobs', { ...waitingJob(jobId), status: 'cancelled', finishedAt: now() });

  return { complete, fail, cancel, enqueue, pump, drain, retry, resumeBatch, recover, byKey, isActive: (id) => active.has(id) };
}
