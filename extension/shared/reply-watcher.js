// Watching a chat tab for its answer — the loop behind every round trip.
//
// The loop asks the tab for its latest reply, over and over, until the
// reply is new and has stopped growing. Left to itself that is a loop
// with no end: if the answer never comes it asks the same question
// forever, and when it ran on setInterval a slow tab had several asks
// in flight at once, each started before the last had returned.
//
// Two rules fix that, and neither depends on anyone noticing:
//
//   - one ask at a time. The next is not started until the last has
//     come back, however long that took.
//   - no progress, no polling. If nothing about the reply has changed
//     for `idleLimitMs`, the watcher stops asking and says so. It does
//     not guess: whoever is waiting decides what happens next.
//
// "Progress" is the reply changing, not time passing — a long answer
// that is still streaming keeps the watcher alive for as long as it
// keeps arriving.
//
// Pure: no DOM, no chrome. roundtrip.js puts the dialog on top.

export const POLL_MS = 2000;
// Two unchanged polls before the answer counts as finished.
export const STABLE_TICKS = 2;
// Long enough to switch tabs, press Enter and wait out a slow model;
// short enough that a forgotten dialog isn't still asking tomorrow.
export const IDLE_LIMIT_MS = 10 * 60 * 1000;

export function createReplyWatcher({
  capture,
  baseline = '',
  pollMs = POLL_MS,
  stableTicks = STABLE_TICKS,
  idleLimitMs = IDLE_LIMIT_MS,
  onChange = () => {},
  timers = globalThis,
  now = () => Date.now(),
}) {
  let lastSeen = null;
  let settled = null;
  let stopped = false;
  let wake = null;
  let timer = null;

  // A pause that stop() can cut short, so stopping doesn't have to wait
  // out the rest of a poll interval.
  const pause = (ms) =>
    new Promise((resolve) => {
      wake = resolve;
      timer = timers.setTimeout(resolve, ms);
    });

  async function ask() {
    try {
      return (await capture()) || '';
    } catch {
      // A failed ask is the same as "nothing yet": the tab may be
      // mid-navigation or briefly unreachable. The idle limit is what
      // bounds a tab that never comes back.
      return '';
    }
  }

  async function watch() {
    let unchanged = 0;
    let lastProgressAt = now();

    while (!stopped) {
      const text = await ask();
      if (stopped) break;

      const isNew = text && text !== baseline;

      if (isNew && text === lastSeen) {
        unchanged += 1;
        if (unchanged >= stableTicks) {
          settled = text;
          return { status: 'settled', text };
        }
      } else if (isNew) {
        lastSeen = text;
        unchanged = 0;
        lastProgressAt = now();
        onChange(text);
      }

      // The circuit breaker. Reached only when nothing has changed for
      // the whole limit — the same empty or old answer, every time.
      if (now() - lastProgressAt >= idleLimitMs) {
        return { status: 'gave-up', text: lastSeen, idleMs: now() - lastProgressAt };
      }

      await pause(pollMs);
    }

    return { status: 'stopped', text: lastSeen };
  }

  const done = watch();

  return {
    // Resolves once: { status: 'settled' | 'gave-up' | 'stopped', text }.
    done,
    // The best answer so far: the settled one, or whatever was last seen
    // arriving. Null if the tab has shown nothing new.
    latest: () => settled || lastSeen,
    stop() {
      stopped = true;
      timers.clearTimeout(timer);
      if (wake) wake();
    },
  };
}
