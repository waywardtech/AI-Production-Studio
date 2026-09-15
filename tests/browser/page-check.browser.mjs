// The page check (M5-5) against a page the content script really runs
// on, so what it reports is what the adapter would actually find.
import { launchWithExtension, makeRunner, openPage, serveStandInChat } from './harness.mjs';

const session = await launchWithExtension({ profile: 'page-check' });
const run = makeRunner('page check');

await serveStandInChat(
  session,
  `<div id="prompt-textarea" contenteditable="true"></div>
   <input type="file" multiple accept="image/*,video/*">
   <div data-message-author-role="assistant">An earlier answer.</div>
   <p>You have used 18 of your 40 messages</p>`
);

const chat = await session.ctx.newPage();
await chat.goto('https://chatgpt.com/c/stand-in');
await chat.waitForTimeout(800);

const panel = await openPage(session, 'sidepanel/sidepanel.html');
let report = '';

await run.step('the tab is detected', async () => {
  await panel.locator('#refresh-tabs-btn').click();
  await panel.waitForTimeout(800);
  const count = await panel.locator('.tab-item').count();
  if (count !== 1) throw new Error(`expected one chat tab, saw ${count}`);
});

await run.step('the check reports what each path would find', async () => {
  await panel.locator('#check-page-btn').click();
  await panel.waitForTimeout(1500);
  report = await panel.locator('#modal-fields textarea').inputValue();

  const expected = [
    'Insert    ✓ #prompt-textarea (contenteditable)',
    'Attach    ✓ file input — input[type="file"][multiple], accept="image/*,video/*", multiple',
    'Capture   ✓ [data-message-author-role="assistant"] — 1 found',
    'Usage     ✓ "used 18 of your 40"',
  ];
  for (const line of expected) {
    if (!report.includes(line)) throw new Error(`missing "${line}". Report:\n${report}`);
  }
});

await run.step('the heading counts what is genuinely supported', async () => {
  const title = await panel.locator('#modal-title').innerText();
  if (title !== 'Page check — 1 of 1 fully supported') throw new Error(`title read "${title}"`);
});

await run.step('the report names the page and when it was taken', async () => {
  if (!report.includes('https://chatgpt.com/c/stand-in')) throw new Error('no URL in the report');
  if (!/\d{4}-\d{2}-\d{2}T/.test(report)) throw new Error('no timestamp in the report');
  if (!report.includes('Selectors tried')) throw new Error('the full selector list is missing');
});

await run.step('a page with no file input is reported honestly', async () => {
  await panel.locator('#modal-confirm-btn').click();
  await chat.setContent('<div id="prompt-textarea" contenteditable="true"></div>');
  await chat.waitForTimeout(400);

  await panel.locator('#check-page-btn').click();
  await panel.waitForTimeout(1200);
  const text = await panel.locator('#modal-fields textarea').inputValue();
  if (!text.includes('Attach    ✓ no file input; would paste onto the composer')) {
    throw new Error(`the fallback was not reported. Report:\n${text}`);
  }
  const title = await panel.locator('#modal-title').innerText();
  if (title !== 'Page check — 0 of 1 fully supported') throw new Error(`title read "${title}"`);
  await panel.locator('#modal-confirm-btn').click();
});

if (panel.collectedErrors.length) run.fail(`panel logged: ${panel.collectedErrors.join(' | ')}`);

await session.close();
run.finish();
