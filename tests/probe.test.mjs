// The page check (M5-5): what the adapter reports about a page, and how
// that reads once formatted.
//
// The point of this feature is to turn "these selectors are unverified"
// into a dated record of what actually matched, so the tests are about
// the report being honest — particularly that a page which can't take an
// attachment is never described as if it can.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EXTENSION } from './paths.mjs';
import { makeChecker } from './fake-chrome.mjs';

const SRC = readFileSync(new URL('content-scripts/chat-adapter.js', EXTENSION), 'utf8');
const { eq, done } = makeChecker();

const fmt = await import(new URL('shared/probe-format.js', EXTENSION));

// A DOM stub with enough shape for the probe: elements answer
// getAttribute, and selectors return the lists the test sets up.
function probe(hostname, dom = {}, bodyText = '') {
  const context = {
    location: { hostname, href: `https://${hostname}/c/1` },
    document: {
      title: 'a chat',
      body: { innerText: bodyText },
      querySelector: (sel) => (dom[sel] || [])[0] || null,
      querySelectorAll: (sel) => dom[sel] || [],
      execCommand: () => true,
    },
    window: { getSelection: () => ({ toString: () => '' }), HTMLTextAreaElement: { prototype: {} } },
    Event: class {},
    chrome: { runtime: { onMessage: { addListener() {} } } },
    console,
  };
  vm.createContext(context);
  vm.runInContext(SRC, context);
  return context.probePage();
}

const el = (tag, attrs = {}) => ({
  tagName: tag.toUpperCase(),
  id: attrs.id || '',
  disabled: !!attrs.disabled,
  multiple: !!attrs.multiple,
  getAttribute: (name) => (name in attrs ? String(attrs[name]) : null),
  scrollIntoView() {},
  focus() {},
  querySelector: () => null,
  innerText: attrs.innerText || '',
});

console.log('--- what the probe sees ---');
{
  const report = probe('chatgpt.com', {
    '#prompt-textarea': [el('div', { id: 'prompt-textarea' })],
    'input[type="file"][multiple]': [el('input', { accept: 'image/*', multiple: true })],
    '[data-message-author-role="assistant"]': [el('div'), el('div')],
  });

  eq(report.success, true, 'a supported page reports');
  eq(report.platform.id, 'chatgpt', 'and names the platform');
  eq(report.input.kind, 'contenteditable', "the input's kind is what injection would use");
  eq(report.input.selector, '#prompt-textarea', 'and the selector that found it');
  eq(report.attachPlan, 'file-input', 'a usable file input means attaching goes through it');
  eq([report.fileInput.count, report.fileInput.usable], [1, 1], 'counted, with how many are usable');
  eq([report.fileInput.first.accept, report.fileInput.first.multiple], ['image/*', true], 'and described');
  eq(report.assistantFound, true, 'replies matched');
}

{
  // A disabled file input is not a usable one: the plan must fall back
  // rather than claim an attach path that would throw.
  const report = probe('claude.ai', {
    'div[contenteditable="true"].ProseMirror': [el('div')],
    'input[type="file"]': [el('input', { disabled: true })],
  });
  eq(report.fileTried.find((t) => t.count > 0).usable, 0, 'a disabled input counts as unusable');
  eq(report.attachPlan, 'paste', 'so the plan falls back to pasting');
}

{
  const report = probe('gemini.google.com', {});
  eq([report.input, report.attachPlan], [null, 'none'], 'a page with nothing found says so plainly');
}

{
  const report = probe('example.com');
  eq([report.success, report.reason], [false, 'Edge Studio does not handle this site.'], 'an unhandled site is refused');
}

{
  // Sora has no conversation to read; the report shouldn't treat that
  // as a failure.
  const report = probe('sora.chatgpt.com', { textarea: [el('textarea')] });
  eq(report.platform.kind, 'generator', 'a generator page is marked as one');
  eq(fmt.captureSummary(report), '— generator page — nothing to capture', 'and capture is not counted against it');
}

console.log('\n--- how it reads ---');
{
  const report = probe('chatgpt.com', {
    '#prompt-textarea': [el('div', { id: 'prompt-textarea' })],
    'input[type="file"][multiple]': [el('input', { accept: 'image/*', multiple: true })],
    '[data-message-author-role="assistant"]': [el('div')],
  }, '12 messages remaining');

  eq(fmt.insertSummary(report), '✓ #prompt-textarea (contenteditable)', 'insert line');
  eq(fmt.attachSummary(report), '✓ file input — input[type="file"][multiple], accept="image/*", multiple',
    'attach line names the element it would use');
  eq(fmt.usageSummary(report), '✓ "12 messages remaining"', 'usage line quotes what it found');
  eq(fmt.probeIsClean(report), true, 'everything resolved, so the page counts as verified');

  const text = fmt.formatProbe(report, { tabLabel: 'Writer' });
  eq(text.split('\n')[0], 'Page check — ChatGPT (Writer)', 'headed with the platform and the tab label');
  eq(text.includes('https://chatgpt.com/c/1'), true, 'and the URL, so the record says which page');
  eq(text.includes('Selectors tried'), true, 'the full list is kept, not just the winner');
}

{
  const report = probe('gemini.google.com', {});
  eq(fmt.probeIsClean(report), false, 'a page where nothing resolved is not clean');
  eq(fmt.attachSummary(report), '✗ nowhere to put a file — Attach would fail and say so',
    'and the attach line says what would happen, not what should');
}

{
  const failed = { success: false, reason: 'No answer from the page.', url: 'https://x/y' };
  eq(fmt.formatProbe(failed, { tabLabel: 'Dead tab' }).includes('No answer from the page.'), true,
    'a tab that did not answer is reported as itself');
  eq(fmt.probeIsClean(failed), false, 'and is never counted as verified');
}

{
  const a = probe('chatgpt.com', { '#prompt-textarea': [el('div')] });
  const b = probe('claude.ai', { 'div[contenteditable="true"].ProseMirror': [el('div')] });
  const joined = fmt.formatProbes([{ report: a, tabLabel: 'One' }, { report: b, tabLabel: 'Two' }]);
  eq(joined.split('---').length, 2, 'several pages come out as one copyable record');
}

done();
