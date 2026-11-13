// Stall simulation, vector B: a chat tab that stops answering.
//
// Insert has a clipboard fallback for tabs it can't write into, but it
// reacts to a failure — and a tab that never replies produced none. The
// relay now turns that silence into a structured failure inside a bound.
// Mocks here never settle unless a case says otherwise.
import { makeChecker } from './fake-chrome.mjs';
import { EXTENSION } from './paths.mjs';

const { createRelay, ADAPTER_FILE } = await import(new URL('shared/relay.js', EXTENSION));
const { eq, done } = makeChecker();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT = 80;
const INJECT = 60;
const SLACK = 400;
const never = () => new Promise(() => {});

async function timed(promise, ceiling = 5000) {
  const started = Date.now();
  const outcome = await Promise.race([
    promise.then((value) => ({ how: 'resolved', value }), (error) => ({ how: 'rejected', error })),
    sleep(ceiling).then(() => ({ how: 'HUNG' })),
  ]);
  return { ...outcome, ms: Date.now() - started };
}

// Anything escaping as an unhandled rejection is a watchdog that left a
// promise behind without an owner.
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(String(reason)));

const relayWith = (sendMessage, executeScript = async () => {}) =>
  createRelay({ sendMessage, executeScript, timeoutMs: TIMEOUT, injectTimeoutMs: INJECT });

console.log('--- a healthy tab ---');
{
  const relay = relayWith(async (tabId, message) => ({ success: true, echo: [tabId, message.type] }));
  const result = await timed(relay(7, { type: 'EDGE_STUDIO_INJECT_PROMPT' }));
  eq(result.value, { success: true, echo: [7, 'EDGE_STUDIO_INJECT_PROMPT'] }, 'the answer passes straight through');

  const silent = await relayWith(async () => undefined)(7, {});
  eq(silent, { success: false, reason: 'No response from content script.' }, 'a listener that answers nothing is still a structured failure');
}

console.log('\n--- a frozen tab ---');
{
  let injections = 0;
  const relay = relayWith(never, async () => { injections += 1; });
  const result = await timed(relay(7, { type: 'EDGE_STUDIO_INJECT_PROMPT', text: 'a prompt' }));

  eq(result.how, 'resolved', 'the relay answers — it used to wait for as long as the tab stayed frozen');
  eq(result.ms >= TIMEOUT - 5 && result.ms < TIMEOUT + SLACK, true, `on time (${result.ms} ms against ${TIMEOUT} ms)`);
  eq([result.value.success, result.value.timedOut], [false, true], 'as a failure marked timedOut, which every caller already treats as "use the fallback"');
  eq(/didn't answer within 80 ms/.test(result.value.reason), true, 'with a reason fit to show');
  eq(injections, 0, "and without re-injecting into a page that isn't responding, which would only double the wait");
}

console.log('\n--- a tab that never got the content script ---');
{
  // The existing recovery: no receiver → inject → retry. It has to keep
  // working, and now has to be bounded at every step.
  let sends = 0;
  const injected = [];
  const relay = relayWith(
    async () => {
      sends += 1;
      if (sends === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { success: true };
    },
    async (injection) => { injected.push(injection); }
  );
  const result = await timed(relay(9, { type: 'EDGE_STUDIO_PROBE' }));
  eq(result.value, { success: true }, 'inject-and-retry still recovers it');
  eq(injected, [{ target: { tabId: 9 }, files: [ADAPTER_FILE] }], 'by injecting the adapter into that tab, once');
}

{
  const noReceiver = async () => { throw new Error('Receiving end does not exist.'); };

  const stuckInject = await timed(relayWith(noReceiver, never)(9, {}));
  eq([stuckInject.how, stuckInject.value.timedOut], ['resolved', true], 'an injection that never completes is bounded too');
  eq(stuckInject.ms < INJECT + SLACK, true, `(${stuckInject.ms} ms against ${INJECT} ms)`);

  let sends = 0;
  const stuckRetry = await timed(relayWith(async () => { sends += 1; if (sends === 1) throw new Error('no receiver'); return never(); })(9, {}));
  eq([stuckRetry.how, stuckRetry.value.timedOut], ['resolved', true], 'and so is a retry that hangs after a successful injection');
  eq(stuckRetry.ms < TIMEOUT + INJECT + SLACK, true, `the worst case is one of each, not unbounded (${stuckRetry.ms} ms)`);

  const refused = await relayWith(noReceiver, async () => { throw new Error('Cannot access contents of the page.'); })(9, {});
  eq(refused, { success: false, reason: 'Cannot access contents of the page.' }, 'a real refusal keeps its own reason and is not called a timeout');
}

console.log('\n--- it never throws, whatever chrome does ---');
{
  const sync = await timed(relayWith(() => { throw new Error('thrown before any promise existed'); }, async () => { throw new Error('nope'); })(1, {}));
  eq([sync.how, sync.value.success], ['resolved', false], 'a synchronous throw from the API still comes back as a response');
}

console.log('\n--- many callers against one frozen tab ---');
{
  // The reply poller asks every two seconds. Against a frozen tab each
  // ask must end by itself, or they pile up for as long as it is frozen.
  let open = 0;
  let peak = 0;
  const relay = relayWith(() => { open += 1; peak = Math.max(peak, open); return never(); });
  const results = await timed(Promise.all(Array.from({ length: 25 }, () => relay(3, { type: 'EDGE_STUDIO_CAPTURE_RESPONSE' }))));
  eq(results.value.every((r) => r.timedOut === true), true, 'all twenty-five are answered');
  eq(results.ms < TIMEOUT + SLACK, true, `together, in one deadline rather than twenty-five (${results.ms} ms)`);
}

console.log('\n--- an answer that arrives after the deadline ---');
{
  const late = relayWith(() => sleep(TIMEOUT * 2).then(() => ({ success: true, late: true })));
  const first = await timed(late(5, {}));
  eq(first.value.timedOut, true, 'the caller was already told it timed out');
  await sleep(TIMEOUT * 2);

  const lateFailure = relayWith(() => sleep(TIMEOUT * 2).then(() => { throw new Error('failed long after anyone was listening'); }));
  await timed(lateFailure(5, {}));
  await sleep(TIMEOUT * 2 + 50);
  eq(unhandled, [], 'and neither a late answer nor a late failure escapes as an unhandled rejection');
}

done();
