// Watchdogs — the rule that nothing in Edge Studio waits forever.
//
// The extension coordinates work across contexts that can each stop
// answering without failing: a Drive request that never returns, a chat
// tab that's frozen, a service worker put to sleep mid-task. A promise
// that never settles isn't an error anyone can catch — the button just
// never comes back — so every such wait gets a deadline here, and a
// stall becomes an ordinary, structured failure the caller already
// knows how to handle.
//
// Pure: no DOM, no chrome. Timers are injectable for the tests.

export class StallError extends Error {
  constructor(what, afterMs) {
    super(`${what} didn't finish within ${formatDuration(afterMs)}.`);
    this.name = 'StallError';
    this.code = 'stalled';
    this.what = what;
    this.afterMs = afterMs;
  }
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 90 * 1000) return `${Math.round(ms / 1000)} seconds`;
  return `${Math.round(ms / 60000)} minutes`;
}

// Runs `work(signal)` with a hard deadline. On expiry the signal is
// aborted — so work that honours it (fetch does) actually stops, rather
// than carrying on unobserved — and the returned promise rejects with a
// StallError. Whichever way it ends, the timer is cleared.
export function withDeadline(work, { ms, what = 'The operation', timers = globalThis } = {}) {
  const controller = new AbortController();
  let timer = null;

  const deadline = new Promise((_, reject) => {
    timer = timers.setTimeout(() => {
      const error = new StallError(what, ms);
      controller.abort(error);
      reject(error);
    }, ms);
  });

  // Promise.resolve().then(...) so a synchronous throw inside `work`
  // becomes a rejection instead of escaping past the timer cleanup.
  const task = Promise.resolve().then(() => work(controller.signal));

  return Promise.race([task, deadline]).finally(() => timers.clearTimeout(timer));
}

// One run at a time, and never a run that holds the lock forever.
//
// `run({ signal, beat })` does the work. Callers that arrive while a run
// is in flight share it and mark that another pass is due.
//
// The lock is released on a *lack of progress*, not on elapsed time: the
// run calls `beat()` whenever it gets something done, and the watchdog
// only trips after `stallMs` of silence. A first sync of a big project
// can take as long as it needs; a run that has stopped moving cannot.
//
// When the watchdog trips, `signal` is aborted. The stuck run can't be
// cancelled from outside, so the run itself must check the signal
// before each further step — that is what stops a run that un-sticks
// later from carrying on beside its replacement.
export function createSingleFlight(run, {
  stallMs,
  what = 'The run',
  maxConsecutive = 5,
  onStall = () => {},
  onRerunsCapped = () => {},
  timers = globalThis,
} = {}) {
  let running = null;
  let again = false;

  function once() {
    const controller = new AbortController();
    let timer = null;
    let trip;
    const stalled = new Promise((_, reject) => { trip = reject; });

    const arm = () => {
      timers.clearTimeout(timer);
      timer = timers.setTimeout(() => {
        const error = new StallError(what, stallMs);
        controller.abort(error);
        trip(error);
      }, stallMs);
    };

    arm();
    const task = Promise.resolve().then(() => run({ signal: controller.signal, beat: arm }));
    // If the watchdog wins the race, the abandoned task may still reject
    // later; that rejection has an owner, so it isn't "unhandled".
    task.catch(() => {});

    return Promise.race([task, stalled]).finally(() => timers.clearTimeout(timer));
  }

  function start() {
    if (running) {
      again = true;
      return running;
    }

    running = (async () => {
      let last;
      let passes = 0;
      try {
        do {
          again = false;
          passes += 1;
          last = await once();
        } while (again && passes < maxConsecutive);

        // Still being asked for more after the cap: something keeps
        // re-triggering the run. Stop here and hand the decision back,
        // rather than spinning for as long as the trigger persists.
        if (again) {
          again = false;
          onRerunsCapped(passes);
        }
      } catch (error) {
        if (error instanceof StallError) await onStall(error);
        else throw error;
      } finally {
        running = null;
      }
      return last;
    })();

    return running;
  }

  return { start, isRunning: () => running !== null };
}
