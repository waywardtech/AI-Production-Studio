// Stall simulation, vector C: waiting for an answer that never comes.
//
// The loop behind every round trip used to ask the tab for its reply on
// a fixed interval with no end and no in-flight guard. Measured before
// the change, against a tab that took 200 ms to answer and never had
// anything new: 74 identical asks in 1.5 s, up to 10 in flight at once,
// and still going. These cases pin down the two rules that replaced it.
import { makeChecker } from './fake-chrome.mjs';
import { EXTENSION } from './paths.mjs';

const { createReplyWatcher } = await import(new URL('shared/reply-watcher.js', EXTENSION));
const { eq, done } = makeChecker();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL = 10;
const IDLE = 150;
const SLACK = 500;

async function timed(promise, ceiling = 6000) {
  const started = Date.now();
  const outcome = await Promise.race([
    promise.then((value) => ({ how: 'resolved', value })),
    sleep(ceiling).then(() => ({ how: 'HUNG' })),
  ]);
  return { ...outcome, ms: Date.now() - started };
}

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(String(reason)));

// A tab that returns each of `frames` in turn, then repeats the last.
function tab(frames, { delay = 0 } = {}) {
  const stats = { calls: 0, inFlight: 0, peak: 0 };
  const capture = async () => {
    const frame = frames[Math.min(stats.calls, frames.length - 1)];
    stats.calls += 1;
    stats.inFlight += 1;
    stats.peak = Math.max(stats.peak, stats.inFlight);
    if (delay) await sleep(delay);
    stats.inFlight -= 1;
    if (frame instanceof Error) throw frame;
    return frame;
  };
  return { capture, stats };
}

const watch = (capture, extra = {}) =>
  createReplyWatcher({ capture, baseline: 'the old answer', pollMs: POLL, stableTicks: 2, idleLimitMs: IDLE, ...extra });

console.log('--- an answer that arrives and finishes ---');
{
  const changes = [];
  const { capture, stats } = tab(['the old answer', 'the old answer', 'Here', 'Here is', 'Here is the rewrite.']);
  const watcher = watch(capture, { onChange: (text) => changes.push(text) });
  const result = await timed(watcher.done);
  eq(result.value, { status: 'settled', text: 'Here is the rewrite.' }, 'it settles on the finished answer, not a half-written one');
  eq(changes, ['Here', 'Here is', 'Here is the rewrite.'], 'reporting each change as it streams in');
  eq(watcher.latest(), 'Here is the rewrite.', 'and latest() is the settled text');
  const callsAtSettle = stats.calls;
  await sleep(POLL * 6);
  eq(stats.calls, callsAtSettle, 'once settled, it stops asking');
}

console.log('\n--- an answer that never comes ---');
{
  const { capture, stats } = tab(['the old answer']);
  const watcher = watch(capture);
  const result = await timed(watcher.done);

  eq(result.how, 'resolved', 'the watcher ends by itself — the old loop only ended when someone cancelled it');
  eq(result.value.status, 'gave-up', 'by giving up, and saying so');
  eq(result.ms >= IDLE - 5 && result.ms < IDLE + SLACK, true, `at the idle limit (${result.ms} ms against ${IDLE} ms)`);
  eq(watcher.latest(), null, 'with nothing claimed as an answer');

  const callsAtGiveUp = stats.calls;
  await sleep(POLL * 10);
  eq(stats.calls, callsAtGiveUp, 'and it has genuinely stopped: not one more identical ask afterwards');
  eq(callsAtGiveUp <= IDLE / POLL + 2, true, `having asked a bounded number of times (${callsAtGiveUp})`);
}

console.log('\n--- a slow tab ---');
{
  // Each ask takes eight poll intervals to come back. On setInterval
  // that put eight asks in flight at once, climbing for as long as the
  // dialog stayed open.
  const { capture, stats } = tab(['the old answer'], { delay: POLL * 8 });
  const watcher = watch(capture, { idleLimitMs: 400 });
  await timed(watcher.done);
  eq(stats.peak, 1, 'never more than one ask in flight, however slow the tab');
  eq(stats.calls <= 6, true, `so a slow tab is asked less often, not more (${stats.calls} asks in ~400 ms)`);
}

console.log('\n--- a long answer that is still arriving ---');
{
  // Streams for well over the idle limit. Progress is the reply
  // changing, so this must not be mistaken for a stall.
  const frames = Array.from({ length: 30 }, (_, i) => `word `.repeat(i + 1));
  const { capture } = tab(frames, { delay: POLL });
  const started = Date.now();
  const result = await timed(watch(capture).done);
  eq(result.value.status, 'settled', 'an answer that keeps growing is left to finish');
  eq(Date.now() - started > IDLE * 2, true, `even though it ran for ${Date.now() - started} ms against a ${IDLE} ms idle limit`);
  eq(result.value.text, frames[29], 'and it settles on the complete text');
}

console.log('\n--- a tab that fails, then answers ---');
{
  const { capture } = tab([new Error('tab is mid-navigation'), '', '', 'A late answer.', 'A late answer.', 'A late answer.']);
  const result = await timed(watch(capture).done);
  eq(result.value, { status: 'settled', text: 'A late answer.' }, 'failed and empty asks count as "nothing yet", and the answer is still found');
}

{
  const { capture } = tab([new Error('permanently unreachable')]);
  const result = await timed(watch(capture).done);
  eq(result.value.status, 'gave-up', 'a tab that fails every time is given up on at the same limit');
  eq(unhandled, [], 'without a single failure escaping as an unhandled rejection');
}

console.log('\n--- stopping ---');
{
  const { capture, stats } = tab(['the old answer', 'Partial ans']);
  const watcher = watch(capture, { pollMs: 5000 }); // parked in a long pause
  await sleep(40);
  const result = await timed((watcher.stop(), watcher.done));
  eq(result.value.status, 'stopped', 'stop() ends the watch');
  eq(result.ms < 200, true, `at once, not at the end of the pause it was parked in (${result.ms} ms of a 5000 ms pause)`);
  const calls = stats.calls;
  await sleep(60);
  eq(stats.calls, calls, 'and nothing more is asked of the tab');
}

{
  // "Use latest now" mid-stream: whatever had arrived is what's used.
  const { capture } = tab(['the old answer', 'Half an ans', 'Half an answer, still com'], { delay: 5 });
  const watcher = watch(capture, { stableTicks: 50 });
  await sleep(80);
  watcher.stop();
  await watcher.done;
  eq(watcher.latest(), 'Half an answer, still com', 'latest() hands back what had arrived when it was stopped');
}

done();
