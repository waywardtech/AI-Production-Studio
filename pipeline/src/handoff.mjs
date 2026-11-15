// Hand-off: making a take through a chat subscription, by hand.
//
// A hand-off generator has no API here. The studio does everything up to
// the point of asking — compiles the prompt, picks the references, fixes
// the seed and the recipe — and then writes out a sheet: where to go,
// what to attach, what to paste. A person sends it and brings the result
// back. The studio never contacts the platform and never sends anything.
//
// This is the same seam an API adapter would fill later: the recipe in,
// a file out. Only who carries it across changes.

const KIND_WORD = { image: 'image', video: 'video' };

export function buildHandoffSheet({ recipe, model, shot, references, guidance }) {
  const attachments = references
    .filter((ref) => !ref.missing)
    .map((ref) => ({ blobId: ref.assetId, label: ref.label || `${ref.from} reference`, role: 'reference', why: `${ref.from} · ${ref.role}` }));
  if (guidance) attachments.unshift({ blobId: guidance.blobId, label: `${shot.name} approved proxy`, role: 'composition', why: 'the composition to follow exactly' });

  const lines = [];
  const duration = recipe.controlParams?.durationS;
  if (guidance) {
    lines.push(`Using the attached "${shot.name} approved proxy" as the exact composition, recreate it as a final ${KIND_WORD[model.kind]} at the highest resolution and detail available.`);
    lines.push('Do not change the framing, the subjects, their wardrobe, the lighting or the timing. Only add detail.');
  } else {
    lines.push(model.kind === 'video' ? `Create one ${duration}-second video.` : 'Create one image.');
  }
  if (guidance && model.kind === 'video') lines.push(`Length: ${duration}-second video.`);
  if (attachments.some((a) => a.role === 'reference')) lines.push('Match the attached reference images for the people, places and objects they show.');
  lines.push('', recipe.compiledPrompt);
  if (recipe.negativePrompt) lines.push('', `Avoid: ${recipe.negativePrompt}`);
  if (recipe.controlParams?.motion && model.kind === 'video') lines.push('', `Camera: ${recipe.controlParams.motion}.`);

  return {
    provider: model.provider,
    generator: model.label,
    url: model.url,
    kind: model.kind,
    tier: recipe.resolutionTier,
    message: lines.join('\n'),
    attachments,
    accepts: model.kind === 'video' ? 'video/*' : 'image/*',
    steps: [
      `Open ${model.label.split(' (')[0]}.`,
      attachments.length ? `Attach the ${attachments.length} file${attachments.length === 1 ? '' : 's'} listed.` : null,
      'Paste the message and send it yourself.',
      'Download the result and import it here.',
    ].filter(Boolean),
  };
}
