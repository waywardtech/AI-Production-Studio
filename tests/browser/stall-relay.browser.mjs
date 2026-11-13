// A genuinely frozen tab, in a real Chrome.
//
// The unit tests prove the relay's watchdog; this proves the thing it
// guards against is real — that a tab whose main thread is locked leaves
// chrome.tabs.sendMessage unanswered — and that Insert then reaches its
// clipboard fallback instead of waiting for as long as the tab is stuck.
//
// It takes about 20 seconds: the relay's real 15-second deadline has to
// run out.
import { launchWithExtension, makeRunner, openPage, serveStandInChat } from './harness.mjs';

const session = await launchWithExtension({ profile: 'stall-relay' });
const run = makeRunner('stall: frozen tab');

// The page can lock its own main thread on request. A content script
// shares that thread, so while it's locked nothing sent to the tab can
// be answered — the same condition as a page stuck in a long task.
await serveStandInChat(
  session,
  `<div id="prompt-textarea" contenteditable="true"></div>
   <script>
     window.__freeze = (ms) => { const until = Date.now() + ms; while (Date.now() < until) {} };
   </script>`
);

const chat = await session.ctx.newPage();
await chat.goto('https://chatgpt.com/c/stand-in');
await chat.waitForTimeout(800);

const panel = await openPage(session, 'sidepanel/sidepanel.html');

await run.step('set up: tick the tab and write a prompt', async () => {
  await panel.locator('#refresh-tabs-btn').click();
  await panel.waitForTimeout(800);
  await panel.locator('.tab-item input[type=checkbox]').first().check();
  await panel.locator('.block-chip').first().click();
  await panel.locator('#canvas textarea').first().fill('A prompt for a tab that is about to freeze.');
  await panel.waitForTimeout(300);
});

await run.step('control: while the tab is healthy, Insert goes straight in', async () => {
  const started = Date.now();
  await panel.locator('#insert-btn').click();
  await panel.waitForFunction(() => /Inserted into 1 tab/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
  const took = Date.now() - started;
  if (took > 5000) throw new Error(`a healthy insert took ${took} ms`);
});

let elapsed = 0;
await run.step('frozen: Insert gives up on the tab and falls back, in bounded time', async () => {
  // Lock the page for far longer than the relay will wait. Fired from a
  // timer so this call itself returns before the thread locks.
  await chat.evaluate(() => { setTimeout(() => window.__freeze(60000), 50); });
  await panel.waitForTimeout(400);

  const started = Date.now();
  await panel.locator('#insert-btn').click();
  await panel.waitForFunction(
    () => /copied to clipboard/.test(document.getElementById('toast').textContent),
    null,
    { timeout: 40000 }
  );
  elapsed = Date.now() - started;

  // Faster than the deadline would mean Chrome failed the message by
  // itself and the watchdog proved nothing; much slower would mean the
  // bound isn't holding.
  if (elapsed < 13000) throw new Error(`fell back after only ${elapsed} ms — the tab wasn't really unanswered`);
  if (elapsed > 25000) throw new Error(`took ${elapsed} ms — the 15 s bound isn't holding`);
});
console.log(`        (fell back after ${(elapsed / 1000).toFixed(1)} s, against a 15 s deadline)`);

await run.step('the panel is still usable afterwards', async () => {
  await panel.locator('#refresh-tabs-btn').click();
  await panel.waitForTimeout(600);
  const count = await panel.locator('.tab-item').count();
  if (count !== 1) throw new Error(`expected the tab to still be listed, saw ${count}`);
});

if (panel.collectedErrors.length) run.fail(`panel logged: ${panel.collectedErrors.join(' | ')}`);

await session.close();
run.finish();
