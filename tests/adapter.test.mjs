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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
