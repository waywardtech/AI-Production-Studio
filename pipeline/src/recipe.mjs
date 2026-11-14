// The generation recipe — the immutable manifest behind every take.
//
// A recipe records everything needed to make an output again: the seed,
// the exact compiled prompt, the references and their content hashes,
// the model, its control parameters, and the resolution tier. Its id is
// a hash of all of that, so a recipe can't be edited — changing anything
// makes a different recipe — and two identical requests are, provably,
// the same request.
//
// `inputs` is separate: it records which upstream things the recipe was
// compiled from (which version of each Bible entry, which revision of
// the scene and shot). It is how a take later knows it has gone stale.

import { deepFreeze, hashOf } from './ids.mjs';

// The fields that define what the model is asked to draw. Promotion to
// master may change none of them.
export const INVARIANT_FIELDS = ['seed', 'compiledPrompt', 'negativePrompt', 'referenceAssetIds', 'referenceHashes', 'modelId', 'controlParams'];
// The only fields promotion is allowed to change.
export const PROMOTION_FIELDS = ['resolutionTier', 'resolution', 'promotedFromRecipeId', 'upscaleGuidance'];

export function shotRevision(shot) {
  const { notes, camera, characterIds, propIds, locks, overrides, extraNegatives, lighting, aspectRatio, durationS, kind } = shot;
  return hashOf({ notes, camera, characterIds, propIds, locks, overrides, extraNegatives, lighting, aspectRatio, durationS, kind });
}

export function sceneRevision(scene) {
  const { beat, locationId, timeOfDay, lighting } = scene;
  return hashOf({ beat, locationId, timeOfDay, lighting });
}

function seal(body) {
  const { inputs, ...identity } = body;
  // inputs are provenance, not identity: the same prompt reached by two
  // routes is still the same thing to ask a model for.
  return deepFreeze({ id: `rcp_${hashOf(identity)}`, ...body });
}

export function buildRecipe({ shot, scene, world, compiled, references, model, tier = 'proxy', seed }) {
  return seal({
    seed,
    compiledPrompt: compiled.prompt,
    negativePrompt: compiled.negativePrompt,
    referenceAssetIds: references.map((r) => r.assetId),
    referenceHashes: references.map((r) => r.hash),
    modelId: model.id,
    controlParams: { durationS: shot.kind === 'video' ? shot.durationS || 4 : undefined, motion: shot.kind === 'video' ? shot.camera || 'static' : undefined },
    resolutionTier: tier,
    resolution: model.tiers[tier],
    clauses: compiled.clauses.map(({ key, text, locked, dropped, source }) => ({ key, text, locked, dropped, source })),
    inputs: {
      shotId: shot.id,
      shotRev: shotRevision(shot),
      sceneRev: sceneRevision(scene),
      bibleVersionIds: Object.fromEntries(
        [...world.characters, world.location, ...world.props, world.look, world.format].filter(Boolean).map((h) => [h.entity.id, h.version.id])
      ),
    },
  });
}

// What differs between two recipes, by field.
export function recipeDelta(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  ['id', 'inputs', 'clauses'].forEach((k) => keys.delete(k));
  return [...keys].filter((key) => hashOf(a[key] ?? null) !== hashOf(b[key] ?? null));
}

// Proxy → master. The locked recipe is re-run with only the resolution
// changed; `assertPromotionInvariant` is the proof, and it runs on every
// promotion rather than being trusted.
export function promoteRecipe(proxy, model, { guidanceTakeId = null } = {}) {
  if (proxy.resolutionTier !== 'proxy') throw new Error('Only a proxy recipe can be promoted to master.');
  // Framing cannot survive a change of shape: a master tier with a
  // different aspect ratio would have to crop or invent picture.
  const from = proxy.resolution;
  const to = model.tiers.master;
  if (from?.w && from?.h && to.w && to.h && Math.abs(from.w / from.h - to.w / to.h) > 0.01) {
    throw new Error(`${model.label || model.id} masters at a different aspect ratio (${to.w}×${to.h}) than this proxy (${from.w}×${from.h}); the framing would not survive.`);
  }
  const { id, ...body } = proxy;
  const master = seal({
    ...structuredClone(body),
    resolutionTier: 'master',
    resolution: model.tiers.master,
    promotedFromRecipeId: proxy.id,
    ...(guidanceTakeId ? { upscaleGuidance: { mode: 'init-frame', fromTakeId: guidanceTakeId } } : {}),
  });
  assertPromotionInvariant(proxy, master);
  return master;
}

export function assertPromotionInvariant(proxy, master) {
  const illegal = recipeDelta(proxy, master).filter((field) => !PROMOTION_FIELDS.includes(field));
  if (illegal.length) throw new Error(`Promotion changed more than the resolution: ${illegal.join(', ')}`);
  return true;
}
