// The studio service — the application itself, with no HTTP in it.
//
// Everything a creator can do goes through here: write the Story Bible,
// lay out scenes and shots, compile and inspect a prompt, render a
// proxy, promote it to master, approve a take, and find out what an
// upstream edit has put out of date. The server and the UI are thin
// layers over these functions, and the tests call them directly.
//
// The dependency graph is layered and therefore acyclic by construction:
//
//   Story Bible entry ─┐
//                      ├→ Scene ─→ Shot ─→ Take (recipe → output)
//   (look, format) ────┘                     └→ Take (promoted / branched)
//
// "Out of date" is never a stored flag. It is computed by comparing the
// inputs a take's recipe was compiled from against what those inputs are
// now, so there is no flag to forget to set and none to forget to clear.

import { hashOf, newId } from './ids.mjs';
import { createStore } from './store.mjs';
import { createAdapters, defaultModelFor, modelById, MODELS } from './adapters.mjs';
import { compileShot, critique, diffClauses, refine } from './compiler.mjs';
import { checkContinuity, resolveReferences } from './consistency.mjs';
import { createHash } from 'node:crypto';
import { buildHandoffSheet } from './handoff.mjs';
import { buildRecipe, promoteRecipe, recipeDelta, sceneRevision, shotRevision } from './recipe.mjs';
import { createQueue } from './jobs.mjs';

export const BIBLE_KINDS = ['character', 'location', 'prop', 'look', 'format', 'voice'];
const KIND_MODEL = { frame: 'image', video: 'video', voice: 'voice' };

// `files` holds imported media (which can be large) outside the JSON
// store: { put(id, bytes), get(id) }. In memory unless the server says
// otherwise.
function memoryFiles() {
  const map = new Map();
  return { put: (id, bytes) => void map.set(id, Buffer.from(bytes)), get: (id) => map.get(id) || null };
}
const refuse = (message) => Object.assign(new Error(message), { refusal: true });

export function createStudio({ store = createStore(), adapters = createAdapters(), files = memoryFiles(), queueOptions = {}, now = () => Date.now(), randomSeed = () => Math.floor(Math.random() * 1e9) } = {}) {
  // ---------- Story Bible ----------

  function createEntity({ kind, name, fields = {}, referenceAssetIds = [] }) {
    if (!BIBLE_KINDS.includes(kind)) throw new Error(`Unknown Story Bible kind "${kind}"`);
    const entity = { id: newId(kind.slice(0, 3)), kind, name, headVersionId: null, createdAt: now() };
    store.put('bible', entity);
    return reviseEntity(entity.id, { fields, referenceAssetIds }).entity;
  }

  // Editing canon never changes a version; it adds one. Takes made from
  // the old version keep pointing at it, which is how they know.
  function reviseEntity(entityId, { fields, referenceAssetIds, name }) {
    const entity = store.get('bible', entityId);
    if (!entity) throw new Error('No such Story Bible entry.');
    const previous = entity.headVersionId ? store.get('bibleVersions', entity.headVersionId) : null;
    const version = {
      id: newId('ver'), entityId, n: previous ? previous.n + 1 : 1, parentVersionId: previous?.id || null,
      fields: { ...(previous?.fields || {}), ...(fields || {}) },
      referenceAssetIds: referenceAssetIds ?? previous?.referenceAssetIds ?? [],
      createdAt: now(),
    };
    store.insert('bibleVersions', version);
    const updated = { ...entity, name: name ?? entity.name, headVersionId: version.id };
    store.put('bible', updated);
    return { entity: updated, version, affected: downstreamShots(entityId).map((shot) => shot.id) };
  }

  const head = (entityId) => {
    const entity = entityId && store.get('bible', entityId);
    return entity ? { entity, version: store.get('bibleVersions', entity.headVersionId) } : null;
  };
  const headOfKind = (kind) => {
    const [entity] = store.list('bible', (e) => e.kind === kind);
    return entity ? head(entity.id) : null;
  };

  // A reference image in the vault. Stored by content hash, so the same
  // sheet uploaded twice is one asset and a changed sheet is a new one.
  function addVaultAsset({ label, content, mime = 'image/svg+xml' }) {
    const hash = hashOf(content);
    const blob = { id: `ast_${hash}`, hash, label, mime, content, createdAt: now() };
    store.insert('blobs', blob);
    return store.get('blobs', blob.id);
  }

  // ---------- scenes and shots ----------

  function createScene(fields) {
    const scene = { id: newId('scn'), name: 'Untitled scene', beat: '', locationId: null, timeOfDay: '', lighting: '', order: store.list('scenes').length, ...fields };
    return store.put('scenes', scene);
  }
  function updateScene(id, fields) {
    return store.put('scenes', { ...store.get('scenes', id), ...fields, id });
  }

  function createShot(fields) {
    const shot = {
      id: newId('shot'), sceneId: null, kind: 'frame', name: 'Untitled shot', notes: '', camera: '', durationS: 4,
      characterIds: [], propIds: [], locks: {}, overrides: {}, extraNegatives: [], lighting: '', aspectRatio: '',
      headTakeId: null, approvedTakeId: null, order: store.list('shots', (s) => s.sceneId === fields.sceneId).length, ...fields,
    };
    return store.put('shots', shot);
  }
  // headTakeId / approvedTakeId are moved by render and approve, never
  // by an edit: editing a shot's note must not disturb its takes.
  function updateShot(id, fields) {
    const { headTakeId, approvedTakeId, id: _ignored, ...editable } = fields;
    return store.put('shots', { ...store.get('shots', id), ...editable });
  }

  function worldFor(shot, scene) {
    return {
      characters: shot.characterIds.map(head).filter(Boolean),
      props: shot.propIds.map(head).filter(Boolean),
      location: head(scene.locationId),
      look: headOfKind('look'),
      format: headOfKind('format'),
      allCharacters: store.list('bible', (e) => e.kind === 'character').map((e) => head(e.id)),
    };
  }

  function downstreamShots(entityId) {
    const entity = store.get('bible', entityId);
    if (!entity) return [];
    const sceneIds = new Set(store.list('scenes', (s) => s.locationId === entityId).map((s) => s.id));
    return store.list('shots', (shot) =>
      entity.kind === 'look' || entity.kind === 'format' || shot.characterIds.includes(entityId) || shot.propIds.includes(entityId) || sceneIds.has(shot.sceneId));
  }

  // ---------- routing ----------
  //
  // Which generator a shot goes to: an explicit choice for this render,
  // else the look's preference, else the project's, else the built-in
  // default. A preference lives on the look's pointer record, not in a
  // version: choosing a generator is a production decision, not a change
  // of canon, and must not mark anything out of sync.

  const projectRouting = () => store.get('project', 'routing') || { id: 'routing' };
  function routeFor(shot, world, explicitId = null) {
    const kind = KIND_MODEL[shot.kind];
    const fits = (id) => { const m = modelById(id); return m && m.kind === kind ? m : null; };
    const explicit = fits(explicitId || shot.modelId);
    if (explicit) return { model: explicit, routedBy: 'shot' };
    const look = fits(world.look?.entity.routing?.[kind]);
    if (look) return { model: look, routedBy: 'look' };
    const project = fits(projectRouting()[kind]);
    if (project) return { model: project, routedBy: 'project' };
    return { model: defaultModelFor(kind), routedBy: 'default' };
  }
  function setRouting({ entityId = null, kind, modelId = null }) {
    if (!['image', 'video'].includes(kind)) throw refuse('Routing is set for stills (image) or video.');
    const model = modelId ? modelById(modelId) : null;
    if (modelId && !model) throw refuse(`Unknown generator "${modelId}".`);
    if (model && model.kind !== kind) throw refuse(`${model.label} makes ${model.kind}, not ${kind}.`);
    if (!entityId) return store.put('project', { ...projectRouting(), [kind]: modelId });
    const entity = store.get('bible', entityId);
    if (!entity || entity.kind !== 'look') throw refuse('Only a look carries a generator preference.');
    return store.put('bible', { ...entity, routing: { ...(entity.routing || {}), [kind]: modelId } });
  }
  const routing = () => ({ image: projectRouting().image || null, video: projectRouting().video || null });

  // ---------- compile ----------

  // Everything the inspector shows, and everything a render is gated on.
  function inspect(shotId, { modelId = null } = {}) {
    const shot = store.get('shots', shotId);
    if (!shot) throw new Error('No such shot.');
    const scene = store.get('scenes', shot.sceneId);
    const world = worldFor(shot, scene);
    const { model, routedBy } = routeFor(shot, world, modelId);
    const compiled = compileShot({ shot, scene, world, model });
    const references = resolveReferences({ world, blobs: (id) => store.get('blobs', id) });
    const issues = critique({ compiled, shot, scene, world });
    const continuity = checkContinuity({ shot, scene, world, references });
    const blockers = [...issues, ...continuity].filter((i) => i.severity === 'block').map((i) => i.message);

    const reference = currentTake(shot);
    const previous = reference ? store.get('recipes', reference.recipeId) : null;
    return {
      shot, scene, world, model, routedBy, compiled, references, issues, continuity, blockers,
      diff: previous ? diffClauses(previous.clauses, compiled.clauses) : [],
    };
  }

  function applyRefine(shotId) {
    const result = refine(store.get('shots', shotId));
    if (result.changes.length) updateShot(shotId, { overrides: result.overrides, extraNegatives: result.extraNegatives });
    return result;
  }
  function setLock(shotId, key, text) {
    const shot = store.get('shots', shotId);
    const locks = { ...shot.locks };
    if (text === null || text === undefined) delete locks[key];
    else locks[key] = text;
    return updateShot(shotId, { locks });
  }

  // ---------- render ----------

  const queue = createQueue({ store, now, handlers: { render: runRender }, ...queueOptions });

  function enqueueRecipe(recipe, { shotId, parentTakeId = null, promotedFromTakeId = null, batchId = null, fallbackOf = null }) {
    store.insert('recipes', recipe);
    const byHand = modelById(recipe.modelId)?.mode === 'handoff';
    return queue.enqueue({
      key: `render:${recipe.id}`, kind: 'render', batchId, fallbackOf,
      // A hand-off never enters the pump: it waits for its delivery.
      ...(byHand ? { status: 'waiting', byHand: true } : {}),
      payload: { recipeId: recipe.id, shotId, parentTakeId, promotedFromTakeId },
      label: `${store.get('shots', shotId).name} · ${recipe.resolutionTier}${byHand ? ` · ${modelById(recipe.modelId).label.split(' (')[0]}` : ''}`,
    });
  }

  function render(shotId, { tier = 'proxy', seed = null, modelId = null, parentTakeId = null, batchId = null, fallbackOf = null } = {}) {
    const view = inspect(shotId, { modelId });
    if (view.blockers.length) throw Object.assign(new Error(view.blockers[0]), { blockers: view.blockers });
    const recipe = buildRecipe({
      shot: view.shot, scene: view.scene, world: view.world, compiled: view.compiled, references: view.references,
      model: view.model, tier, seed: seed ?? randomSeed(),
    });
    return { job: enqueueRecipe(recipe, { shotId, parentTakeId, batchId, fallbackOf }), recipe, warnings: [...view.issues, ...view.continuity] };
  }

  async function runRender(job, { signal }) {
    const { recipeId, shotId, parentTakeId, promotedFromTakeId } = job.payload;
    const recipe = store.get('recipes', recipeId);

    // A recipe yields one take, and the take's id is derived from the
    // recipe. So if this job was interrupted after its take was written
    // but before the job was marked done, running it again finds the
    // take already there: no second render is paid for, and the shot
    // can't end up holding two copies of the same take.
    const takeId = `take_${recipeId.replace(/^rcp_/, '')}`;
    if (store.has('takes', takeId)) {
      const shot = store.get('shots', shotId);
      if (!shot.headTakeId) store.put('shots', { ...shot, headTakeId: takeId });
      return { takeId, reused: true };
    }

    const output = await adapters.generate(recipe, { signal });

    const blobId = `out_${hashOf(output.content)}`;
    store.insert('blobs', { id: blobId, hash: hashOf(output.content), mime: output.mime, content: output.content, createdAt: now() });
    return { takeId: recordTake(job, recipe, { blobId, mime: output.mime, composition: output.composition }).id };
  }

  function recordTake(job, recipe, { blobId, mime, composition, ...extra }) {
    const { shotId, parentTakeId, promotedFromTakeId } = job.payload;
    const take = {
      id: `take_${recipe.id.replace(/^rcp_/, '')}`, shotId, recipeId: recipe.id, tier: recipe.resolutionTier, blobId, mime, composition,
      parentTakeId, promotedFromTakeId, jobId: job.id, modelId: recipe.modelId, seed: recipe.seed,
      n: store.list('takes', (t) => t.shotId === shotId).length + 1, createdAt: now(), ...extra,
    };
    store.insert('takes', take);
    store.put('shots', { ...store.get('shots', shotId), headTakeId: take.id });
    return take;
  }

  // ---------- hand-off ----------

  function handoffJob(jobId) {
    const job = store.get('jobs', jobId);
    if (!job || !job.byHand) throw refuse('That is not a hand-off job.');
    return job;
  }
  function handoffSheet(jobId) {
    const job = handoffJob(jobId);
    const recipe = store.get('recipes', job.payload.recipeId);
    const shot = store.get('shots', job.payload.shotId);
    const references = recipe.referenceAssetIds.map((assetId) => {
      const blob = store.get('blobs', assetId);
      return { assetId, missing: !blob, label: blob?.label, from: blob?.label || 'Vault', role: 'reference' };
    });
    const guidance = recipe.upscaleGuidance ? store.get('takes', recipe.upscaleGuidance.fromTakeId) : null;
    return { jobId, shotId: shot.id, shotName: shot.name, ...buildHandoffSheet({ recipe, model: modelById(recipe.modelId), shot, references, guidance }) };
  }

  // The result of a hand-off, brought back. From here on it is a take
  // like any other.
  function deliver(jobId, { bytes, mime = '', filename = null }) {
    const job = handoffJob(jobId);
    if (job.status !== 'waiting') throw refuse(`This hand-off is ${job.status}; it is not waiting for a file.`);
    const recipe = store.get('recipes', job.payload.recipeId);
    const model = modelById(recipe.modelId);
    // Interrupted between writing the take and closing the job: the take
    // is there, so close the job rather than make a second one.
    const existing = store.get('takes', `take_${recipe.id.replace(/^rcp_/, '')}`);
    if (existing) { queue.complete(jobId, { takeId: existing.id }); return { take: existing, job: store.get('jobs', jobId) }; }
    if (!bytes || bytes.length === 0) throw refuse('That file is empty.');
    if (!mime.startsWith(`${model.kind}/`)) throw refuse(`${store.get('shots', job.payload.shotId).name} needs ${model.kind === 'image' ? 'an image' : 'a video'} file; that was ${mime || 'an unknown type'}.`);

    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const blobId = `out_${hash}`;
    // The same file for two different takes is almost always the wrong
    // file picked in the dialog — and in a bake-off it would make two
    // generators look identical.
    const twin = store.list('takes', (t) => t.blobId === blobId)[0];
    if (twin) throw refuse(`That exact file is already take ${twin.n} of ${store.get('shots', twin.shotId).name}. Pick the file this hand-off produced.`);

    files.put(blobId, bytes);
    store.insert('blobs', { id: blobId, hash, mime, bytes: bytes.length, external: true, filename, createdAt: now() });
    const take = recordTake(job, recipe, { blobId, mime, composition: null, imported: true });
    queue.complete(jobId, { takeId: take.id });
    return { take, job: store.get('jobs', jobId) };
  }
  const reportRefusal = (jobId, message = '') => queue.fail(handoffJob(jobId).id, { kind: 'content_filter', message: message || 'The platform refused this prompt.' });
  const cancelHandoff = (jobId) => queue.cancel(handoffJob(jobId).id);

  function readBlob(blobId) {
    const blob = store.get('blobs', blobId);
    if (!blob) return null;
    return { mime: blob.mime, filename: blob.filename || blob.label || null, bytes: blob.external ? files.get(blobId) : Buffer.from(blob.content) };
  }

  // The same shot and seed to several generators, to be judged side by
  // side. Nothing is approved and no preference changes until asked.
  function bakeoff(shotId, { modelIds = [], seed = null } = {}) {
    const shot = store.get('shots', shotId);
    if (!shot) throw new Error('No such shot.');
    const kind = KIND_MODEL[shot.kind];
    const contenders = [...new Set(modelIds)].map((id) => modelById(id));
    if (contenders.length < 2 || contenders.some((m) => !m)) throw refuse('A bake-off needs at least two known generators.');
    const odd = contenders.find((m) => m.kind !== kind);
    if (odd) throw refuse(`${odd.label} makes ${odd.kind}; ${shot.name} is ${kind === 'image' ? 'a still' : 'a video shot'}.`);
    const batch = store.put('batches', { id: newId('bat'), kind: 'bakeoff', shotId, createdAt: now() });
    const shared = seed ?? randomSeed();
    return { batch, results: contenders.map((m) => ({ modelId: m.id, ...render(shotId, { modelId: m.id, seed: shared, batchId: batch.id }) })) };
  }

  // "This one" — make the generator that made a take the preference for
  // the look (or for the project, if the film has no look entry).
  function preferGeneratorOf(takeId) {
    const take = store.get('takes', takeId);
    if (!take) throw new Error('No such take.');
    const kind = modelById(take.modelId).kind;
    const look = headOfKind('look');
    setRouting({ entityId: look?.entity.id || null, kind, modelId: take.modelId });
    return { modelId: take.modelId, kind, scope: look ? 'look' : 'project', lookName: look?.entity.name || null };
  }

  // ---------- takes ----------

  const takesOf = (shotId) => store.list('takes', (t) => t.shotId === shotId).sort((a, b) => a.n - b.n);
  // The take a shot currently stands on: the approved one if there is
  // one, otherwise the latest.
  function currentTake(shot) {
    const id = shot.approvedTakeId || shot.headTakeId;
    return id ? store.get('takes', id) : null;
  }

  function approve(shotId, takeId) {
    const take = store.get('takes', takeId);
    if (!take || take.shotId !== shotId) throw new Error('That take does not belong to this shot.');
    const shot = store.get('shots', shotId);
    return store.put('shots', { ...shot, approvedTakeId: takeId });
  }

  // What would happen if this take were promoted, worked out before any
  // money is spent. Blockers stop the promotion; warnings are shown and
  // can be overridden by promoting anyway.
  //
  // Re-running a recipe at a higher resolution only gives the same shot
  // if the model treats the seed as binding. Where it does not, the
  // proxy's own frames are passed as guidance; where that is not
  // possible either, there is nothing to hold the composition, and a
  // master would be an expensive stranger.
  function promotionCheck(takeId) {
    const take = store.get('takes', takeId);
    if (!take) return { blockers: ['No such take.'], warnings: [], guided: false };
    const blockers = [];
    const warnings = [];
    let guided = false;
    if (take.tier !== 'proxy') blockers.push('This take is already a master.');
    else if (masterOf(take)) blockers.push('This take already has a master.');
    else {
      const model = modelById(store.get('recipes', take.recipeId).modelId);
      if (!model.seedLock) {
        if (model.supportsInitFrame) {
          guided = true;
          warnings.push(`${model.label} does not lock its seed across resolutions, so the master will be guided by this proxy's own frames. Compare them before delivery.`);
        } else {
          blockers.push(`${model.label} does not lock its seed and cannot be guided by the proxy, so a master would be a different shot. Re-render on a model that can hold the composition.`);
        }
      }
      const reasons = staleReasons(store.get('shots', take.shotId), take);
      if (reasons.length) {
        warnings.push(`This take is out of sync with the current story (${reasons.map((r) => r.message).join('; ')}). The master will match the proxy, not the current canon.`);
      }
    }
    return { blockers, warnings, guided };
  }

  // Proxy → master: re-run the take's own locked recipe with only the
  // resolution changed (plus, for a model with no seed lock, a pointer
  // to the proxy it must follow).
  function promote(takeId, { batchId = null } = {}) {
    const take = store.get('takes', takeId);
    if (!take) throw new Error('No such take.');
    const check = promotionCheck(takeId);
    if (check.blockers.length) throw Object.assign(new Error(check.blockers[0]), { refusal: true, blockers: check.blockers });
    const proxy = store.get('recipes', take.recipeId);
    const model = modelById(proxy.modelId);
    const master = promoteRecipe(proxy, model, { guidanceTakeId: check.guided ? take.id : null });
    const job = enqueueRecipe(master, { shotId: take.shotId, parentTakeId: take.id, promotedFromTakeId: take.id, batchId });
    return { job, recipe: master, changed: recipeDelta(proxy, master), warnings: check.warnings };
  }

  // Every approved proxy that has no master yet, as one batch. A batch
  // is not a deliberate decision about any one shot, so anything that
  // would need one — a stale take, a blocked promotion — is skipped and
  // reported rather than mastered blindly.
  function promoteApproved({ sceneId = null } = {}) {
    const batch = store.put('batches', { id: newId('bat'), kind: 'promote', createdAt: now() });
    const results = [];
    const skipped = [];
    store.list('shots', (s) => s.approvedTakeId && (!sceneId || s.sceneId === sceneId)).forEach((shot) => {
      const take = store.get('takes', shot.approvedTakeId);
      if (take.tier !== 'proxy' || masterOf(take)) return;
      const check = promotionCheck(take.id);
      const stale = check.warnings.find((w) => /out of sync/.test(w));
      if (check.blockers.length || stale) {
        skipped.push({ shotId: shot.id, name: shot.name, reason: check.blockers[0] || stale });
        return;
      }
      results.push({ shotId: shot.id, ...promote(take.id, { batchId: batch.id }) });
    });
    return { batch, results, skipped };
  }

  const masterOf = (take) => store.list('takes', (t) => t.promotedFromTakeId === take.id)[0] || null;

  // A new line of takes from any earlier one: the same locked recipe
  // with a different seed. The original is untouched.
  function branch(takeId, { seed = null } = {}) {
    const take = store.get('takes', takeId);
    if (!take) throw new Error('No such take.');
    const base = store.get('recipes', take.recipeId);
    const shot = store.get('shots', take.shotId);
    const scene = store.get('scenes', shot.sceneId);
    const { id, promotedFromRecipeId, upscaleGuidance, ...body } = base;
    const variant = buildFromBody({ ...body, seed: seed ?? randomSeed(), resolutionTier: 'proxy', resolution: modelById(base.modelId).tiers.proxy });
    return { job: enqueueRecipe(variant, { shotId: shot.id, parentTakeId: take.id }), recipe: variant, scene };
  }
  function buildFromBody(body) {
    const { inputs, ...identity } = body;
    return { id: `rcp_${hashOf(identity)}`, ...structuredClone(body) };
  }

  // ---------- staleness ----------

  // Why a given take no longer matches what the shot would compile to
  // today. Compares what the take's recipe was built from with the
  // current heads; never modifies anything.
  function staleReasons(shot, take) {
    const recipe = store.get('recipes', take.recipeId);
    const scene = store.get('scenes', shot.sceneId);
    const world = worldFor(shot, scene);
    const reasons = [];

    const now_ = Object.fromEntries([...world.characters, world.location, ...world.props, world.look, world.format].filter(Boolean).map((h) => [h.entity.id, h]));
    const then = recipe.inputs.bibleVersionIds;
    Object.entries(now_).forEach(([entityId, h]) => {
      if (!(entityId in then)) reasons.push({ kind: 'bible', entityId, name: h.entity.name, message: `${h.entity.name} was added since this take` });
      else if (then[entityId] !== h.version.id) reasons.push({ kind: 'bible', entityId, name: h.entity.name, message: `${h.entity.name} changed (now v${h.version.n})` });
    });
    Object.keys(then).filter((id) => !(id in now_)).forEach((entityId) => {
      reasons.push({ kind: 'bible', entityId, name: store.get('bible', entityId)?.name || entityId, message: `${store.get('bible', entityId)?.name || 'An entry'} is no longer in this shot` });
    });
    if (recipe.inputs.sceneRev !== sceneRevision(scene)) reasons.push({ kind: 'scene', message: 'The scene changed' });
    if (recipe.inputs.shotRev !== shotRevision(shot)) reasons.push({ kind: 'shot', message: 'The shot itself was edited' });
    return reasons;
  }

  function staleness(shotId) {
    const shot = store.get('shots', shotId);
    const take = currentTake(shot);
    if (!take) return { state: 'empty', reasons: [] };
    const reasons = staleReasons(shot, take);

    const master = take.tier === 'master' ? take : masterOf(take);
    // An approved take that has gone stale stays approved until a person
    // approves its replacement. If a take compiled from today's canon
    // already exists, the shot is not waiting on a render any more — it
    // is waiting on that decision, and says which take to look at.
    if (reasons.length && shot.approvedTakeId) {
      const candidate = takesOf(shotId).filter((t) => t.id !== take.id && t.tier === 'proxy' && !staleReasons(shot, t).length).pop();
      if (candidate) return { state: 'review', reasons, takeId: take.id, candidateTakeId: candidate.id, hasMaster: !!master };
    }
    const state = reasons.length ? 'stale' : shot.approvedTakeId ? (master ? 'mastered' : 'approved') : 'draft';
    return { state, reasons, takeId: take.id, candidateTakeId: null, hasMaster: !!master };
  }

  // Re-render exactly the shots asked for — normally the stale ones —
  // as new proxy takes on the same seed, so the framing carries over.
  // Approved takes stay approved until someone approves a replacement.
  function rerender(shotIds) {
    const batch = store.put('batches', { id: newId('bat'), kind: 'rerender', createdAt: now() });
    const results = shotIds.map((shotId) => {
      const shot = store.get('shots', shotId);
      const take = currentTake(shot);
      if (staleness(shotId).state === 'review') return { shotId, skipped: 'A fresh take is already waiting for review.' };
      try {
        return { shotId, ...render(shotId, { seed: take?.seed ?? null, parentTakeId: take?.id || null, batchId: batch.id }) };
      } catch (error) {
        return { shotId, error: error.message };
      }
    });
    return { batch, results };
  }

  // ---------- recovery ----------

  // The failed recipe, recompiled for the model's declared fallback:
  // same shot, same seed, same references — a different model needs a
  // different prompt dialect and has a different budget.
  function retryWithFallback(jobId) {
    const job = store.get('jobs', jobId);
    const recipe = store.get('recipes', job.payload.recipeId);
    const fallback = modelById(modelById(recipe.modelId)?.fallback);
    if (!fallback) throw new Error(`${recipe.modelId} has no fallback model.`);
    return render(job.payload.shotId, {
      tier: recipe.resolutionTier, seed: recipe.seed, modelId: fallback.id,
      parentTakeId: job.payload.parentTakeId, batchId: job.batchId, fallbackOf: job.id,
    });
  }

  // ---------- views ----------

  function graph() {
    const nodes = [];
    const edges = [];
    store.list('bible').forEach((e) => nodes.push({ id: e.id, type: 'bible', kind: e.kind, label: e.name, version: store.get('bibleVersions', e.headVersionId).n }));
    store.list('scenes').sort((a, b) => a.order - b.order).forEach((s) => {
      nodes.push({ id: s.id, type: 'scene', label: s.name });
      if (s.locationId) edges.push({ from: s.locationId, to: s.id });
    });
    store.list('shots').forEach((shot) => {
      const status = staleness(shot.id);
      nodes.push({ id: shot.id, type: 'shot', label: shot.name, sceneId: shot.sceneId, state: status.state, reasons: status.reasons });
      edges.push({ from: shot.sceneId, to: shot.id });
      [...shot.characterIds, ...shot.propIds].forEach((id) => edges.push({ from: id, to: shot.id }));
      edges.forEach((edge) => {
        if (edge.to === shot.id) edge.stale = status.reasons.some((r) => r.entityId === edge.from || (r.kind === 'scene' && edge.from === shot.sceneId));
      });
    });
    return { nodes, edges };
  }

  function board() {
    return store.list('scenes').sort((a, b) => a.order - b.order).map((scene) => ({
      ...scene,
      shots: store.list('shots', (s) => s.sceneId === scene.id).sort((a, b) => a.order - b.order).map((shot) => {
        const take = currentTake(shot);
        return { ...shot, status: staleness(shot.id), take, master: take ? (take.tier === 'master' ? take : masterOf(take)) : null, takeCount: takesOf(shot.id).length };
      }),
    }));
  }

  // Delivery: the cut, as a list of approved takes in order.
  function exportManifest() {
    const rows = board().flatMap((scene) => scene.shots.map((shot) => {
      const final = shot.master || shot.take;
      return { scene: scene.name, shot: shot.name, durationS: shot.durationS, state: shot.status.state, tier: final?.tier || null, takeId: final?.id || null, recipeId: final?.recipeId || null };
    }));
    return { generatedAt: now(), ready: rows.every((r) => r.state === 'mastered'), totalS: rows.reduce((s, r) => s + (r.durationS || 0), 0), rows };
  }

  return {
    store, queue, models: MODELS,
    createEntity, reviseEntity, addVaultAsset, head, downstreamShots,
    createScene, updateScene, createShot, updateShot,
    inspect, applyRefine, setLock,
    render, promote, promotionCheck, promoteApproved, branch, approve, rerender, retryWithFallback,
    setRouting, routing, handoffSheet, deliver, reportRefusal, cancelHandoff, readBlob, bakeoff, preferGeneratorOf,
    takesOf, currentTake, masterOf, staleness, graph, board, exportManifest,
  };
}
