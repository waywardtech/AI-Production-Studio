// Making takes by hand, through a chat subscription, with no API.
//
// A "hand-off" generator cannot be called. Asking it for a take produces
// a job that waits for a person: the studio writes out exactly what to
// paste and attach, and the person brings the result back. Everything
// downstream — takes, approval, promotion, staleness — must then behave
// as it does for a take a model returned by itself.
import { makeChecker, seedFilm, testStudio } from './helpers.mjs';
import { modelById, MODELS } from '../src/adapters.mjs';

const { eq, done } = makeChecker();
const png = (label) => Buffer.from(`\x89PNG fake ${label}`);
const mp4 = (label) => Buffer.from(`ftypmp42 fake ${label}`);
const calls = (adapters) => [...adapters.calls.values()].reduce((a, b) => a + b, 0);
const refusal = (fn) => { try { fn(); return null; } catch (error) { return error.refusal ? error.message : `not a refusal: ${error.message}`; } };

console.log('--- the generators on offer ---');
{
  const byHand = MODELS.filter((m) => m.mode === 'handoff');
  eq(byHand.map((m) => `${m.provider}:${m.kind}`).sort(), ['chatgpt:image', 'chatgpt:video', 'gemini:image', 'gemini:video'], 'ChatGPT and Gemini, each for stills and for video');
  eq(byHand.every((m) => m.seedLock === false && m.supportsInitFrame === true && /^https:\/\//.test(m.url)), true, 'none of them locks a seed; all of them can be shown a picture to follow');
}

console.log('\n--- a render becomes a job that waits for a person ---');
{
  const { studio, adapters } = testStudio();
  const film = seedFilm(studio);
  const shot = film.shots[0];
  const { job } = studio.render(shot.id, { modelId: 'chatgpt-image', seed: 4 });
  await studio.queue.drain();
  eq([studio.store.get('jobs', job.id).status, calls(adapters), studio.takesOf(shot.id).length], ['waiting', 0, 0], 'drained, the job is still waiting: no model was called and no take invented');

  const sheet = studio.handoffSheet(job.id);
  eq([sheet.provider, /^https:\/\/chatgpt\.com/.test(sheet.url)], ['chatgpt', true], 'the sheet says where to take it');
  eq(sheet.message.includes(studio.store.get('recipes', job.payload.recipeId).compiledPrompt), true, 'what to paste contains the compiled prompt, word for word');
  eq(sheet.attachments.map((a) => a.label), ['Wes turnaround', 'Hangar plate'], 'and lists the reference images to attach, from the vault');

  eq(/image/.test(refusal(() => studio.deliver(job.id, { bytes: mp4('x'), mime: 'video/mp4' })) || ''), true, 'a video is refused for a still');
  eq(!!refusal(() => studio.deliver(job.id, { bytes: Buffer.alloc(0), mime: 'image/png' })), true, 'and so is an empty file');

  const { take } = studio.deliver(job.id, { bytes: png('1A'), mime: 'image/png', filename: 'wes.png' });
  const recipe = studio.store.get('recipes', take.recipeId);
  eq([studio.store.get('jobs', job.id).status, take.modelId, take.seed, take.imported, take.tier], ['succeeded', 'chatgpt-image', 4, true, 'proxy'], 'importing the result finishes the job and makes an ordinary proxy take');
  eq(Buffer.compare(studio.readBlob(take.blobId).bytes, png('1A')), 0, 'the file comes back byte for byte');
  eq(recipe.id, job.payload.recipeId, 'and the take is tied to the recipe that was handed off');
  eq(!!refusal(() => studio.deliver(job.id, { bytes: png('again'), mime: 'image/png' })), true, 'a finished hand-off cannot be delivered twice');

  studio.approve(shot.id, take.id);
  studio.reviseEntity(film.wes.id, { fields: { wardrobe: 'oilskin coat' } });
  eq(studio.staleness(shot.id).state, 'stale', 'an imported take goes out of sync like any other');
}

console.log('\n--- survives a restart, and never times out ---');
{
  const { studio } = testStudio({ queueOptions: { timeoutMs: 30 } });
  const film = seedFilm(studio);
  const { job } = studio.render(film.shots[0].id, { modelId: 'gemini-image' });
  await new Promise((r) => setTimeout(r, 80));
  await studio.queue.drain();
  studio.queue.recover();
  eq(studio.store.get('jobs', job.id).status, 'waiting', 'a person is not a stalled process: the job waits past any timeout and through recovery');
  eq(studio.render(film.shots[0].id, { modelId: 'gemini-image', seed: studio.store.get('recipes', job.payload.recipeId).seed }).job.id, job.id, 'asking again for the same thing does not open a second hand-off');
}

console.log('\n--- when the platform says no, or you change your mind ---');
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  const a = studio.render(film.shots[0].id, { modelId: 'chatgpt-image', seed: 1 }).job;
  studio.reportRefusal(a.id, 'It would not draw this.');
  const failed = studio.store.get('jobs', a.id);
  eq([failed.status, failed.error.class, failed.error.retryable], ['failed', 'content_filter', false], 'a refusal is recorded as a content-filter failure, with the same advice as any other');
  studio.queue.retry(a.id);
  await studio.queue.drain();
  eq(studio.store.get('jobs', a.id).status, 'waiting', 'retrying it goes back to waiting for a person — it is never sent to a model');

  studio.cancelHandoff(a.id);
  eq(studio.store.get('jobs', a.id).status, 'cancelled', 'a hand-off can be withdrawn');
  eq(!!refusal(() => studio.deliver(a.id, { bytes: png('late'), mime: 'image/png' })), true, 'and then takes no delivery');
}

console.log('\n--- routing: which generator a shot goes to ---');
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  const [still, , video] = film.shots;
  eq([studio.inspect(still.id).model.id, studio.inspect(still.id).routedBy], ['sketch-v1', 'default'], 'with nothing set, the built-in default');
  studio.setRouting({ kind: 'image', modelId: 'gemini-image' });
  eq([studio.inspect(still.id).model.id, studio.inspect(still.id).routedBy, studio.inspect(video.id).model.kind], ['gemini-image', 'project', 'video'], 'a project default applies to stills and leaves video alone');

  const before = film.shots.map((s) => studio.staleness(s.id).state);
  const lookVersion = studio.head(film.look.id).version.id;
  studio.setRouting({ entityId: film.look.id, kind: 'image', modelId: 'chatgpt-image' });
  eq([studio.inspect(still.id).model.id, studio.inspect(still.id).routedBy], ['chatgpt-image', 'look'], 'the look\'s own preference wins over the project default');
  eq([studio.head(film.look.id).version.id === lookVersion, film.shots.map((s) => studio.staleness(s.id).state)], [true, before], 'choosing a generator is not a change of canon: no new version, nothing marked out of sync');
  eq(studio.inspect(still.id, { modelId: 'sketch-v1' }).routedBy, 'shot', 'and an explicit choice for one render wins over both');

  eq(!!refusal(() => studio.setRouting({ kind: 'image', modelId: 'gemini-video' })), true, 'a video generator cannot be routed stills');
  eq(!!refusal(() => studio.setRouting({ entityId: film.wes.id, kind: 'image', modelId: 'gemini-image' })), true, 'and only a look carries a preference');
  studio.setRouting({ entityId: film.look.id, kind: 'image', modelId: null });
  eq(studio.inspect(still.id).routedBy, 'project', 'clearing the look\'s preference falls back to the project');
}

console.log('\n--- a bake-off: one shot, two generators, your eye decides ---');
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  const shot = film.shots[0];
  const { batch, results } = studio.bakeoff(shot.id, { modelIds: ['chatgpt-image', 'gemini-image'] });
  const recipes = results.map((r) => r.recipe);
  eq([results.length, recipes[0].seed === recipes[1].seed, recipes.map((r) => r.modelId)], [2, true, ['chatgpt-image', 'gemini-image']], 'the same shot and seed go to each generator');
  eq(results.every((r) => studio.store.get('jobs', r.job.id).batchId === batch.id), true, 'as one batch');
  eq(!!refusal(() => studio.bakeoff(shot.id, { modelIds: ['chatgpt-image', 'gemini-video'] })), true, 'a video generator cannot enter a stills bake-off');

  const a = studio.deliver(results[0].job.id, { bytes: png('from chatgpt'), mime: 'image/png' }).take;
  eq(/already/.test(refusal(() => studio.deliver(results[1].job.id, { bytes: png('from chatgpt'), mime: 'image/png' })) || ''), true, 'importing the same file for the other contender is caught as a slip');
  const b = studio.deliver(results[1].job.id, { bytes: png('from gemini'), mime: 'image/png' }).take;
  eq(studio.takesOf(shot.id).map((t) => t.modelId), ['chatgpt-image', 'gemini-image'], 'both takes sit side by side on the shot');

  const picked = studio.preferGeneratorOf(b.id);
  eq([picked.modelId, picked.scope, studio.inspect(film.shots[1].id).model.id], ['gemini-image', 'look', 'gemini-image'], 'picking the winner makes it the look\'s generator, for every shot under that look');
  eq(studio.store.get('shots', shot.id).approvedTakeId ?? null, null, 'without approving anything on your behalf');
  eq(studio.takesOf(shot.id).some((t) => t.id === a.id), true, 'and the losing take is kept');
}

console.log('\n--- promoting a hand-made proxy ---');
{
  const { studio } = testStudio();
  const film = seedFilm(studio);
  const shot = film.shots[2];
  const { job } = studio.render(shot.id, { modelId: 'gemini-video', seed: 9 });
  eq(/6-second/.test(studio.handoffSheet(job.id).message), true, 'a video hand-off states the duration');
  const proxy = studio.deliver(job.id, { bytes: mp4('proxy'), mime: 'video/mp4' }).take;
  const check = studio.promotionCheck(proxy.id);
  eq([check.blockers.length, check.guided], [0, true], 'promotion is allowed, guided by the proxy');

  const promotion = studio.promote(proxy.id);
  const sheet = studio.handoffSheet(promotion.job.id);
  eq(promotion.changed.sort(), ['promotedFromRecipeId', 'resolution', 'resolutionTier', 'upscaleGuidance'], 'the master recipe differs only in resolution and its guidance');
  eq(sheet.attachments.some((x) => x.blobId === proxy.blobId && x.role === 'composition'), true, 'the hand-off sheet attaches the approved proxy as the composition to follow');
  eq(/do not change/i.test(sheet.message), true, 'and tells the generator not to change it');
  const master = studio.deliver(promotion.job.id, { bytes: mp4('master'), mime: 'video/mp4' }).take;
  eq([studio.masterOf(proxy).id, master.tier, master.composition], [master.id, 'master', null], 'the imported master is linked to its proxy; drift is left for the eye, not claimed');
}

done();
