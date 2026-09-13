// Seeds a production the way an earlier build would have saved it —
// including a legacy { kind: 'clip' } out-box entry (issue #7) and
// scenes with no `profileFilled` (issue #4 migration).
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
})();
