// Runs the real content script in a sandbox with a fake DOM, so host
// matching, selector fallback and the capture/usage parsers can be
// checked without a browser. Selectors against live sites stay
// unverified; what's tested is the logic around them.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { EXTENSION } from './paths.mjs';

const SRC = readFileSync(new URL('content-scripts/chat-adapter.js', EXTENSION), 'utf8');

function makeContext(hostname, dom = {}, selectionText = '', bodyText = '') {
  const el = (text) => ({ innerText: text, querySelector: () => null, scrollIntoView() {}, focus() {}, tagName: 'DIV' });
  const lookup = (sel) => (dom[sel] || []).map((t) => (typeof t === 'string' ? el(t) : t));
  const context = {
    location: { hostname, href: `https://${hostname}/x` },
    document: {
      title: 'stub',
      body: { innerText: bodyText },
      querySelector: (sel) => lookup(sel)[0] || null,
      querySelectorAll: (sel) => lookup(sel),
      execCommand: () => true,
    },
    window: {
      getSelection: () => ({ toString: () => selectionText }),
      HTMLTextAreaElement: { prototype: Object.defineProperty({}, 'value', { set(v) { this._value = v; }, get() { return this._value; } }) },
    },
    Event: class { constructor(type) { this.type = type; } },
    DragEvent: class { constructor(type, init = {}) { this.type = type; this.dataTransfer = init.dataTransfer; } },
    ClipboardEvent: class { constructor(type, init = {}) { this.type = type; this.clipboardData = init.clipboardData; } },
    // Enough of DataTransfer/File/Blob to see what the page would be handed.
    DataTransfer: class { constructor() { this.items = { add: (f) => this._files.push(f) }; this._files = []; } get files() { return this._files; } },
    Blob: class { constructor(parts = [], opts = {}) { this.parts = parts; this.type = opts.type || ''; } },
    File: class { constructor(parts = [], name = '', opts = {}) { this.parts = parts; this.name = name; this.type = opts.type || ''; } },
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    Uint8Array,
    chrome: { runtime: { onMessage: { addListener() {} } } },
    console,
  };
  vm.createContext(context);
  vm.runInContext(SRC, context);
  return context;
}

let pass = 0;
let fail = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

console.log('--- platform detection ---');
for (const [host, want] of [
  ['chatgpt.com', 'chatgpt'], ['chat.openai.com', 'chatgpt'], ['www.chatgpt.com', 'chatgpt'],
  ['claude.ai', 'claude'], ['gemini.google.com', 'gemini'],
  ['sora.chatgpt.com', 'sora'], ['labs.google', 'flow'],
]) eq(makeContext(host).currentPlatform()?.id, want, `${host} -> ${want}`);
eq(makeContext('example.com').currentPlatform(), null, 'unknown host -> null');
eq(makeContext('notclaude.ai').currentPlatform(), null, 'lookalike host not matched by suffix');

console.log('\n--- generator pages ---');
eq(makeContext('sora.chatgpt.com').captureLatestResponse().reason,
  "Sora is a generator page — there's no reply there to capture.", 'Sora refuses capture with a clear reason');
eq(makeContext('labs.google', { textarea: [{ tagName: 'TEXTAREA', scrollIntoView() {}, dispatchEvent() {} }] })
  .injectPrompt('a shot').platformLabel, 'Flow', 'Flow takes an Insert via its textarea');

console.log('\n--- chats still capture ---');
eq(makeContext('claude.ai', { '[data-testid="assistant-message"]': ['a', 'b'] }).captureLatestResponse().text, 'b',
  'Claude: latest of preferred selector');
{
  const userTurn = { innerText: 'q', querySelector: (s) => (s.includes('user') ? {} : null) };
  const botTurn = { innerText: 'answer', querySelector: () => null };
  eq(makeContext('chatgpt.com', { 'article[data-testid^="conversation-turn-"]': [userTurn, botTurn] })
    .captureLatestResponse().text, 'answer', 'ChatGPT: turn fallback skips user turns');
}

console.log('\n--- usage scrape ---');
const usage = (host, text) => makeContext(host, {}, '', text).captureUsage();
eq(usage('claude.ai', '12 messages remaining until 4pm').remaining, 12, '"N messages remaining"');
eq([usage('chatgpt.com', 'You have used 18 of your 40 messages').used, usage('chatgpt.com', 'You have used 18 of your 40 messages').limit], [18, 40], '"used N of your M"');
eq(usage('claude.ai', 'The 12 apostles and 40 days').success, false, 'bare numbers are not quota');

console.log('\n--- attaching files ---');
{
  // A page with a file input: the files should be handed to it, which is
  // the closest thing to Dan having clicked the paperclip himself.
  const input = { disabled: false, files: null, dispatched: [], dispatchEvent(e) { this.dispatched.push(e.type); return true; } };
  const ctx = makeContext('chatgpt.com', { 'input[type="file"][multiple]': [input] });

  ctx.beginTransfer('tx1', [{ name: 'plate.png', type: 'image/png' }]);
  // "hello" in base64, split the way a real transfer would arrive.
  ctx.addChunk('tx1', 0, Buffer.from('hel').toString('base64'));
  ctx.addChunk('tx1', 0, Buffer.from('lo').toString('base64'));
  const result = ctx.commitTransfer('tx1');

  eq([result.success, result.method, result.count], [true, 'file-input', 1], 'the file input gets the files');
  eq(input.dispatched, ['input', 'change'], 'and is told the value changed, so React sees it');
  eq(input.files.length, 1, 'one file handed over');
  eq([input.files[0].name, input.files[0].type], ['plate.png', 'image/png'], 'with its name and type intact');
  eq(input.files[0].parts[0].parts.length, 2, 'assembled from both chunks');

  eq(ctx.commitTransfer('tx1').success, false, 'a committed transfer is gone — a repeat is refused');
  eq(ctx.addChunk('nope', 0, 'AA==').reason, 'That transfer is not open.', 'chunks for an unknown transfer are refused');
  eq(ctx.addChunk('tx1', 0, 'AA==').success, false, 'and so are chunks after commit');
}

{
  // No file input: fall back to a paste onto the composer.
  const composer = { tagName: 'DIV', focus() {}, scrollIntoView() {}, dispatched: [], dispatchEvent(e) { this.dispatched.push(e); return true; } };
  const ctx = makeContext('claude.ai', { 'div[contenteditable="true"].ProseMirror': [composer] });
  ctx.beginTransfer('tx2', [{ name: 'ref.jpg', type: 'image/jpeg' }]);
  ctx.addChunk('tx2', 0, Buffer.from('x').toString('base64'));
  const result = ctx.commitTransfer('tx2');
  eq([result.success, result.method], [true, 'paste'], 'falls back to pasting into the composer');
  eq(composer.dispatched.map((e) => e.type), ['paste'], 'one paste event');
  eq(composer.dispatched[0].clipboardData.files.length, 1, 'carrying the file');
}

{
  // Nowhere to put it: say so rather than claiming success.
  const ctx = makeContext('gemini.google.com');
  ctx.beginTransfer('tx3', [{ name: 'a.png', type: 'image/png' }]);
  ctx.addChunk('tx3', 0, 'AA==');
  const result = ctx.commitTransfer('tx3');
  eq(result.success, false, 'a page with no input and no composer fails');
  eq(/attach it by hand/i.test(result.reason), true, 'and says what to do instead');
}

{
  eq(makeContext('example.com').attachFiles([{ name: 'a.png' }]).reason,
    'Edge Studio does not handle this site.', 'an unknown site is refused');
  // The site check comes first, so the empty case needs a site we handle.
  eq(makeContext('chatgpt.com').attachFiles([]).reason, 'No files to attach.', 'an empty batch is refused');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
