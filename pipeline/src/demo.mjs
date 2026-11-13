// A small film to open the studio on, so the first thing a creator sees
// is a working pipeline rather than an empty one.

const sheet = (label, hue) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="hsl(${hue} 30% 20%)"/><circle cx="50" cy="40" r="18" fill="hsl(${hue} 50% 55%)"/><circle cx="105" cy="40" r="18" fill="hsl(${hue} 50% 45%)"/><text x="6" y="82" font-family="monospace" font-size="9" fill="#fff">${label}</text></svg>`;

export function seedDemo(studio) {
  const asset = (label, hue) => studio.addVaultAsset({ label, content: sheet(label, hue) }).id;
  const wes = studio.createEntity({ kind: 'character', name: 'Wes', fields: { trigger: 'WES_V1', description: 'lean man in his forties, sun-worn face', wardrobe: 'canvas jacket' }, referenceAssetIds: [asset('Wes — turnaround', 28)] });
  const ana = studio.createEntity({ kind: 'character', name: 'Ana', fields: { trigger: 'ANA_V1', description: 'woman in her thirties, short dark hair', wardrobe: 'grey coveralls' }, referenceAssetIds: [asset('Ana — turnaround', 200)] });
  const truck = studio.createEntity({ kind: 'prop', name: 'The truck', fields: { trigger: 'rusted 1970s flatbed truck' }, referenceAssetIds: [asset('Truck — prop card', 10)] });
  const hangar = studio.createEntity({ kind: 'location', name: 'Hangar', fields: { description: 'a disused aircraft hangar, corrugated walls', lighting: 'shafts of low sun through high windows' }, referenceAssetIds: [asset('Hangar — plate', 45)] });
  const range = studio.createEntity({ kind: 'location', name: 'Front Range road', fields: { description: 'an empty two-lane road under big sky, mountains behind' }, referenceAssetIds: [asset('Road — plate', 120)] });
  studio.createEntity({ kind: 'look', name: 'House look', fields: { description: 'bleached 70s anamorphic, heavy grain', lut: 'Kodak 2383', negative: 'text, watermark' } });
  studio.createEntity({ kind: 'format', name: 'Delivery format', fields: { aspectRatio: '2.39:1' } });

  const one = studio.createScene({ name: '1 · Hangar at dawn', beat: 'Wes finds the truck', locationId: hangar.id, timeOfDay: 'dawn', lighting: 'low warm sun' });
  const two = studio.createScene({ name: '2 · The road out', beat: 'They leave together', locationId: range.id, timeOfDay: 'late afternoon', lighting: 'hard side light' });

  studio.createShot({ sceneId: one.id, name: '1A wide', kind: 'frame', notes: 'Wes walks in through the open door and stops', camera: 'wide, 35mm, locked off', characterIds: [wes.id], durationS: 4 });
  studio.createShot({ sceneId: one.id, name: '1B the truck', kind: 'frame', notes: 'Wes rests a hand on the bonnet', camera: 'medium, low angle', characterIds: [wes.id], propIds: [truck.id], durationS: 3 });
  studio.createShot({ sceneId: one.id, name: '1C Ana arrives', kind: 'video', notes: 'Ana circles the truck, inspecting it, stunning 8k, no smoke', camera: 'slow dolly left', characterIds: [ana.id], propIds: [truck.id], durationS: 6 });
  studio.createShot({ sceneId: two.id, name: '2A two-shot', kind: 'frame', notes: 'Wes and Ana in the cab, not speaking', camera: 'two-shot through the windscreen', characterIds: [wes.id, ana.id], durationS: 5 });
  studio.createShot({ sceneId: two.id, name: '2B drive off', kind: 'video', notes: 'The truck pulls away down the road', camera: 'static wide, long lens', characterIds: [], propIds: [truck.id], durationS: 8 });
}
