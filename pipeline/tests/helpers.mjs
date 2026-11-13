// Shared by the pipeline tests: a checker, and a small film to work on.
import { createStudio } from '../src/studio.mjs';
import { createAdapters } from '../src/adapters.mjs';

export function makeChecker() {
  let pass = 0;
  let fail = 0;
  const eq = (got, want, label) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  };
  const done = () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  };
  return { eq, done };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A studio wired for tests: no backoff worth waiting for, short timeouts.
export function testStudio({ faults = null, store, queueOptions = {} } = {}) {
  const adapters = createAdapters({ faults });
  let seed = 1000;
  const studio = createStudio({
    ...(store ? { store } : {}),
    adapters,
    randomSeed: () => ++seed,
    queueOptions: { backoffMs: () => 5, timeoutMs: 400, heartbeatMs: 20, ...queueOptions },
  });
  return { studio, adapters };
}

// Two characters, a location, a look, a format; one scene, three shots.
export function seedFilm(studio) {
  const sheet = (label) => studio.addVaultAsset({ label, content: `<svg xmlns="http://www.w3.org/2000/svg"><title>${label}</title></svg>` });
  const wes = studio.createEntity({ kind: 'character', name: 'Wes', fields: { trigger: 'WES_V1', description: 'lean man in his forties, sun-worn', wardrobe: 'canvas jacket' }, referenceAssetIds: [sheet('Wes turnaround').id] });
  const ana = studio.createEntity({ kind: 'character', name: 'Ana', fields: { trigger: 'ANA_V1', description: 'woman in her thirties, short dark hair', wardrobe: 'grey coveralls' }, referenceAssetIds: [sheet('Ana turnaround').id] });
  const hangar = studio.createEntity({ kind: 'location', name: 'Hangar', fields: { description: 'a disused aircraft hangar, corrugated walls', lighting: 'shafts of low sun through high windows' }, referenceAssetIds: [sheet('Hangar plate').id] });
  const look = studio.createEntity({ kind: 'look', name: 'House look', fields: { description: 'bleached 70s anamorphic, heavy grain', lut: 'Kodak 2383', negative: 'text, watermark' } });
  const format = studio.createEntity({ kind: 'format', name: 'Delivery', fields: { aspectRatio: '2.39:1' } });
  const scene = studio.createScene({ name: 'Hangar at dawn', beat: 'Wes finds the truck', locationId: hangar.id, timeOfDay: 'dawn', lighting: 'low warm sun' });
  const shots = [
    studio.createShot({ sceneId: scene.id, name: '1A wide', kind: 'frame', notes: 'Wes walks in through the open door', camera: 'wide, 35mm, locked off', characterIds: [wes.id] }),
    studio.createShot({ sceneId: scene.id, name: '1B two-shot', kind: 'frame', notes: 'Wes and Ana face each other across the truck bonnet', camera: 'medium two-shot', characterIds: [wes.id, ana.id] }),
    studio.createShot({ sceneId: scene.id, name: '1C move', kind: 'video', notes: 'Ana circles the truck, inspecting it', camera: 'slow dolly left', characterIds: [ana.id], durationS: 6 }),
  ];
  return { wes, ana, hangar, look, format, scene, shots };
}
