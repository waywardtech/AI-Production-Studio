// The studio's pure modules — job profiles, import parsing, generator
// targets — imported for real. They touch neither the DOM nor chrome,
// which is what makes them testable without a browser.
import { EXTENSION } from './paths.mjs';

const P = await import(new URL('studio/lib/prompt.js', EXTENSION));
const M = await import(new URL('studio/lib/model.js', EXTENSION));

let pass = 0;
let fail = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

console.log('--- #5 import: JSON shapes ---');
const bareArray = '[{"name":"Mara","category":"characters","description":"pilot"},{"name":"Hangar 9","category":"Location"}]';
eq(P.parseAssetList(P.parseJsonReply(bareArray)).map((a) => [a.name, a.category]),
  [['Mara', 'character'], ['Hangar 9', 'location']], 'bare array is read directly (was routed to a chat)');
eq(P.parseAssetList(P.parseJsonReply('{"assets":[{"name":"Truck","category":"vehicles"}]}')).map((a) => a.category),
  ['vehicle'], '{assets:[…]} with plural category');
eq(P.parseAssetList(P.parseJsonReply('{"characters":[{"name":"Mara"}],"locations":["Hangar 9"],"mood":[{"name":"Dusk"}]}'))
  .map((a) => [a.name, a.category]),
  [['Mara', 'character'], ['Hangar 9', 'location'], ['Dusk', 'mood']], 'grouped by kind, including bare strings');
eq(P.parseAssetList(P.parseJsonReply('{"scenes":[{"name":"Shot 1"}]}')), [], 'a scene list is not turned into assets');
eq(P.parseAssetList(P.parseJsonReply('Mara is the pilot. See note [1].')), [], 'plain notes are not mistaken for JSON');
eq(P.parseAssetList(P.parseJsonReply('Here you go:\n```json\n[{"name":"Prop gun","category":"props"}]\n```')).map((a) => a.category),
  ['prop'], 'fenced array from a chat reply');

console.log('\n--- #5 category normalisation ---');
for (const [raw, want] of [
  ['characters', 'character'], ['Character', 'character'], ['Mood / Lighting', 'mood'],
  ['lighting', 'mood'], ['Props', 'prop'], ['wardrobe', 'wardrobe'], ['spaceships', 'other'], ['', 'other'],
]) eq(P.normalizeCategory(raw), want, `"${raw}" -> ${want}`);

console.log('\n--- #4 profile defaults ---');
const freshScene = () => M.newScene('S');
{
  const s = freshScene();
  P.applyProfileDefaults(s, 'general');
  eq([s.shot.aspects.duration, s.shot.aspects.aspectRatio], ['8s', '16:9'], 'new scene gets General defaults');
  P.applyProfileDefaults(s, 'social-vertical', 'general');
  eq(s.shot.aspects.aspectRatio, '9:16', 'switching to Social vertical now sets 9:16 (was stuck on 16:9)');
}
{
  const s = freshScene();
  P.applyProfileDefaults(s, 'general');
  s.shot.aspects.aspectRatio = '2.39:1'; // typed by hand
  P.releaseFromProfile(s, 'aspectRatio');
  P.applyProfileDefaults(s, 'social-vertical', 'general');
  eq(s.shot.aspects.aspectRatio, '2.39:1', 'a hand-typed value survives a profile switch');
}
{
  const s = freshScene();
  P.applyProfileDefaults(s, 'establishing');
  eq([s.shot.aspects.motion, s.shot.aspects.negative], ['slow drift', 'dialogue, fast cuts'], 'Establishing fills motion + avoid');
  P.applyProfileDefaults(s, 'general', 'establishing');
  eq([s.shot.aspects.motion, s.shot.aspects.negative, s.shot.aspects.duration], ['', '', '8s'],
    "switching away clears values the old profile set that the new one doesn't");
}
{
  // Scenes saved before profileFilled existed.
  const legacy = freshScene();
  legacy.shot.aspects.duration = '8s';
  legacy.shot.aspects.aspectRatio = '16:9';
  legacy.shot.aspects.motion = 'crane up'; // not a General default: must be treated as Dan's
  delete legacy.shot.profileFilled;
  P.applyProfileDefaults(legacy, 'social-vertical', 'general');
  eq([legacy.shot.aspects.aspectRatio, legacy.shot.aspects.motion], ['9:16', 'crane up'],
    'legacy scene: exact default matches migrate, other values are left alone');
}
{
  const s = freshScene();
  P.applyProfileDefaults(s, 'general');
  const again = P.applyProfileDefaults(s, 'general', 'general');
  eq(again, 0, 're-applying the same profile changes nothing');
}

console.log('\n--- #8 target platforms ---');
eq(P.targetById('sora').platforms, ['sora', 'chatgpt'], 'Sora prefers its own page, then ChatGPT');
eq(P.targetById('veo').platforms, ['flow', 'gemini'], 'Veo prefers Flow, then Gemini');
eq(P.VIDEO_TARGETS.map((t) => t.label), ['Sora', 'Veo'], 'labels no longer promise sites that were unreachable');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
