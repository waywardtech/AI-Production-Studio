// Seeds storage exactly as a pre-projects build (schema v1) left it: the
// prompt library and replies as arrays, and a production carrying its
// own assets, in-box and out-box — including a legacy { kind: 'clip' }
// out-box entry and scenes with no `profileFilled`. Loading any page
// with ?seed should migrate all of it into "My first project".
(() => {
  if (!location.search.includes('seed')) return;
  const thumb =
    'data:image/svg+xml;base64,' +
    btoa('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#4d6bff"/></svg>');
  const aspects = () => ({
    timeOfDay: '', atmosphere: '', look: '', lighting: '', exposure: '',
    camera: '', motion: '', duration: '8s', aspectRatio: '16:9', negative: '',
  });
  const scene = (id, name, text) => ({
    id, name, seed: `${name} seed`, status: 'Draft', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    blocks: [
      { id: `${id}-b1`, type: 'location', text },
      { id: `${id}-b2`, type: 'scene', text: `${name} action` },
    ],
    shot: { stillAssetId: null, aspects: aspects() },
    assetIds: [], refinements: [], renders: [], expansions: 0,
  });
  const production = {
    id: 'prd-1', name: 'Apex opening', status: 'Draft', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    target: 'sora', profile: 'general',
    scenes: [scene('scn-a', 'Alpha', 'Hangar'), scene('scn-b', 'Bravo', 'Runway'), scene('scn-c', 'Charlie', 'Tower')],
    sequences: [{ id: 'seq-1', name: 'Takeoff', sceneIds: ['scn-a', 'scn-b', 'scn-c'] }],
    assets: [{
      id: 'ast-1', name: 'Hangar still', category: 'location', description: 'Grey hangar', sourceUrl: '',
      thumb, origin: 'upload', fileRef: null, tags: [], addedAt: '2026-09-01T00:00:00Z',
    }],
    inbox: [],
    outbox: [
      { id: 'out-legacy', kind: 'clip', renderId: 'rnd-gone', sceneId: 'scn-deleted', title: 'Ghost', url: '', at: '2026-09-01T00:00:00Z' },
      { id: 'out-report', kind: 'report', title: 'Dailies — old', body: '# old', at: '2026-09-01T00:00:00Z' },
    ],
  };
  window.__mem.local.productions = [production];
  window.__mem.local.activeProductionId = 'prd-1';
  window.__mem.local.library = [
    { id: 'prompt-apex', title: 'Apex brief', blocks: [{ id: 'b1', type: 'ask', text: 'summarise <project> for <client>' }], tags: ['apex', 'work'], status: 'Draft', createdAt: '2026-08-01T00:00:00Z' },
    { id: 'prompt-loose', title: 'Loose note', blocks: [{ id: 'b2', type: 'scenario', text: 'a loose note' }], tags: [], status: 'Draft', createdAt: '2026-08-02T00:00:00Z' },
  ];
  window.__mem.local.responses = [
    { id: 'response-1', title: 'Wardrobe notes', text: 'Canvas jacket, worn boots.', status: 'Draft',
      source: { platform: 'ChatGPT', tabLabel: 'Wardrobe', url: 'https://chatgpt.com/c/x', kind: 'latest' },
      capturedAt: '2026-08-03T00:00:00Z', savedAt: '2026-08-03T00:01:00Z' },
  ];
  window.__mem.local.variableValues = { client: 'Acme' };
})();
