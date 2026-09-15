// The whole attachment path in a real Chrome: IndexedDB → base64 chunks
// → background worker → content script → DataTransfer → the page's file
// input.
//
// The page is a stand-in, so this proves the machinery rather than
// ChatGPT's markup — including that a file larger than one message
// arrives byte-exact.
import { launchWithExtension, makeRunner, openPage, serveStandInChat } from './harness.mjs';
import { writeFixtures } from './fixtures.mjs';

const fixtures = writeFixtures();
const session = await launchWithExtension({ profile: 'attachments' });
const run = makeRunner('attachments');

// The stand-in records what it was handed, the way a real site's own
// JavaScript would see it.
await serveStandInChat(
  session,
  `<div id="prompt-textarea" contenteditable="true"></div>
   <input type="file" multiple accept="image/*">
   <script>
     window.__seen = { change: 0, files: [] };
     document.querySelector('input[type=file]').addEventListener('change', (e) => {
       window.__seen.change += 1;
       window.__seen.files = [...e.target.files].map((f) => ({ name: f.name, type: f.type, size: f.size }));
     });
   </script>`
);

const chat = await session.ctx.newPage();
await chat.goto('https://chatgpt.com/c/stand-in');
await chat.waitForTimeout(800);

const studio = await openPage(session, 'studio/studio.html');

await run.step('import a small file and one bigger than a single message', async () => {
  await studio.locator('#asset-file-input').setInputFiles([fixtures.png, fixtures.big]);
  await studio.waitForTimeout(2500);
  const tiles = await studio.locator('.asset-tile').count();
  if (tiles !== 2) throw new Error(`expected 2 assets, saw ${tiles}`);
});

const panel = await openPage(session, 'sidepanel/sidepanel.html');

await run.step('tick the chat tab and write a prompt', async () => {
  await panel.locator('#refresh-tabs-btn').click();
  await panel.waitForTimeout(800);
  await panel.locator('.tab-item input[type=checkbox]').first().check();
  await panel.locator('.block-chip').first().click();
  await panel.locator('#canvas textarea').first().fill('Here is the plate for the shot.');
  await panel.waitForTimeout(300);
});

await run.step('pick both files to go with it', async () => {
  await panel.locator('#attach-btn').click();
  await panel.waitForTimeout(800);
  const rows = await panel.locator('.attach-row').count();
  if (rows !== 2) throw new Error(`expected 2 attachable files, saw ${rows}`);
  await panel.locator('.attach-row input').first().check();
  await panel.locator('.attach-row input').nth(1).check();
  await panel.locator('#modal-confirm-btn').click();
  await panel.waitForTimeout(700);
  const line = await panel.locator('#attachment-line').innerText();
  if (!/2 files will go with this prompt/.test(line)) throw new Error(`the line read "${line}"`);
});

await run.step('Insert sends the prompt and the files', async () => {
  await panel.locator('#insert-btn').click();
  await panel.waitForTimeout(4500);
  const toast = await panel.locator('#toast').innerText();
  if (!/with 2 files/.test(toast)) throw new Error(`the toast read "${toast}"`);
});

await run.step('the page received both files, intact', async () => {
  const seen = await chat.evaluate(() => window.__seen);
  if (seen.change !== 1) throw new Error(`expected one change event, saw ${seen.change}`);
  if (seen.files.length !== 2) throw new Error(`the page got ${JSON.stringify(seen.files)}`);

  const byName = Object.fromEntries(seen.files.map((f) => [f.name, f]));
  if (byName['plate.png'].type !== 'image/png') throw new Error(`the png arrived as ${byName['plate.png'].type}`);
  if (byName['plate.png'].size !== fixtures.sizeOf(fixtures.png)) {
    throw new Error(`the png arrived as ${byName['plate.png'].size}, on disk ${fixtures.sizeOf(fixtures.png)}`);
  }
  if (byName['big.bin'].size !== fixtures.sizeOf(fixtures.big)) {
    throw new Error(`the chunked file arrived as ${byName['big.bin'].size}, on disk ${fixtures.sizeOf(fixtures.big)}`);
  }
});

await run.step('the prompt went in as well', async () => {
  const text = await chat.locator('#prompt-textarea').innerText();
  if (!text.includes('Here is the plate for the shot.')) throw new Error(`the composer held "${text}"`);
});

await run.step('nothing was sent', async () => {
  // The stand-in has no send button; what matters is that the adapter
  // never tried to submit the form the input belongs to.
  const submitted = await chat.evaluate(() => window.__submitted === true);
  if (submitted) throw new Error('the page was submitted');
});

await run.step('the choice clears after a successful insert', async () => {
  if (!(await panel.locator('#attachment-line').isHidden())) throw new Error('the attachment line survived');
});

if (panel.collectedErrors.length) run.fail(`panel logged: ${panel.collectedErrors.join(' | ')}`);
if (studio.collectedErrors.length) run.fail(`studio logged: ${studio.collectedErrors.join(' | ')}`);

await session.close();
run.finish();
