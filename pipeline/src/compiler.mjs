// The prompt compiler.
//
// A creator's shot note is never what a model receives. The compiler
// builds the prompt from clauses, each with a known source: the Story
// Bible supplies who and where, the scene supplies light and time, the
// shot supplies what happens and how it's framed. Canon is therefore
// stated the same way in every shot, and a change to the Bible changes
// every prompt that depends on it.
//
// Clauses are kept apart until the last moment so they can be inspected,
// diffed, locked one at a time, and trimmed by priority when a model's
// prompt budget is tight.
//
// Pure: no I/O. Everything here is recomputed on demand.

export function estimateTokens(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

// Which clauses matter most when something has to give. Who is in the
// shot and what they do outrank how it's graded.
export const CLAUSE_ORDER = ['subject', 'action', 'location', 'lighting', 'camera', 'props', 'look', 'format', 'avoid'];
const PRIORITY = { subject: 100, action: 95, location: 70, lighting: 65, camera: 60, props: 45, look: 40, format: 30, avoid: 20 };
const SOURCE = { subject: 'Story Bible · characters', action: 'Shot note', location: 'Story Bible · location', lighting: 'Scene', camera: 'Shot', props: 'Story Bible · props', look: 'Story Bible · look', format: 'Story Bible · format', avoid: 'Negatives' };

const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '');

function derive({ shot, scene, world }) {
  const out = {};
  out.subject = world.characters
    .map(({ version }) => clean([version.fields.trigger, version.fields.description, version.fields.wardrobe && `wearing ${version.fields.wardrobe}`].filter(Boolean).join(', ')))
    .join('; ');
  out.action = clean(shot.overrides?.action ?? shot.notes);
  out.location = clean(world.location?.version.fields.description);
  out.lighting = clean([shot.lighting || scene.lighting || world.location?.version.fields.lighting, scene.timeOfDay].filter(Boolean).join(', '));
  out.camera = clean(shot.camera);
  out.props = world.props.map(({ version }) => clean(version.fields.trigger || version.fields.description)).join(', ');
  out.look = clean([world.look?.version.fields.description, world.look?.version.fields.lut && `${world.look.version.fields.lut} grade`].filter(Boolean).join(', '));
  out.format = clean(shot.aspectRatio || world.format?.version.fields.aspectRatio);
  return out;
}

function negativesOf({ shot, world }) {
  return [...new Set([world.look?.version.fields.negative, ...(shot.extraNegatives || [])].flatMap((n) => String(n || '').split(',')).map(clean).filter(Boolean))];
}

function render(clauses, model) {
  const texts = clauses.filter((c) => !c.dropped && c.text).map((c) => (c.key === 'format' ? `aspect ratio ${c.text}` : c.key === 'avoid' ? `avoid: ${c.text}` : c.text));
  return model.promptStyle === 'tags' ? texts.join(', ') : texts.map((t) => t[0].toUpperCase() + t.slice(1)).join('. ') + (texts.length ? '.' : '');
}

// Makes the clauses fit the model's prompt budget.
//
// A prompt over the limit isn't truncated politely by a model — it is
// rejected, or worse, silently cut off at the end, which is where the
// look and format live. So the compiler decides what goes: unlocked
// clauses are dropped from the lowest priority up until it fits. A
// locked clause is the creator's explicit word and is never dropped; if
// the locked clauses alone don't fit, that is reported as a blocker
// rather than resolved by guessing.
function fitBudget(clauses, model) {
  const budget = model.maxPromptTokens;
  const tokens = () => estimateTokens(render(clauses, model));
  const droppable = clauses.filter((c) => !c.locked && c.text).sort((a, b) => a.priority - b.priority);
  while (tokens() > budget && droppable.length) droppable.shift().dropped = true;
  return { tokens: tokens(), budget, overBudget: tokens() > budget };
}

export function compileShot({ shot, scene, world, model }) {
  const derived = derive({ shot, scene, world });
  const negatives = negativesOf({ shot, world });
  if (!model.supportsNegative && negatives.length) derived.avoid = negatives.join(', ');

  const clauses = CLAUSE_ORDER.filter((key) => key in derived || shot.locks?.[key] !== undefined).map((key) => {
    const locked = shot.locks?.[key] !== undefined;
    return {
      key,
      text: locked ? clean(shot.locks[key]) : derived[key] || '',
      derived: derived[key] || '',
      locked,
      source: locked ? 'Locked by you' : key === 'action' && shot.overrides?.action !== undefined ? 'Refined shot note' : SOURCE[key],
      priority: PRIORITY[key],
      dropped: false,
    };
  });

  const fit = fitBudget(clauses, model);
  return {
    modelId: model.id,
    clauses,
    prompt: render(clauses, model),
    negativePrompt: model.supportsNegative ? negatives.join(', ') : '',
    ...fit,
    dropped: clauses.filter((c) => c.dropped).map((c) => c.key),
    blocked: fit.overBudget
      ? `The locked clauses alone come to ${fit.tokens} tokens; ${model.label} accepts ${fit.budget}. Shorten or unlock one.`
      : null,
  };
}

// ---------- critic → refine ----------
//
// Rule-based, on purpose. A critic that calls a model costs compute to
// decide whether to spend compute; these checks are free and catch the
// mistakes that waste the most renders.

const FILLER = /\b(very|really|extremely|stunning|beautiful|gorgeous|amazing|masterpiece|best quality|highly detailed|ultra[- ]detailed|8k|4k|award[- ]winning|trending on \w+)\b,?\s*/gi;
const NEGATION = /\b(?:no|without)\s+([a-z][a-z -]{1,30}?)(?=[,.;]|\s+(?:and|but|while|as)\b|$)/gi;
const MULTI_BEAT = /\b(then|after that|cut to|next,|followed by|meanwhile)\b/i;
const NIGHT = /\b(night|midnight|moonlit|dark outside)\b/i;
const DAY = /\b(day|noon|midday|sunny|sun|sunlit|daylight|dawn|sunrise|morning|afternoon)\b/i;

export function critique({ compiled, shot, scene, world }) {
  const issues = [];
  const action = compiled.clauses.find((c) => c.key === 'action');
  const note = action?.text || '';

  if (!compiled.clauses.find((c) => c.key === 'subject')?.text) {
    issues.push({ code: 'no-subject', severity: 'warn', clause: 'subject', message: 'No character is attached to this shot, so nothing anchors who is in frame.' });
  }
  if (!note) issues.push({ code: 'no-action', severity: 'block', clause: 'action', message: 'The shot has no note. There is nothing for the model to depict.' });
  if (MULTI_BEAT.test(note)) {
    issues.push({ code: 'multi-beat', severity: 'warn', clause: 'action', message: 'The note describes more than one beat. A shot is one continuous take — split this into separate shots.' });
  }
  if (!action?.locked && note.match(NEGATION)) {
    issues.push({ code: 'negation', severity: 'fix', clause: 'action', message: 'Models read "no rain" as "rain". Negatives belong in the negative prompt.', fixable: true });
  }
  if (!action?.locked && note.match(FILLER)) {
    issues.push({ code: 'filler', severity: 'fix', clause: 'action', message: 'Filler words ("stunning", "8k") spend prompt budget and change nothing.', fixable: true });
  }
  const sceneTime = `${scene.timeOfDay || ''} ${scene.lighting || ''}`;
  if ((NIGHT.test(note) && DAY.test(sceneTime)) || (DAY.test(note) && NIGHT.test(sceneTime))) {
    issues.push({ code: 'time-conflict', severity: 'warn', clause: 'action', message: `The note and the scene disagree about the time of day (scene: ${clean(sceneTime)}).` });
  }
  const attached = new Set(world.characters.map((c) => c.entity.id));
  (world.allCharacters || []).forEach(({ entity }) => {
    if (!attached.has(entity.id) && new RegExp(`\\b${entity.name}\\b`, 'i').test(shot.notes || '')) {
      issues.push({ code: 'unattached-character', severity: 'warn', clause: 'subject', message: `${entity.name} is named in the note but not attached to the shot, so their reference sheet won't be used.` });
    }
  });
  if (compiled.dropped.length) {
    issues.push({ code: 'dropped', severity: 'warn', clause: compiled.dropped[0], message: `To fit ${compiled.budget} tokens, these clauses were left out: ${compiled.dropped.join(', ')}. Lock one to keep it.` });
  }
  if (compiled.blocked) issues.push({ code: 'over-budget', severity: 'block', clause: 'action', message: compiled.blocked });
  return issues;
}

// The automatic half of the pass. Only ever rewrites the shot note and
// the negatives — canon comes from the Bible and is not the refiner's to
// change. Returns what to store on the shot; applying it is the
// caller's decision.
export function refine(shot) {
  const changes = [];
  let action = shot.overrides?.action ?? shot.notes ?? '';
  const negatives = [...(shot.extraNegatives || [])];

  const found = [...action.matchAll(NEGATION)].map((m) => clean(m[1]));
  if (found.length) {
    action = action.replace(NEGATION, '');
    found.forEach((term) => { if (!negatives.includes(term)) negatives.push(term); });
    changes.push(`Moved to negatives: ${found.join(', ')}`);
  }
  if (action.match(FILLER)) {
    changes.push(`Removed filler: ${[...new Set(action.match(FILLER).map((f) => clean(f)))].join(', ')}`);
    action = action.replace(FILLER, '');
  }
  action = clean(action.replace(/\s+,/g, ',').replace(/,\s*,/g, ','));
  return { changes, overrides: { ...(shot.overrides || {}), action }, extraNegatives: negatives };
}

export function diffClauses(before, after) {
  const a = new Map((before || []).map((c) => [c.key, c]));
  const b = new Map((after || []).map((c) => [c.key, c]));
  const shown = (c) => (c && !c.dropped ? c.text : '');
  return CLAUSE_ORDER.filter((key) => a.has(key) || b.has(key))
    .map((key) => ({ key, before: shown(a.get(key)), after: shown(b.get(key)) }))
    .filter((d) => d.before !== d.after)
    .map((d) => ({ ...d, change: !d.before ? 'added' : !d.after ? 'removed' : 'changed' }));
}
