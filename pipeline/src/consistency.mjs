// The consistency engine.
//
// Two jobs. First, the references: every shot automatically carries the
// canonical sheets for whoever and wherever it shows — nobody has to
// remember to attach the turnaround. Second, the continuity check: the
// mistakes that only show up when two shots are cut together are looked
// for before either is rendered.
//
// Pure. Works from resolved Story Bible versions, never from live state.

const clean = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

// The reference assets a shot's recipe must carry, in a fixed order so
// the same shot always yields the same list.
export function resolveReferences({ world, blobs }) {
  const refs = [];
  const add = (role, holder) => (holder?.version.referenceAssetIds || []).forEach((assetId) => {
    const blob = blobs(assetId);
    refs.push({ assetId, hash: blob ? blob.hash : null, role, from: holder.entity.name, missing: !blob });
  });
  world.characters.forEach((c) => add('character', c));
  if (world.location) add('location', world.location);
  world.props.forEach((p) => add('prop', p));
  if (world.look) add('style', world.look);
  return refs;
}

export function checkContinuity({ shot, scene, world, references }) {
  const warnings = [];
  const warn = (code, severity, message) => warnings.push({ code, severity, message });

  world.characters.forEach(({ entity, version }) => {
    if (!(version.referenceAssetIds || []).length) {
      warn('no-reference', 'warn', `${entity.name} has no turnaround in the vault. Nothing holds their face and build steady from shot to shot.`);
    }
    const worn = (shot.notes || '').match(/\b(?:wearing|dressed in|in (?:a|an|his|her|their))\s+([^,.;]+)/i);
    const canon = clean(version.fields.wardrobe);
    if (worn && canon && !canon.includes(clean(worn[1])) && !clean(worn[1]).includes(canon)) {
      warn('wardrobe', 'warn', `The note puts ${entity.name} in "${worn[1].trim()}", but the Bible has them in "${version.fields.wardrobe}". The prompt will say both.`);
    }
  });

  references.filter((r) => r.missing).forEach((r) => {
    warn('missing-reference', 'block', `A reference for ${r.from} (${r.assetId}) is no longer in the vault. Rendering would silently go ahead without it.`);
  });

  if (shot.lighting && scene.lighting && clean(shot.lighting) !== clean(scene.lighting)) {
    warn('lighting-shift', 'warn', `This shot overrides the scene's lighting ("${scene.lighting}" → "${shot.lighting}"). It won't cut cleanly against its neighbours.`);
  }
  const canonRatio = world.format?.version.fields.aspectRatio;
  if (shot.aspectRatio && canonRatio && shot.aspectRatio !== canonRatio) {
    warn('aspect-drift', 'warn', `This shot is ${shot.aspectRatio}; the project is ${canonRatio}.`);
  }
  if (!world.location) warn('no-location', 'warn', 'The scene has no location, so nothing fixes the setting.');
  return warnings;
}
