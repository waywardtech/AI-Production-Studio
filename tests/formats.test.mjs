// Tab naming and the Google Docs formats — the pure rules both pages
// and the sync engine rely on.
import { installFakeChrome, makeChecker } from './fake-chrome.mjs';
import { EXTENSION } from './paths.mjs';

installFakeChrome();
const tabs = await import(new URL('shared/tabs.js', EXTENSION));
const fmt = await import(new URL('shared/docs-format.js', EXTENSION));
const { eq, done } = makeChecker();

console.log('--- tab names are the same on every page ---');
const chat = { id: 1, title: 'Weekly planning', platformLabel: 'ChatGPT', kind: 'chat' };
eq(tabs.tabName(chat), 'ChatGPT · Weekly planning', 'platform and page title');
eq(tabs.tabName({ ...chat, label: 'Client X' }), 'ChatGPT · Client X', 'a session label replaces the title');
eq(tabs.tabName({ id: 2, title: 'Sora', platformLabel: 'Sora', kind: 'generator' }), 'Sora tab', 'a title that repeats the platform isn’t shown twice');
eq(tabs.tabShortName({ id: 2, title: '', platformLabel: 'Flow' }), 'Flow', 'short name falls back to the platform');
eq([tabs.isChatTab(chat), tabs.isChatTab({ kind: 'generator' })], [true, false], 'generator pages are not chats');

console.log('\n--- prompt Docs round-trip ---');
const blockTypes = [{ id: 'scenario', label: 'Scenario' }, { id: 'ask', label: 'Ask' }, { id: 'guard', label: 'Guard Rails' }];
const prompt = {
  title: 'Brief', status: 'Draft', tags: ['apex'],
  blocks: [{ id: 'a', type: 'scenario', text: 'Launch week.' }, { id: 'b', type: 'guard', text: 'No jargon.\nKeep it short.' }],
};
const doc = fmt.promptToDoc(prompt, blockTypes);
eq([doc.name, doc.description], ['Brief', 'Edge Studio prompt · Status: Draft · Tags: apex'], 'name and searchable description');
eq(fmt.docToPromptBlocks(doc.text, prompt, blockTypes).map((b) => [b.id, b.type, b.text]),
  [['a', 'scenario', 'Launch week.'], ['b', 'guard', 'No jargon.\nKeep it short.']],
  'an untouched Doc reads back to the same blocks, multi-line text and custom types included');

const googleExport = '\uFEFF' + doc.text.replace('Launch week.', 'Launch week, edited.').replace(/\n/g, '\r\n');
eq(fmt.docToPromptBlocks(googleExport, prompt, blockTypes)[0].text, 'Launch week, edited.',
  "Google's export (byte-order mark, CRLF) reads back cleanly");
eq(fmt.docToPromptBlocks('Brief\nno headings at all', prompt, blockTypes), null, 'no headings means no change, not an empty prompt');
eq(fmt.docToPromptBlocks('[Tone of Voice]\nwarm', prompt, blockTypes)[0].type, 'tone-of-voice', 'an unknown heading keeps its own name as the type');

console.log('\n--- reply and document Docs ---');
const reply = {
  title: 'Hooks', text: 'One.\nTwo.', status: 'Draft', tags: [], capturedAt: '2026-09-12T10:30:00.000Z',
  source: { platform: 'ChatGPT', tabLabel: 'Writer', url: 'https://chatgpt.com/c/1' },
};
const replyDoc = fmt.replyToDoc(reply);
eq(replyDoc.text.split('\n').slice(0, 3), ['Hooks', 'From: ChatGPT — Writer', 'Source: https://chatgpt.com/c/1'],
  'a reply Doc says where it came from');
eq(fmt.docToReplyText(replyDoc.text), 'One.\nTwo.', 'only the reply text is read back, not the header');
eq(fmt.docToDocumentText('\uFEFFINT. HANGAR\r\n'), 'INT. HANGAR', 'a script Doc is its text');

console.log('\n--- shot list Docs ---');
const production = {
  name: 'Opening', status: 'Draft',
  scenes: [{ id: 's1', name: 'Alpha' }, { id: 's2', name: 'Bravo' }],
  sequences: [{ name: 'Takeoff', sceneIds: ['s1', 's2'] }],
};
const shotDoc = fmt.productionToDoc(production, { assembleShot: (s) => `shot ${s.name}`, targetLabel: 'Sora', profileLabel: 'General shot' });
eq([shotDoc.name, shotDoc.text.includes('Takeoff: Alpha → Bravo'), shotDoc.text.includes('02 · Bravo\n\nshot Bravo')],
  ['Opening — shot list', true, true], 'shot list names sequences and numbers every shot');
eq(shotDoc.text.includes('Edits made here are not read back'), true, 'and says it is generated, one way');

done();
