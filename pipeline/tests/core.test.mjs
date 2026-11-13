// The pipeline's core promises, end to end through the studio service:
// compile, render a proxy, approve, promote to master, edit canon.
import { makeChecker, seedFilm, testStudio } from './helpers.mjs';
import { ModelError } from '../src/adapters.mjs';
import { INVARIANT_FIELDS } from '../src/recipe.mjs';
import { hashOf } from '../src/ids.mjs';

const { eq, done } = makeChecker();

console.log('--- the prompt compiler ---');
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  const view = studio.inspect(film.shots[0].id);

  eq(view.model.id, 'sketch-v1', 'a storyboard frame goes to the image model');
  eq(view.compiled.prompt.startsWith('WES_V1, lean man in his forties, sun-worn, wearing canvas jacket, Wes walks in'), true,
    "the character's trigger word, description and wardrobe come from the Bible, not the note");
  eq(view.compiled.prompt.includes('a disused aircraft hangar'), true, "the location comes from the scene's Bible entry");
  eq(view.compiled.prompt.includes('low warm sun, dawn'), true, 'lighting and time of day come from the scene');
  eq(view.compiled.prompt.includes('aspect ratio 2.39:1'), true, 'the format comes from the project');
  eq(view.compiled.negativePrompt, 'text, watermark', "the look's negatives go to the negative prompt");
  eq(view.compiled.clauses.find((c) => c.key === 'subject').source, 'Story Bible · characters', 'every clause knows where it came from');
  eq(view.references.map((r) => r.role), ['character', 'location'], 'reference sheets are attached without being asked for');

  const video = studio.inspect(film.shots[2].id);
  eq([video.model.id, video.compiled.prompt.includes('. ')], ['motion-v2', true], 'a video shot gets the video model and its prose dialect');
}

console.log('\n--- critic → refine, locks, diff ---');
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  const id = film.shots[0].id;
  studio.updateShot(id, { notes: 'Wes walks in, stunning 8k, no rain, then he sits down. Ana waits at night' });

  const codes = studio.inspect(id).issues.map((i) => i.code);
  eq(['negation', 'filler', 'multi-beat', 'time-conflict', 'unattached-character'].every((c) => codes.includes(c)), true,
    'the critic catches a negation, filler, two beats, a time conflict and an unattached character');

  const refined = studio.applyRefine(id);
  eq(refined.changes.length, 2, 'refine fixes the two it can fix by itself');
  const after = studio.inspect(id);
  eq([/no rain|stunning|8k/i.test(after.compiled.prompt), after.compiled.negativePrompt], [false, 'text, watermark, rain'],
    'the negation moved to the negative prompt and the filler is gone');
  eq(after.issues.some((i) => i.code === 'multi-beat'), true, 'what needs a human decision is still flagged, not guessed at');
  eq(studio.store.get('shots', id).notes.includes('stunning'), true, "the creator's own note is left as they wrote it");

  studio.setLock(id, 'lighting', 'hard top light, no fill');
  const locked = studio.inspect(id).compiled.clauses.find((c) => c.key === 'lighting');
  eq([locked.text, locked.locked, locked.source], ['hard top light, no fill', true, 'Locked by you'], 'a locked clause is used verbatim');
  studio.updateScene(film.scene.id, { lighting: 'overcast' });
  eq(studio.inspect(id).compiled.clauses.find((c) => c.key === 'lighting').text, 'hard top light, no fill', 'and survives an upstream change');
}

console.log('\n--- the prompt budget ---');
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  const id = film.shots[0].id;
  studio.updateShot(id, { notes: `Wes walks in ${'slowly and carefully across the wide dusty concrete floor '.repeat(6)}` });
  const view = studio.inspect(id);
  eq(view.compiled.tokens <= view.compiled.budget, true, `an overlong prompt is brought inside the model's limit (${view.compiled.tokens}/${view.compiled.budget})`);
  eq(view.compiled.dropped.includes('subject') || view.compiled.dropped.includes('action'), false, 'by dropping grade and format before who and what');

  studio.setLock(id, 'look', 'bleached 70s anamorphic');
  eq(studio.inspect(id).compiled.dropped.includes('look'), false, 'a locked clause is never the one dropped');

  studio.setLock(id, 'action', 'word '.repeat(120));
  const blocked = studio.inspect(id);
  eq([!!blocked.compiled.blocked, blocked.blockers.length > 0], [true, true], 'locked clauses that cannot fit are a blocker, not a silent truncation');
  let refused = null;
  try { studio.render(id); } catch (error) { refused = error.message; }
  eq(/locked clauses alone/.test(refused || ''), true, 'and the render is refused before any compute is spent');
}

console.log('\n--- continuity ---');
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  const id = film.shots[0].id;
  studio.updateShot(id, { notes: 'Wes walks in wearing a red suit', lighting: 'neon', aspectRatio: '16:9' });
  const codes = studio.inspect(id).continuity.map((w) => w.code).sort();
  eq(codes, ['aspect-drift', 'lighting-shift', 'wardrobe'], 'wardrobe, lighting and aspect ratio breaks are flagged before rendering');

  const ghost = studio.createEntity({ kind: 'character', name: 'Ghost', fields: { trigger: 'GHOST' } });
  studio.updateShot(id, { characterIds: [ghost.id], notes: 'Ghost stands', lighting: '', aspectRatio: '' });
  eq(studio.inspect(id).continuity.map((w) => w.code), ['no-reference'], 'a character with no turnaround is flagged as an identity risk');
}

console.log('\n--- proxy first, then master ---');
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  const id = film.shots[0].id;

  const { job, recipe } = studio.render(id, { seed: 42 });
  eq([recipe.resolutionTier, recipe.resolution], ['proxy', { w: 512, h: 288 }], 'a render is a proxy unless told otherwise');
  eq(Object.isFrozen(recipe) && Object.isFrozen(recipe.inputs), true, 'the recipe is frozen');
  await studio.queue.drain();
  eq(studio.store.get('jobs', job.id).status, 'succeeded', 'the job completes');

  const [proxy] = studio.takesOf(id);
  studio.approve(id, proxy.id);
  const promotion = studio.promote(proxy.id);
  eq(promotion.changed.sort(), ['promotedFromRecipeId', 'resolution', 'resolutionTier'], 'promotion changes the resolution and nothing else');
  await studio.queue.drain();

  const master = studio.masterOf(proxy);
  const a = studio.store.get('recipes', proxy.recipeId);
  const b = studio.store.get('recipes', master.recipeId);
  eq(INVARIANT_FIELDS.map((f) => hashOf(a[f] ?? null) === hashOf(b[f] ?? null)), INVARIANT_FIELDS.map(() => true),
    'seed, prompt, negatives, references, model and controls are identical in the master recipe');
  eq([b.resolutionTier, b.resolution], ['master', { w: 2048, h: 1152 }], 'only the tier and resolution moved');
  eq(master.composition, proxy.composition, 'and the master is the same composition as the proxy');
  eq([master.promotedFromTakeId, master.parentTakeId], [proxy.id, proxy.id], 'the master records which proxy it came from');
  eq(studio.staleness(id).state, 'mastered', 'the shot reads as mastered');

  let threw = null;
  try { studio.store.put('recipes', { ...a, seed: 7 }); } catch (error) { threw = error.message; }
  eq(/immutable/.test(threw || ''), true, 'a stored recipe cannot be edited');
}

console.log('\n--- editing canon ripples downstream, and overwrites nothing ---');
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  for (const shot of film.shots) studio.render(shot.id, { seed: 7 });
  await studio.queue.drain();
  film.shots.forEach((shot) => studio.approve(shot.id, studio.takesOf(shot.id)[0].id));
  const approvedBefore = film.shots.map((s) => studio.store.get('shots', s.id).approvedTakeId);
  eq(film.shots.map((s) => studio.staleness(s.id).state), ['approved', 'approved', 'approved'], 'three approved shots');

  const { affected } = studio.reviseEntity(film.wes.id, { fields: { wardrobe: 'oilskin coat' } });
  eq(affected.sort(), [film.shots[0].id, film.shots[1].id].sort(), 'revising Wes names exactly the shots he is in');
  eq(film.shots.map((s) => studio.staleness(s.id).state), ['stale', 'stale', 'approved'], "those go stale; Ana's solo shot does not");
  eq(studio.staleness(film.shots[0].id).reasons[0].message, 'Wes changed (now v2)', 'with the reason');
  eq(film.shots.map((s) => studio.store.get('shots', s.id).approvedTakeId), approvedBefore, 'no approved take was touched');

  const { results } = studio.rerender(affected);
  await studio.queue.drain();
  eq(results.length, 2, 'a selective re-render queues only the stale shots');
  eq(studio.takesOf(film.shots[2].id).length, 1, 'the unaffected shot was not regenerated');
  eq(film.shots.map((s) => studio.store.get('shots', s.id).approvedTakeId), approvedBefore, 'the approved takes are still the approved takes');
  const fresh = studio.takesOf(film.shots[0].id)[1];
  eq(studio.store.get('recipes', fresh.recipeId).compiledPrompt.includes('oilskin coat'), true, 'the new take carries the new canon');
  eq([fresh.seed, fresh.parentTakeId], [7, approvedBefore[0]], 'on the same seed, descended from the take it replaces');
  studio.approve(film.shots[0].id, fresh.id);
  eq(studio.staleness(film.shots[0].id).state, 'approved', 'approving the new take clears the flag');
}

console.log('\n--- failures, sorted by what can be done about them ---');
{
  const failures = { 1: 'transient', 2: 'transient' };
  const { studio, adapters } = testStudio({ faults: (recipe, attempt) => { if (failures[attempt]) throw new ModelError(failures[attempt], 'upstream 503'); } });
  const film = seedFilm(studio);
  const { job } = studio.render(film.shots[0].id, { seed: 1 });
  await studio.queue.drain();
  const finished = studio.store.get('jobs', job.id);
  eq([finished.status, finished.attempts], ['succeeded', 3], 'a transient fault is retried until it works');
  eq(studio.takesOf(film.shots[0].id).length, 1, 'and produces one take, not three');
  eq(adapters.calls.get(job.payload.recipeId), 3, 'after three calls to the model');
}
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  studio.updateShot(film.shots[0].id, { notes: 'Wes walks in FILTERME' });
  const { job } = studio.render(film.shots[0].id, { seed: 1 });
  await studio.queue.drain();
  const failed = studio.store.get('jobs', job.id);
  eq([failed.status, failed.attempts, failed.error.class, failed.error.action], ['failed', 1, 'content_filter', 'edit'],
    'a content-filter refusal fails once and is not retried — the same prompt would be refused again');
}
{
  const { studio } = testStudio({ faults: (recipe) => { if (recipe.modelId === 'motion-v2') throw new ModelError('timeout', 'model overloaded'); } });
  const film = seedFilm(studio);
  const { job, recipe } = studio.render(film.shots[2].id, { seed: 9 });
  await studio.queue.drain();
  eq([studio.store.get('jobs', job.id).status, studio.store.get('jobs', job.id).attempts], ['failed', 3], 'a model that stays down fails after its attempts');

  const fallback = studio.retryWithFallback(job.id);
  await studio.queue.drain();
  eq([fallback.recipe.modelId, fallback.recipe.seed, fallback.job.fallbackOf], ['motion-lite', 9, job.id], 'retry with fallback keeps the seed and switches model');
  eq(hashOf(fallback.recipe.referenceAssetIds), hashOf(recipe.referenceAssetIds), 'with the same references');
  eq(studio.takesOf(film.shots[2].id).length, 1, 'and the shot gets its take');
}

console.log('\n--- a batch that half fails ---');
{
  let down = true;
  const { studio } = testStudio({ faults: (recipe) => { if (down && recipe.compiledPrompt.includes('ANA_V1')) throw new ModelError('timeout', 'down'); } });
  const film = seedFilm(studio);
  const { batch } = studio.rerender(film.shots.map((s) => s.id));
  await studio.queue.drain();
  const statuses = () => studio.store.list('jobs', (j) => j.batchId === batch.id).map((j) => j.status).sort();
  eq(statuses(), ['failed', 'failed', 'succeeded'], 'one of three shots renders; two fail');

  down = false;
  const resumed = studio.queue.resumeBatch(batch.id);
  await studio.queue.drain();
  eq(resumed, { requeued: 2, alreadyDone: 1, total: 3 }, 'resume re-queues the two that failed');
  eq(statuses(), ['succeeded', 'succeeded', 'succeeded'], 'and the batch completes');
  eq(film.shots.map((s) => studio.takesOf(s.id).length), [1, 1, 1], 'with exactly one take per shot — the finished one was not redone');
}

console.log('\n--- the same request twice ---');
{
  const { studio, adapters } = testStudio();
  const film = seedFilm(studio);
  const first = studio.render(film.shots[0].id, { seed: 5 });
  const second = studio.render(film.shots[0].id, { seed: 5 });
  await studio.queue.drain();
  eq([second.job.id === first.job.id, second.job.deduped], [true, true], 'an identical render request is the same job');
  eq([studio.takesOf(film.shots[0].id).length, adapters.calls.get(first.recipe.id)], [1, 1], 'one take, one call to the model');
}

console.log('\n--- branching ---');
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  studio.render(film.shots[0].id, { seed: 11 });
  await studio.queue.drain();
  const [first] = studio.takesOf(film.shots[0].id);
  studio.branch(first.id, { seed: 12 });
  studio.branch(first.id, { seed: 13 });
  await studio.queue.drain();
  const takes = studio.takesOf(film.shots[0].id);
  eq(takes.map((t) => [t.seed, t.parentTakeId]), [[11, null], [12, first.id], [13, first.id]], 'two branches from one take, each recording its parent');
  eq(new Set(takes.map((t) => t.composition)).size, 3, 'each a different composition');
  eq(studio.store.get('recipes', takes[1].recipeId).compiledPrompt, studio.store.get('recipes', first.recipeId).compiledPrompt, 'from the same locked prompt');
}

done();
