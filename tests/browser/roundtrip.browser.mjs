// A whole round trip through a chat tab: Optimize writes a request into
// the tab, the waiting dialog watches for the answer, and the answer
// comes back for review.
//
// The watching loop was rebuilt (shared/reply-watcher.js) and nothing
// covered the dialog on top of it. This is the wiring, in a real Chrome:
// the unit tests prove the loop stops when it should; this proves it
// still finds an answer when there is one.
import { launchWithExtension, makeRunner, openPage, serveStandInChat } from './harness.mjs';

const session = await launchWithExtension({ profile: 'roundtrip' });
const run = makeRunner('round trip');

await serveStandInChat(
  session,
  `<div id="prompt-textarea" contenteditable="true"></div>
   <div id="thread">
     <div data-message-author-role="assistant" style="white-space: pre-wrap">An earlier answer, already on screen.</div>
   </div>`
);

const chat = await session.ctx.newPage();
await chat.goto('https://chatgpt.com/c/stand-in');
await chat.waitForTimeout(800);

const panel = await openPage(session, 'sidepanel/sidepanel.html');

await run.step('set up: a prompt in the builder and the tab detected', async () => {
  await panel.locator('#refresh-tabs-btn').click();
  await panel.waitForTimeout(800);
  await panel.locator('.block-chip').first().click();
  await panel.locator('#canvas textarea').first().fill('Summarise the launch plan.');
  await panel.waitForTimeout(300);
});

await run.step('Optimize writes its request into the chat and starts watching', async () => {
  await panel.locator('#optimize-btn').click();
  await panel.waitForTimeout(500);
  await panel.locator('#modal-confirm-btn').click(); // "Send" on the setup dialog
  await panel.waitForFunction(() => /Waiting for the rewrite/.test(document.getElementById('modal-title').textContent), null, { timeout: 8000 });

  const composer = await chat.locator('#prompt-textarea').innerText();
  if (!composer.includes('Summarise the launch plan.')) throw new Error(`the composer held "${composer.slice(0, 80)}"`);
  if (!composer.includes('PROMPT TO REWRITE')) throw new Error('the optimization request was not what arrived');
});

await run.step('the earlier answer is not mistaken for the reply', async () => {
  // Two polls' worth of the old answer sitting there unchanged.
  await panel.waitForTimeout(5000);
  const title = await panel.locator('#modal-title').innerText();
  if (title !== 'Waiting for the rewrite') throw new Error(`the dialog moved on by itself: "${title}"`);
  const body = await panel.locator('#modal-body').innerText();
  if (!/Watching for the answer/.test(body)) throw new Error(`the dialog said: ${body}`);
});

await run.step('a streamed answer is waited out, then handed over whole', async () => {
  // The chat "answers": first half an answer, then the rest.
  await chat.evaluate(() => {
    const turn = document.createElement('div');
    turn.setAttribute('data-message-author-role', 'assistant');
    turn.style.whiteSpace = 'pre-wrap';
    turn.textContent = '```\nSummarise the';
    document.getElementById('thread').appendChild(turn);
    setTimeout(() => { turn.textContent = '```\nSummarise the launch plan in five bullets.\n```'; }, 2500);
  });

  await panel.waitForFunction(() => /Optimized for/.test(document.getElementById('modal-title').textContent), null, { timeout: 20000 });
  const rewritten = await panel.locator('#modal-fields textarea').inputValue();
  if (rewritten !== 'Summarise the launch plan in five bullets.') {
    throw new Error(`the review dialog held "${rewritten}" — a half-written answer, or the wrong one`);
  }
});

await run.step('accepting it replaces the builder', async () => {
  await panel.locator('#modal-confirm-btn').click();
  await panel.waitForTimeout(500);
  const preview = await panel.locator('#preview').inputValue();
  if (preview !== 'Summarise the launch plan in five bullets.') throw new Error(`the builder held "${preview}"`);
});

await run.step('Cancel stops the watching', async () => {
  await panel.locator('#optimize-btn').click();
  await panel.waitForTimeout(500);
  await panel.locator('#modal-confirm-btn').click();
  await panel.waitForFunction(() => /Waiting for the rewrite/.test(document.getElementById('modal-title').textContent), null, { timeout: 8000 });
  await panel.locator('#modal-cancel-btn').click();
  await panel.waitForTimeout(400);
  if (!(await panel.locator('#modal').evaluate((el) => el.classList.contains('hidden')))) throw new Error('the dialog stayed open');
  const toast = await panel.locator('#toast').innerText();
  if (!/Cancelled/.test(toast)) throw new Error(`the toast read "${toast}"`);
});

if (panel.collectedErrors.length) run.fail(`panel logged: ${panel.collectedErrors.join(' | ')}`);

await session.close();
run.finish();
