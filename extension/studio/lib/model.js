// Module 4 data model (M4-2): the shapes the pipeline stores, and the
// vocabularies the three columns are built from.
//
// Pure — no DOM, no chrome. Everything here is either a constant list
// or a factory.
//
//   project → productions → scenes → blocks (the running order)
//                                  → shot (the still and its aspects)
//                                  → renders (what came back)
//                         → sequences (named, ordered bundles of scenes)
//           → assets     (the pool column 1 draws from — shared by every
//                         production in the project)
//           → documents  (in-box scripts and notes, out-box reports —
//                         each tagged with the production it belongs to)
//
// Productions, assets and documents are each their own record in the
// shared store (shared/store.js), rather than assets and boxes living
// inside the production.

import { newId, nowISO } from '../../shared/store.js';

export { STATUSES } from '../../shared/model.js';
export { newId };

// Column 2's block types. The first four are the ones on the sketch and
// are what a new scene starts with; the rest are there to be added.
export const BLOCK_TYPES = [
  { id: 'location', label: 'Location', hint: 'Where this happens — the real place' },
  { id: 'setting', label: 'Setting', hint: 'The world and the moment: era, weather, season' },
  { id: 'scene', label: 'Scene / Action', hint: 'What actually happens in the shot' },
  { id: 'set-dressing', label: 'Set Dressing', hint: 'What fills the frame around the action' },
  { id: 'characters', label: 'Characters', hint: 'Who is in frame, and how they look' },
  { id: 'wardrobe', label: 'Wardrobe', hint: 'What they are wearing' },
  { id: 'dialogue', label: 'Dialogue', hint: 'Spoken lines, with who says them' },
  { id: 'camera', label: 'Camera', hint: 'Framing, lens, and how the camera moves' },
  { id: 'sound', label: 'Sound', hint: 'Ambience, effects, music' },
  { id: 'transition', label: 'Transition', hint: 'How this shot leaves and the next arrives' },
];

export const STARTING_BLOCK_TYPES = ['location', 'setting', 'scene', 'set-dressing'];

// Column 3. The first five are the sketch's refine card; the rest are
// the mechanical settings a generator needs, kept behind "More" so the
// card stays the shape it was drawn as.
export const ASPECTS = [
  { id: 'timeOfDay', label: 'Time of day', placeholder: 'golden hour, 20 minutes before sunset' },
  { id: 'atmosphere', label: 'Atmosphere', placeholder: 'still, heavy, dust hanging in the air' },
  { id: 'look', label: 'Look', placeholder: 'bleached 70s anamorphic, heavy grain' },
  { id: 'lighting', label: 'Lighting', placeholder: 'hard low sun from camera left, deep shadow' },
  { id: 'exposure', label: 'Exposure', placeholder: 'protect the highlights, let the shadows crush' },
  { id: 'camera', label: 'Camera & lens', placeholder: '35mm, chest height, slight low angle', advanced: true },
  { id: 'motion', label: 'Camera motion', placeholder: 'slow push in, handheld', advanced: true },
  { id: 'duration', label: 'Duration', placeholder: '8s', advanced: true },
  { id: 'aspectRatio', label: 'Aspect ratio', placeholder: '16:9', advanced: true },
  { id: 'negative', label: 'Avoid', placeholder: 'text on screen, warped hands, cuts', advanced: true },
];

export const ASSET_CATEGORIES = [
  { id: 'location', label: 'Location' },
  { id: 'character', label: 'Character' },
  { id: 'wardrobe', label: 'Wardrobe' },
  { id: 'vehicle', label: 'Vehicle' },
  { id: 'prop', label: 'Prop' },
  { id: 'mood', label: 'Mood / Lighting' },
  { id: 'audio', label: 'Audio' },
  { id: 'script', label: 'Script' },
  { id: 'other', label: 'Other' },
];

// What an import can bring in (M4-17), mapped onto the categories above
// so imported material lands in the same pool as everything else.
export const IMPORT_KINDS = [
  { id: 'characters', label: 'Characters', category: 'character' },
  { id: 'locations', label: 'Locations', category: 'location' },
  { id: 'wardrobe', label: 'Wardrobe', category: 'wardrobe' },
  { id: 'vehicles', label: 'Vehicles', category: 'vehicle' },
  { id: 'props', label: 'Props', category: 'prop' },
  { id: 'mood', label: 'Mood / Lighting', category: 'mood' },
];

export const RENDER_VERDICTS = ['pending', 'keep', 'reject', 'regen'];


export function newBlock(type, text = '') {
  return { id: newId('blk'), type, text };
}

export function emptyAspects() {
  return Object.fromEntries(ASPECTS.map((a) => [a.id, '']));
}

export function newScene(name = 'Untitled scene', seed = '') {
  return {
    id: newId('scn'),
    name,
    seed,
    status: 'Draft',
    createdAt: nowISO(),
    updatedAt: nowISO(),
    blocks: STARTING_BLOCK_TYPES.map((type) => newBlock(type)),
    shot: { stillAssetId: null, aspects: emptyAspects() },
    assetIds: [],
    refinements: [], // { id, text, at } — the chat-to-refine log
    renders: [], // { id, target, profile, prompt, url, notes, verdict, at }
    expansions: 0, // how many seed passes this scene has been through
  };
}

// An asset is a reference, never a copy of the bytes (spec decision #1
// and #14): a source URL, a small thumbnail for the grid, and enough
// text for the prompt to describe it.
export function newAsset(fields = {}) {
  return {
    id: newId('ast'),
    projectId: fields.projectId || null,
    name: fields.name || 'Untitled asset',
    category: fields.category || 'other',
    description: fields.description || '',
    sourceUrl: fields.sourceUrl || '',
    thumb: fields.thumb || null, // data URL, downscaled
    origin: fields.origin || 'manual', // manual | upload | web | drive | imported | described
    fileRef: fields.fileRef || null, // { name, size, type } for a dropped file
    tags: fields.tags || [],
  };
}

export function newProduction({ projectId, name = 'Untitled production' } = {}) {
  const scene = newScene('Scene 1');
  return {
    id: newId('prd'),
    projectId,
    name,
    status: 'Draft',
    target: 'sora',
    profile: 'general',
    scenes: [scene],
    sequences: [], // { id, name, sceneIds: [] }
    // Produced clips live on their scenes (scene.renders); scripts, notes
    // and dailies reports are documents records, not fields on here.
  };
}

export function duplicateScene(scene, name) {
  return {
    ...structuredClone(scene),
    id: newId('scn'),
    name: name || `${scene.name} (copy)`,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    blocks: scene.blocks.map((b) => ({ ...b, id: newId('blk') })),
    renders: [], // a copy starts unproduced; the original keeps its history
    refinements: [],
  };
}

export function blockLabel(typeId) {
  return BLOCK_TYPES.find((t) => t.id === typeId)?.label || typeId;
}

export function categoryLabel(id) {
  return ASSET_CATEGORIES.find((c) => c.id === id)?.label || id;
}

// A block or aspect counts as blank when it has no text. This is what
// makes expansion additive (decision #13) — a pass is only ever allowed
// to touch these.
export function blankBlockTypes(scene) {
  return scene.blocks.filter((b) => !(b.text || '').trim()).map((b) => b.type);
}

export function blankAspectIds(scene) {
  return ASPECTS.filter((a) => !(scene.shot.aspects[a.id] || '').trim()).map((a) => a.id);
}

export function sceneIsBlank(scene) {
  return blankBlockTypes(scene).length === scene.blocks.length && !scene.seed.trim();
}

export function touch(entity) {
  entity.updatedAt = nowISO();
  return entity;
}
