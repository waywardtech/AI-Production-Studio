// Prompt assembly, generator targets and job profiles (M4-8 / M4-9),
// plus the requests the chat round-trips send and the parsers that read
// their answers back (M4-10 / M4-11 / M4-12 / M4-17).
//
// Pure: no DOM, no chrome, no storage. Everything takes a production
// and a scene and returns a string or a plain object, which is what
// makes the per-block preview cheap enough to recompute on every
// keystroke.

import { ASPECTS, BLOCK_TYPES, blockLabel, categoryLabel } from './model.js';

// ---------- M4-9: target generators ----------
//
// Guidance is prompt-shaping advice, not an API contract — these are
// web UIs that change. Each target says how a shot should be worded for
// it, and what it will ignore.

export const VIDEO_TARGETS = [
  {
    id: 'sora',
    label: 'Sora (ChatGPT)',
    platform: 'chatgpt',
    shape: 'prose',
    guidance:
      'Write one continuous take as flowing prose, not a list. Name the subject, ' +
      'then the action, then the setting, then the camera. Describe camera movement ' +
      'in plain language ("the camera pushes in slowly") rather than as jargon. ' +
      'Keep it to a single shot — a cut inside one clip is a request for two clips. ' +
      'Use the same words for a character every time so they stay the same person.',
  },
  {
    id: 'veo',
    label: 'Veo (Gemini / Flow)',
    platform: 'gemini',
    shape: 'clauses',
    guidance:
      'Lead with subject and action, then setting, then camera, then lighting and mood, ' +
      'as short descriptive clauses. State audio explicitly — ambience, effects and any ' +
      'spoken line — rather than leaving it implied. Keep it to one continuous take, and ' +
      'put anything to be excluded in its own "Avoid" line rather than phrasing it as a negative.',
  },
];

export function targetById(id) {
  return VIDEO_TARGETS.find((t) => t.id === id) || VIDEO_TARGETS[0];
}

// ---------- M4-9: job profiles ----------
//
// The recurring kinds of work, each carrying the settings that would
// otherwise be typed in every time. `defaults` only ever fill blanks —
// applying a profile never overwrites something already written.

export const JOB_PROFILES = [
  {
    id: 'general',
    label: 'General shot',
    guidance: '',
    defaults: { duration: '8s', aspectRatio: '16:9' },
  },
  {
    id: 'comic-page',
    label: 'Comic page → shots',
    guidance:
      'This shot comes from one panel of a comic page. Hold the panel composition and the ' +
      'characters exactly as described; treat the panel as the frame, not as inspiration. ' +
      'Dialogue is played as performance and timing, not as text on screen.',
    defaults: { duration: '6s', aspectRatio: '16:9', negative: 'on-screen text, speech bubbles, captions' },
  },
  {
    id: 'social-vertical',
    label: 'Social vertical',
    guidance:
      'Vertical framing, subject centred and safe from platform UI at top and bottom. ' +
      'The first second has to hold on its own — open on the strongest image, not on a build-up.',
    defaults: { duration: '8s', aspectRatio: '9:16' },
  },
  {
    id: 'establishing',
    label: 'Establishing / B-roll',
    guidance:
      'A wide establishing frame with no dialogue and no cutting. One slow, deliberate camera ' +
      'move. The place is the subject.',
    defaults: { duration: '10s', aspectRatio: '16:9', motion: 'slow drift', negative: 'dialogue, fast cuts' },
  },
  {
    id: 'dialogue-two-shot',
    label: 'Dialogue two-shot',
    guidance:
      'Two characters in frame, cleanly separated, both faces readable. The camera holds. ' +
      'Give each spoken line to a named character and keep the delivery unhurried enough to read.',
    defaults: { duration: '8s', aspectRatio: '16:9', motion: 'locked off' },
  },
  {
    id: 'action-beat',
    label: 'Action beat',
    guidance:
      'One beat of action, start to finish, inside a single take. State where the movement ' +
      'begins and where it ends so the clip resolves instead of trailing off.',
    defaults: { duration: '6s', aspectRatio: '16:9', motion: 'handheld, following the action' },
  },
  {
    id: 'insert',
    label: 'Insert / detail',
    guidance:
      'A tight insert on one object or gesture. Shallow depth of field, nothing else competing ' +
      'for attention in the frame.',
    defaults: { duration: '4s', aspectRatio: '16:9', camera: 'macro, close on the subject' },
  },
];

export function profileById(id) {
  return JOB_PROFILES.find((p) => p.id === id) || JOB_PROFILES[0];
}

// ---------- M4-8: assembly ----------

function assetLine(asset) {
  const bits = [`${categoryLabel(asset.category)} — ${asset.name}`];
  if (asset.description) bits.push(asset.description);
  if (asset.sourceUrl) bits.push(`ref: ${asset.sourceUrl}`);
  return bits.join('. ');
}

// The assembled prompt as its parts, each tagged with what produced it.
// Column 3 renders the joined text and highlights the segment belonging
// to whichever block is selected — that's the per-block preview.
export function assembleSegments(production, scene, { target, profile } = {}) {
  const tgt = targetById(target ?? production.target);
  const prof = profileById(profile ?? production.profile);
  const segments = [];

  const push = (key, label, text, extra = {}) => {
    const body = (text || '').trim();
    if (body) segments.push({ key, label, text: body, ...extra });
  };

  push('profile', 'Job', prof.guidance);

  scene.blocks.forEach((block) => {
    push(`block:${block.id}`, blockLabel(block.type), block.text, { blockId: block.id });
  });

  const stillAsset = scene.shot.stillAssetId
    ? production.assets.find((a) => a.id === scene.shot.stillAssetId)
    : null;
  if (stillAsset) {
    push('still', 'Opening frame', assetLine(stillAsset), { assetId: stillAsset.id });
  }

  const refs = scene.assetIds
    .map((id) => production.assets.find((a) => a.id === id))
    .filter((a) => a && a.id !== scene.shot.stillAssetId);
  if (refs.length) {
    push('assets', 'References', refs.map((a) => `- ${assetLine(a)}`).join('\n'));
  }

  // The five sketched aspects read as one cinematography line; the
  // mechanical ones are stated separately because a generator reads
  // them as settings rather than description.
  const look = ASPECTS.filter((a) => !a.advanced)
    .map((a) => [a, (scene.shot.aspects[a.id] || '').trim()])
    .filter(([, v]) => v)
    .map(([a, v]) => `${a.label.toLowerCase()}: ${v}`);
  push('look', 'Look', look.join('; '));

  ASPECTS.filter((a) => a.advanced && a.id !== 'negative').forEach((a) => {
    push(`aspect:${a.id}`, a.label, scene.shot.aspects[a.id], { aspectId: a.id });
  });

  push('target', `Written for ${tgt.label}`, tgt.guidance);
  push('negative', 'Avoid', scene.shot.aspects.negative, { aspectId: 'negative' });

  return segments;
}

export function segmentText(segment) {
  return segment.text.includes('\n')
    ? `${segment.label}:\n${segment.text}`
    : `${segment.label}: ${segment.text}`;
}

export function assemblePrompt(production, scene, options = {}) {
  return assembleSegments(production, scene, options).map(segmentText).join('\n\n');
}

// ---------- requests ----------

const JSON_RULES = [
  '- Reply with one fenced ```json code block and nothing else — no commentary before or after.',
  '- Use plain text inside the JSON. No markdown, no nested quotes-within-quotes.',
];

// M4-10. The blanks-only rule is the whole point: an expansion pass may
// invent the fields Dan has left empty and must not touch the rest.
export function buildSeedExpansionRequest(production, scene, { target, profile, blankBlocks, blankAspects }) {
  const tgt = targetById(target ?? production.target);
  const prof = profileById(profile ?? production.profile);

  const written = scene.blocks
    .filter((b) => (b.text || '').trim())
    .map((b) => `- ${blockLabel(b.type)}: ${b.text.trim()}`);
  const writtenAspects = ASPECTS.filter((a) => (scene.shot.aspects[a.id] || '').trim()).map(
    (a) => `- ${a.label}: ${scene.shot.aspects[a.id].trim()}`
  );

  return [
    `You are a director breaking a scene down into a single shot for ${tgt.label}.`,
    '',
    `Scene: ${scene.name}`,
    scene.seed.trim() ? `Seed: ${scene.seed.trim()}` : 'Seed: (none given — work from what is already filled in)',
    prof.guidance ? `Job: ${prof.guidance}` : '',
    '',
    written.length ? 'Already decided — keep these exactly as they are, do not restate them:' : 'Nothing is decided yet.',
    ...written,
    ...writtenAspects,
    '',
    'Fill in ONLY the empty fields listed below. Be specific and visual; one or two sentences each.',
    '',
    'Empty blocks:',
    ...blankBlocks.map((t) => `- ${t} (${BLOCK_TYPES.find((b) => b.id === t)?.hint || ''})`),
    'Empty aspects:',
    ...blankAspects.map((id) => `- ${id} (${ASPECTS.find((a) => a.id === id)?.label})`),
    '',
    'Return:',
    '```json',
    '{ "blocks": { "<block id>": "text" }, "aspects": { "<aspect id>": "text" } }',
    '```',
    ...JSON_RULES,
    '- Include a key only for fields listed as empty above. Omit anything you have nothing useful to say about.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// M4-11. Refine takes plain language and returns the same shape, but is
// allowed to change written fields — that is what Dan asked for.
export function buildRefineRequest(production, scene, instruction, { target, profile } = {}) {
  const current = assemblePrompt(production, scene, { target, profile });
  return [
    'You are refining one shot in a shot list. Below is the shot as it stands, then a change to make.',
    '',
    '--- CURRENT SHOT ---',
    current,
    '--- END ---',
    '',
    `Change: ${instruction.trim()}`,
    '',
    'Apply the change and return only the fields that actually change as a result. Leave everything',
    'else out of the reply — unchanged fields must not appear.',
    '',
    'Return:',
    '```json',
    '{ "blocks": { "<block id>": "text" }, "aspects": { "<aspect id>": "text" } }',
    '```',
    `Valid block ids: ${scene.blocks.map((b) => b.type).join(', ')}.`,
    `Valid aspect ids: ${ASPECTS.map((a) => a.id).join(', ')}.`,
    ...JSON_RULES,
  ].join('\n');
}

// M4-12. The comic-book case from the notes: a page, a script or a
// treatment goes in, a shot list comes out.
export function buildScriptBreakdownRequest(scriptText, { profile, maxScenes = 12 } = {}) {
  const prof = profileById(profile);
  return [
    'You are breaking source material down into a shot list for video generation.',
    prof.guidance ? `Job: ${prof.guidance}` : '',
    '',
    `Break the material below into at most ${maxScenes} shots, in order. One shot is one continuous take.`,
    'For each shot give a short name and fill in what the material actually supports — leave a field out',
    'rather than inventing detail the source does not have.',
    '',
    'Return:',
    '```json',
    '{ "scenes": [ { "name": "...", "seed": "...", "blocks": { "location": "...", "setting": "...",',
    '  "scene": "...", "set-dressing": "...", "characters": "...", "dialogue": "..." },',
    '  "aspects": { "timeOfDay": "...", "atmosphere": "...", "look": "...", "lighting": "...", "exposure": "..." } } ] }',
    '```',
    ...JSON_RULES,
    '',
    '--- SOURCE MATERIAL ---',
    scriptText.trim(),
    '--- END ---',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// M4-17. Freeform notes about a production's world → assets in the pool.
export function buildImportRequest(text) {
  return [
    'Below are production notes. Pull out every character, location, wardrobe item, vehicle, prop',
    'and mood/lighting reference they describe, one entry each, using the wording of the notes.',
    '',
    'Return:',
    '```json',
    '{ "assets": [ { "name": "...", "category": "character|location|wardrobe|vehicle|prop|mood",',
    '  "description": "...", "sourceUrl": "" } ] }',
    '```',
    ...JSON_RULES,
    '',
    '--- NOTES ---',
    text.trim(),
    '--- END ---',
  ].join('\n');
}

// M4-14. The final hand-off: the assembled shot, reworded for whichever
// generator is about to run it.
export function buildProductionPrompt(production, scene, { target, profile } = {}) {
  const tgt = targetById(target ?? production.target);
  const prof = profileById(profile ?? production.profile);
  const parts = assembleSegments(production, scene, { target, profile })
    .filter((s) => s.key !== 'target' && s.key !== 'profile')
    .map(segmentText);

  return [
    `Write a single ${tgt.label} prompt for the shot described below, then stop.`,
    '',
    `How ${tgt.label} wants it: ${tgt.guidance}`,
    prof.guidance ? `Job: ${prof.guidance}` : '',
    '',
    'Rules:',
    '- One shot, one continuous take. Do not add shots, cuts or a story beyond what is described.',
    '- Keep every specific already given — names, times, colours, lenses — exactly as written.',
    '- Do not answer as an assistant and do not explain your choices.',
    '- Return only the prompt, inside a single fenced code block.',
    '',
    '--- SHOT ---',
    ...parts,
    '--- END ---',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// ---------- parsers ----------

// The requests all ask for one fenced JSON block, so this is mostly a
// formality — but a chat that answers with a bare object, or wraps it in
// a sentence, shouldn't cost Dan the round trip.
export function parseJsonReply(raw) {
  const text = (raw || '').trim();
  const candidates = [];

  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);

  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// Reduces whatever came back to the fields it is actually allowed to
// set. `allowedBlocks`/`allowedAspects` are the blanks for an expansion
// pass, or everything for a refine.
export function normalizeFieldUpdate(parsed, { allowedBlocks, allowedAspects }) {
  const blocks = {};
  const aspects = {};
  if (!parsed) return { blocks, aspects };

  Object.entries(parsed.blocks || {}).forEach(([key, value]) => {
    const id = String(key).trim().toLowerCase().replace(/[\s_]+/g, '-');
    const text = typeof value === 'string' ? value.trim() : '';
    if (text && allowedBlocks.includes(id)) blocks[id] = text;
  });

  Object.entries(parsed.aspects || {}).forEach(([key, value]) => {
    const id = String(key).trim();
    const text = typeof value === 'string' ? value.trim() : '';
    if (text && allowedAspects.includes(id)) aspects[id] = text;
  });

  return { blocks, aspects };
}

export function parseSceneList(parsed) {
  const raw = Array.isArray(parsed) ? parsed : parsed?.scenes;
  if (!Array.isArray(raw)) return [];
  const blockIds = BLOCK_TYPES.map((b) => b.id);
  const aspectIds = ASPECTS.map((a) => a.id);

  return raw
    .map((entry, i) => ({
      name: (entry?.name || `Shot ${i + 1}`).toString().trim(),
      seed: (entry?.seed || '').toString().trim(),
      ...normalizeFieldUpdate(entry, { allowedBlocks: blockIds, allowedAspects: aspectIds }),
    }))
    .filter((s) => s.name || s.seed || Object.keys(s.blocks).length);
}

export function parseAssetList(parsed) {
  const raw = Array.isArray(parsed) ? parsed : parsed?.assets;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => ({
      name: (entry?.name || '').toString().trim(),
      category: (entry?.category || 'other').toString().trim().toLowerCase(),
      description: (entry?.description || '').toString().trim(),
      sourceUrl: (entry?.sourceUrl || '').toString().trim(),
    }))
    .filter((a) => a.name);
}
