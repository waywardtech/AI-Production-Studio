# Production Studio — pipeline architecture

`pipeline/` is a local web app for making a film with generative models
the way a production house does: Development → Pre-production →
Production → Post → Delivery. Run it with `npm run studio` and open
<http://localhost:4173>.

It has no dependencies. The server is `node:http`, the store is one JSON
file, the UI is plain HTML, CSS and JavaScript.

**What is real and what is not.** The data model, compiler, consistency
checks, job queue and UI are real and tested. The models are not: the
adapters in `src/adapters.mjs` are mocks that draw a deterministic SVG
from a recipe. They reproduce the properties that matter for the pipeline
(seed lock or its absence, tiers, latency, the failure classes), so the
rules below are exercised, but no real image or video service has been
called. Voice and lip-sync models are declared but no UI stage uses them
yet.

## 1. Assets

Everything is one of two kinds of record.

| Kind | Collections | Rule |
|---|---|---|
| Immutable | `bibleVersions`, `recipes`, `takes`, `blobs` | Written once. The store refuses to overwrite or remove them. |
| Pointers | `bible`, `scenes`, `shots`, `jobs`, `batches`, `project` | Small mutable records that point at immutable ones. |

An edit never changes an existing version. It writes a new immutable
record and moves a pointer.

```
Story Bible entry ──head──→ bibleVersion v3 ──parent──→ v2 ──→ v1
  (character, prop, location, look, format)

scene ──→ shot ──approvedTakeId──→ take ──recipeId──→ recipe ──inputs──→ the bibleVersions,
            └────headTakeId─────→ take                                  scene and shot revisions
                                   ├─ parentTakeId        (branched or re-rendered from)
                                   ├─ promotedFromTakeId  (the proxy this master came from)
                                   └─ blobId → blob       (the rendered file, keyed by content hash)
```

### The generation recipe

A recipe is the complete, replayable instruction for one render.

| Field | Meaning |
|---|---|
| `seed` | The random seed. |
| `compiledPrompt`, `negativePrompt` | Output of the prompt compiler. |
| `referenceAssetIds`, `referenceHashes` | Canonical vault images, by id and by content hash. |
| `modelId` | Which adapter. |
| `controlParams` | Duration, aspect ratio, camera and similar. |
| `resolutionTier`, `resolution` | `proxy` or `master`, and the pixel size. |
| `promotedFromRecipeId`, `upscaleGuidance` | Present on masters only. |
| `inputs` | Provenance: the Story Bible version ids and the scene and shot revisions it was compiled from. |

The recipe id is a hash of everything except `inputs`, so the same
instruction always has the same id. A take's id is derived from its
recipe's id: one recipe, one take.

### Staleness is computed, never stored

A take is out of sync when its recipe's `inputs` differ from the current
heads. Nothing is flagged at edit time, so nothing can be missed and
nothing needs clearing. Shot states:

| State | Meaning |
|---|---|
| `empty` | No take yet. |
| `draft` | Has a current take, not approved. |
| `approved` | Approved take is current; no master. |
| `mastered` | Approved take is current and has a master. |
| `stale` | The take the shot stands on was compiled from superseded inputs. |
| `review` | The approved take is stale, and a take compiled from current inputs is waiting for approval (`candidateTakeId`). |

An approved take stays approved until a person approves another. A Story
Bible edit changes no take, recipe or file, and starts no render.

## 2. Proxy → master invariants

Promotion re-runs a proxy take's own recipe at master resolution.

1. **Only resolution changes.** `promoteRecipe` copies the proxy recipe
   and changes `resolutionTier`, `resolution`, `promotedFromRecipeId` and
   optionally `upscaleGuidance`. `assertPromotionInvariant` throws if
   any other field differs: `seed`, `compiledPrompt`, `negativePrompt`,
   `referenceAssetIds`, `referenceHashes`, `modelId` and `controlParams`
   are identical by construction and by check.
2. **The recipe that runs is the locked one**, not a recompile. Promoting
   a stale take gives a master that matches its proxy, not today's canon.
3. **Same aspect ratio.** A master tier of a different shape is refused.
4. **The model must be able to hold the composition.**
   `promotionCheck(takeId)` decides before anything is queued:

   | Model | Result |
   |---|---|
   | Locks its seed across resolutions | Promote. |
   | No seed lock, accepts an init frame | Promote with `upscaleGuidance: { mode: 'init-frame', fromTakeId }` and warn. |
   | Neither | Refused. No job is queued. |

5. **Drift is visible.** Each take records a `composition` key. The UI
   compares proxy and master and offers an A/B wipe.
6. **Stale takes need a decision.** Promoting one by hand warns and names
   what changed. Batch promotion skips it and reports why.
7. **Promotion is idempotent.** Same proxy, same master recipe id, same
   job, one model call.

## 3. Job recovery state machine

```
            enqueue (deduplicated by key = render:<recipeId>)
                │
                ▼
   ┌───────► queued ───────► running ───────► succeeded
   │            ▲               │
   │            │               ├─ transient / timeout, attempts left ──→ queued (with backoff)
   │            │               ├─ any other failure, or attempts spent ─→ failed
   │            │               └─ process died ─→ recover() at start-up ─→ queued
   │            │                                   (after 3 interruptions → failed: interrupted)
   │            │
   └── Retry · Resume failed batch          failed ──→ Retry with fallback: a new recipe,
        (the same job, attempts reset)                  recompiled for the fallback model
```

- **Heartbeat and timeout.** A running job beats every second and is
  aborted at its timeout (60 s by default), which counts as a `timeout`
  failure.
- **Failures are classified first**, because the class decides the
  response:

  | Class | Retried automatically | What the creator is told |
  |---|---|---|
  | `transient` | Yes | Retrying usually works. |
  | `timeout` | Yes | Retry, or use the fallback model. |
  | `content_filter` | No | Edit the shot; the same recipe will be refused again. |
  | `malformed_prompt` | No | Recompile, or switch model. |
  | `interrupted` | No | Running at every crash; check it before retrying. |
  | `unknown` | No | Nothing was retried. |

- **Finished work is never redone.** A job's key is its recipe, a take's
  id is its recipe, and the handler returns the existing take if there is
  one. A job interrupted between writing its take and being marked done
  finishes on the next run without a model call. Resuming a batch
  re-queues only its failed jobs.
- **Recovery does not cost an attempt.** An interrupted run is the
  studio's fault, not the model's.
- **Every write to the store is atomic** (temp file, then rename), so a
  crash leaves the previous state, never half of one.

## 4. The five pillars, and where they live

| Pillar | Code | What the creator sees |
|---|---|---|
| Proxy → master | `src/recipe.mjs`, `promote*` in `src/studio.mjs` | Promote on a take, "Promote N approved", A/B wipe, drift note, warnings and refusals before spending. |
| Prompt compiler | `src/compiler.mjs` | Clause-by-clause prompt with each clause's source, token budget, locks, a diff against the current take, Critic → Refine. |
| Consistency | `src/consistency.mjs` | References injected from the vault automatically; wardrobe, lighting, aspect and missing-reference flags before render. |
| Job recovery | `src/jobs.mjs` | Jobs panel with the error class and advice, Retry, Retry with fallback model, Resume failed batch, Branch from any take. |
| UI | `ui/` | Storyboard sized by shot duration, dependency graph with stale edges, ripple reasons on each card, "Re-render N out-of-sync" for only the affected shots. |

## 5. Verification

`npm run test:pipeline` — four files, no network, mocked slow and failing
models.

| File | Checks | Covers |
|---|---|---|
| `core.test.mjs` | 61 | Store immutability, compiler, critic, consistency, recipes, promotion on a seed-locked model, queue retries, fallback, batch resume. |
| `recovery.test.mjs` | 20 | Cycle 1 — a restart mid-render: orphaned jobs resume, completed shots are not rendered twice, a crash-looping job stops. |
| `promotion.test.mjs` | 19 | Cycle 2 — models without seed lock, guided and refused promotions, stale takes, double promotion, aspect ratio. |
| `canon.test.mjs` | 21 | Cycle 3 — a Story Bible edit under approved work: dependents marked, approvals and takes untouched, re-render leads to `review` and stops repeating. |

Each hardening test was written first and seen to fail, then seen to
fail again with its fix removed.

## 6. Known limits

- Mock models only (see the top of this file).
- One process, one JSON file: single user, and a large film would want a
  real database and blob storage.
- No audio, edit or grade stage in the UI; delivery is a manifest of
  mastered takes, not a rendered film.
- The UI was exercised in a real browser by script, not by an automated
  browser test kept in the repo.
