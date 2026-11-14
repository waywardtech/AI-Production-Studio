// Hardening cycle 2: promoting a proxy to master without it becoming a
// different shot.
//
// Re-running a recipe at a higher resolution only preserves the shot if
// the model treats the seed as binding and nothing the recipe depends on
// has moved. These cases are the ways that quietly stops being true.
import { makeChecker, seedFilm, testStudio } from './helpers.mjs';
import { ModelError, modelById } from '../src/adapters.mjs';
import { INVARIANT_FIELDS, promoteRecipe } from '../src/recipe.mjs';
import { hashOf } from '../src/ids.mjs';

const { eq, done } = makeChecker();
const sameInvariants = (a, b) => INVARIANT_FIELDS.every((f) => hashOf(a[f] ?? null) === hashOf(b[f] ?? null));

console.log('--- a model that does not lock its seed ---');
{
  // motion-lite is where a video shot lands after "retry with fallback".
  // The same seed at another resolution is, to it, a different clip.
  const { studio } = testStudio({ faults: (recipe) => { if (recipe.modelId === 'motion-v2') throw new ModelError('timeout', 'down'); } });
  const film = seedFilm(studio);
  const shotId = film.shots[2].id;
  const { job } = studio.render(shotId, { seed: 21 });
  await studio.queue.drain();
  studio.retryWithFallback(job.id);
  await studio.queue.drain();
  const [proxy] = studio.takesOf(shotId);
  eq([proxy.modelId, modelById(proxy.modelId).seedLock], ['motion-lite', false], 'the proxy was made by the fallback model, which has no seed lock');

  const check = studio.promotionCheck(proxy.id);
  eq(check.warnings.some((w) => /does not lock its seed/.test(w)), true, 'the creator is warned before promoting, not after');
  eq(check.guided, true, "and told the proxy's own frames will be used to guide the master");

  const promotion = studio.promote(proxy.id);
  await studio.queue.drain();
  const master = studio.masterOf(proxy);
  const a = studio.store.get('recipes', proxy.recipeId);
  const b = studio.store.get('recipes', master.recipeId);
  eq(sameInvariants(a, b), true, 'seed, prompt, references, model and controls are still identical');
  eq(b.upscaleGuidance, { mode: 'init-frame', fromTakeId: proxy.id }, 'the master recipe records what it was guided by');
  eq(promotion.changed.sort(), ['promotedFromRecipeId', 'resolution', 'resolutionTier', 'upscaleGuidance'], 'and that guidance is the only addition beyond resolution');
  eq(master.composition, proxy.composition, 'so the master is the same shot — unguided, this model draws a different one');
}

console.log('\n--- a model with no seed lock and no way to guide it ---');
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  studio.render(film.shots[2].id, { seed: 5, modelId: 'motion-lite' });
  await studio.queue.drain();
  const [proxy] = studio.takesOf(film.shots[2].id);
  const lite = modelById('motion-lite');
  const had = lite.supportsInitFrame;
  lite.supportsInitFrame = false;
  try {
    const check = studio.promotionCheck(proxy.id);
    eq(check.blockers.length, 1, 'promotion is blocked: there is nothing to hold the composition');
    let refused = null;
    try { studio.promote(proxy.id); } catch (error) { refused = error; }
    eq([!!refused, refused?.refusal], [true, true], 'and promote() refuses rather than rendering an expensive stranger');
    eq(studio.store.list('jobs', (j) => j.label?.includes('master')).length, 0, 'no master job was queued');
  } finally {
    lite.supportsInitFrame = had;
  }
}

console.log('\n--- promoting a take that has gone out of date ---');
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  for (const shot of film.shots.slice(0, 2)) studio.render(shot.id, { seed: 8 });
  await studio.queue.drain();
  film.shots.slice(0, 2).forEach((shot) => studio.approve(shot.id, studio.takesOf(shot.id)[0].id));
  studio.reviseEntity(film.ana.id, { fields: { wardrobe: 'flight suit' } }); // Ana is only in the second shot

  const stale = studio.takesOf(film.shots[1].id)[0];
  eq(studio.promotionCheck(stale.id).warnings.some((w) => /out of sync/.test(w) && /Ana changed/.test(w)), true,
    'promoting a stale take warns that the master would show superseded canon, and says what changed');

  const { results, skipped } = studio.promoteApproved();
  eq(results.map((r) => r.shotId), [film.shots[0].id], 'the batch promotes the shot that is current');
  eq(skipped.map((s) => [s.shotId, /out of sync/.test(s.reason)]), [[film.shots[1].id, true]], 'and skips the stale one, saying why, instead of mastering it blindly');
  await studio.queue.drain();
  eq([studio.staleness(film.shots[0].id).state, studio.staleness(film.shots[1].id).state], ['mastered', 'stale'], 'one mastered, one still waiting on a decision');

  // It remains possible on purpose — the old canon may be what is wanted.
  studio.promote(stale.id);
  await studio.queue.drain();
  eq(studio.store.get('recipes', studio.masterOf(stale).recipeId).compiledPrompt.includes('grey coveralls'), true,
    'promoted deliberately, it is still the locked recipe that runs: the master matches the proxy, not the new canon');
}

console.log('\n--- promotion is one job, however often it is asked for ---');
{
  const { studio, adapters } = testStudio();
  const film = seedFilm(studio);
  studio.render(film.shots[0].id, { seed: 3 });
  await studio.queue.drain();
  const [proxy] = studio.takesOf(film.shots[0].id);
  const first = studio.promote(proxy.id);
  const second = studio.promote(proxy.id);
  await studio.queue.drain();
  eq([second.job.id === first.job.id, adapters.calls.get(first.recipe.id)], [true, 1], 'promoting twice renders the master once');
  const master = studio.masterOf(proxy);
  eq(studio.promotionCheck(master.id).blockers.length, 1, 'a master cannot itself be promoted');
  eq(studio.promotionCheck(proxy.id).blockers.some((b) => /already has a master/.test(b)), true, 'and a proxy that has its master says so');
}

console.log('\n--- a model whose master is a different shape ---');
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  const { recipe } = studio.render(film.shots[0].id, { seed: 4 });
  const odd = { ...modelById('sketch-v1'), tiers: { proxy: { w: 512, h: 288 }, master: { w: 2048, h: 2048 } } };
  let refused = null;
  try { promoteRecipe(recipe, odd); } catch (error) { refused = error.message; }
  eq(/aspect ratio/.test(refused || ''), true, 'a master tier with a different aspect ratio is refused — the framing could not survive it');
}

done();
