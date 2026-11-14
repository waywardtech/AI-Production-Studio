// Hardening cycle 3: editing the Story Bible underneath approved work.
//
// An edit upstream must mark everything downstream as out of sync, and
// must never touch the takes people have already approved. Then the
// re-render has to lead somewhere: the fresh take has to be findable,
// and the shot must stop asking to be re-rendered.
import { makeChecker, seedFilm, testStudio } from './helpers.mjs';
import { hashOf } from '../src/ids.mjs';

const { eq, done } = makeChecker();

async function approvedFilm(options) {
  const made = testStudio(options);
  const film = seedFilm(made.studio);
  for (const shot of film.shots) made.studio.render(shot.id, { seed: 11 });
  await made.studio.queue.drain();
  film.shots.forEach((shot) => made.studio.approve(shot.id, made.studio.takesOf(shot.id)[0].id));
  return { ...made, film };
}
const states = (studio, film) => film.shots.map((shot) => studio.staleness(shot.id).state);
const snapshot = (studio) => hashOf([studio.store.list('takes'), studio.store.list('recipes'), studio.store.list('blobs')]);

console.log('--- an upstream edit marks dependents, and only dependents ---');
{
  const { studio, film, adapters } = await approvedFilm();
  const before = snapshot(studio);
  const approvedBefore = film.shots.map((shot) => studio.store.get('shots', shot.id).approvedTakeId);
  const callsBefore = [...adapters.calls.values()].reduce((a, b) => a + b, 0);

  const { affected } = studio.reviseEntity(film.ana.id, { fields: { wardrobe: 'flight suit' } });
  const expected = film.shots.map((shot) => (shot.characterIds.includes(film.ana.id) ? 'stale' : 'approved'));
  eq(states(studio, film), expected, 'every shot with Ana in it is out of sync; the others are untouched');
  eq(affected.sort(), film.shots.filter((s) => s.characterIds.includes(film.ana.id)).map((s) => s.id).sort(), 'and the edit reports exactly those shots');
  eq(snapshot(studio), before, 'no take, recipe or rendered file was changed by the edit');
  eq(film.shots.map((shot) => studio.store.get('shots', shot.id).approvedTakeId), approvedBefore, 'every approval still points at the take that was approved');
  eq([...adapters.calls.values()].reduce((a, b) => a + b, 0), callsBefore, 'and nothing was re-rendered behind anyone\'s back');

  let refused = false;
  try { studio.store.put('takes', { ...studio.store.list('takes')[0], blobId: 'tampered' }); } catch { refused = true; }
  eq(refused, true, 'a take cannot be overwritten even on purpose');
  const shot = film.shots[0];
  studio.updateShot(shot.id, { notes: 'tighter', approvedTakeId: null, headTakeId: null });
  eq(studio.store.get('shots', shot.id).approvedTakeId, approvedBefore[0], 'and editing a shot cannot drop its approval');
}

console.log('\n--- re-rendering leads somewhere ---');
{
  const { studio, film, adapters } = await approvedFilm();
  studio.reviseEntity(film.ana.id, { fields: { wardrobe: 'flight suit' } });
  const stale = film.shots.filter((shot) => studio.staleness(shot.id).state === 'stale');
  const target = stale[0];
  const old = studio.store.get('takes', studio.store.get('shots', target.id).approvedTakeId);

  studio.rerender(stale.map((s) => s.id));
  await studio.queue.drain();
  const status = studio.staleness(target.id);
  const fresh = studio.takesOf(target.id).at(-1);
  eq(studio.store.get('shots', target.id).approvedTakeId, old.id, 'the old take is still the approved one — nobody has approved the replacement');
  eq([status.state, status.candidateTakeId], ['review', fresh.id], 'the shot now says a fresh take is waiting for review, and which');
  eq([fresh.parentTakeId, fresh.seed], [old.id, old.seed], 'the fresh take descends from the approved one, on its seed');
  eq(studio.store.get('recipes', fresh.recipeId).compiledPrompt.includes('flight suit'), true, 'and was compiled from the new canon');

  const calls = () => [...adapters.calls.values()].reduce((a, b) => a + b, 0);
  const callsBefore = calls();
  const takesBefore = studio.store.list('takes').length;
  const again = studio.rerender(stale.map((s) => s.id));
  await studio.queue.drain();
  eq([calls(), studio.store.list('takes').length], [callsBefore, takesBefore], 'asking again re-renders nothing');
  eq(again.results.every((r) => /waiting for review/.test(r.skipped || '')), true, 'and says why: each shot already has a fresh take');

  eq(studio.exportManifest().ready, false, 'the film is not deliverable while approvals are outstanding');
  studio.approve(target.id, fresh.id);
  eq(studio.staleness(target.id).state, 'approved', 'approving the replacement settles the shot');
  eq(studio.takesOf(target.id).some((t) => t.id === old.id), true, 'and the superseded take is still in the history');
}

console.log('\n--- a master made from superseded canon ---');
{
  const { studio, film } = await approvedFilm();
  const shot = film.shots.find((s) => s.characterIds.includes(film.ana.id));
  studio.promote(studio.takesOf(shot.id)[0].id);
  await studio.queue.drain();
  eq(studio.staleness(shot.id).state, 'mastered', 'mastered while current');
  studio.reviseEntity(film.ana.id, { fields: { wardrobe: 'flight suit' } });
  eq(studio.staleness(shot.id).state, 'stale', 'a master does not shield a shot from an upstream edit');
  const row = studio.exportManifest().rows.find((r) => r.shot === shot.name);
  eq([studio.exportManifest().ready, row.state], [false, 'stale'], 'and the export says the film is not ready, naming the shot');
}

console.log('\n--- the edit lands while a render is in flight ---');
{
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { studio } = testStudio({ faults: async () => { await gate; } });
  const film = seedFilm(studio);
  const shot = film.shots.find((s) => s.characterIds.includes(film.ana.id));
  studio.render(shot.id, { seed: 2 });
  const draining = studio.queue.drain();
  studio.reviseEntity(film.ana.id, { fields: { wardrobe: 'flight suit' } });
  release();
  await draining;
  const status = studio.staleness(shot.id);
  eq([studio.takesOf(shot.id).length, status.state], [1, 'stale'], 'the take that lands is flagged at once: it was compiled before the edit');
  eq(status.reasons.some((r) => /Ana changed/.test(r.message)), true, 'with the reason');
}

done();
