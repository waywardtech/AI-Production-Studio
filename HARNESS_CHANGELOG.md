# Harness changelog

What stops Edge Studio from waiting forever, and the rules that keep it
that way.

"Harness" here means the coordination layer: the code that moves work
between an extension page, the background worker, a content script on
somebody else's page, and Google Drive. Each of those can stop answering
without failing, and a promise that never settles is not an error anyone
can catch — the button simply never comes back.

## Invariants

These hold now and are each pinned by a test that fails without them.

| # | Rule | Where | Bound |
|---|---|---|---|
| 1 | Every Drive request has a deadline covering the token, the call, the 401 retry and the body. On expiry the fetch is aborted | `shared/drive.js` | 30 s; 5 min for moving an asset's bytes |
| 2 | A stalled request ends the sync run. It is never charged to the record that hit it and retried per record | `shared/sync.js` | one deadline per run, not one per record |
| 3 | The sync lock is released on lack of progress, not elapsed time. The engine reports a beat per step | `shared/watchdog.js`, `background.js` | 6 min of silence |
| 4 | A run that has been given up on stops at its next step. It never resumes beside its replacement | `shared/sync.js` (`checkpoint`) | the one request in flight |
| 5 | Consecutive sync re-runs are capped, then handed back to the debounce | `shared/watchdog.js` | 5 passes |
| 6 | A stored `syncing` found at worker start-up is stale and is cleared | `shared/sync.js` (`clearStaleSyncing`) | at start-up |
| 7 | The relay to a tab always answers, with `{ success: false, timedOut: true, reason }` if the tab doesn't | `shared/relay.js` | 15 s per ask, 10 s to inject |
| 8 | A tab that has stalled is not re-injected. Inject-and-retry is for a tab that never had the script | `shared/relay.js` | worst case: one ask + one inject + one ask |
| 9 | The reply watcher has one ask in flight at a time | `shared/reply-watcher.js` | 1 |
| 10 | The reply watcher stops asking when the reply hasn't changed. Progress is the reply changing, not time passing | `shared/reply-watcher.js` | 10 min idle |

Two rules about the watchdogs themselves:

- **A stall is reported as a failure, never papered over.** Nothing here
  retries silently or substitutes a guess. Sync says what stopped and
  that nothing was lost; Insert falls back to the clipboard; the waiting
  dialog stays open and says it has stopped watching.
- **Deadlines measure progress where they can.** A wall-clock limit on a
  whole sync would kill a legitimate first sync of a large project. The
  only fixed deadlines are on single operations that are quick by nature.

## 2026-11-13 — three stall vectors closed

Each was measured hanging before the change, fixed behind a
deterministic guardrail, and gated on the full suite plus a simulation
that deliberately hangs. Simulations were mutation-checked: each
guardrail was removed in turn to confirm its test fails without it.

### 1. A hung Drive request deadlocked sync — `5f83cab`

`fetch` has no deadline. A request Google never answered left
`engine.run()` unsettled, which pinned the worker's single-flight
promise: storage said `syncing`, Settings showed "Syncing now…" with
**Sync now** disabled, and every later sync was handed the same stuck
promise.

- **Before:** not settled after 1500 ms; stored status `syncing`.
- **After:** settles at its deadline; stored status `error`, with a
  message saying nothing was lost. The next run completes with no
  duplicate folder or Doc.
- **Test:** `tests/stall-sync.test.mjs` (41 checks).

Mutation-checking found one of these tests too weak. With invariant 2
removed it still passed, because the project's hidden index write
stalled first and ended the run for a different reason. It now stalls on
Doc creation specifically; without the rule it sees 6 stalled writes
instead of 1.

### 2. A frozen tab hung Insert, Produce, Attach and the page check — `ac53c14`

`relayToTab` awaited `chrome.tabs.sendMessage` with no limit. Insert's
clipboard fallback exists for a tab it can't write to, but it reacts to
a failure, and silence isn't one.

- **Before:** not settled after 1500 ms.
- **After:** structured `timedOut` failure at the deadline. No call site
  changed — it is the shape every caller already treats as "fall back".
- **Test:** `tests/stall-relay.test.mjs` (19 checks), and
  `tests/browser/stall-relay.browser.mjs`, which locks a page's main
  thread in a real Chrome. Chrome does leave the message unanswered;
  Insert reached the clipboard fallback after 15.1 s against a 15 s
  deadline.

### 3. The reply poller asked the same question forever — `b628dfc`

`waitForReply` polled on `setInterval` with an async callback: no
in-flight guard, no end.

- **Before:** 74 identical captures in 1.5 s against a 200 ms tab, up to
  10 in flight, still going.
- **After:** 5 captures, at most 1 in flight, stopped by itself.
- **Test:** `tests/stall-poller.test.mjs` (22 checks), and
  `tests/browser/roundtrip.browser.mjs` for the dialog on top, which had
  no coverage before.

## Known limits

- **A sent message can't be recalled.** If a tab un-freezes after the
  relay's deadline, a prompt reported as not inserted may still appear
  in it. The failure message says to try again once the page recovers.
- **A watchdog can abort a signal, not a function.** Work that ignores
  its signal keeps running until it next checks. `fetch` honours it;
  the sync engine checks between steps. IndexedDB reads do not, and are
  bounded only by the sync lock's six-minute silence limit.
- **MV3 can stop the worker regardless.** Invariant 6 is what recovers
  the visible state when it does.

## Audited and not yet fixed

- **Orphaned file transfers.** The content script's `transfers` map
  holds a transfer's decoded chunks until it is committed. If the sender
  fails part-way (`shared/attach.js` returns without telling the tab) or
  the page that started it closes, up to 50 MB stays in the chat page's
  content script for the life of that page. It needs an abort message
  from the sender and an age limit swept on the tab's side. Cycle 2 did
  not make this worse — a hung chunk used to strand the transfer *and*
  the sender — but it is the next thing worth closing.

## Not applicable here

The audit this came from was written for a multi-agent LLM harness. Two
of its four classes have no counterpart in this codebase, and nothing
was built to stand in for them:

- **Context compaction.** Edge Studio never calls a model (spec decision
  #4), so there is no message history to prune.
- **Sub-agent heartbeats and step budgets.** There are no sub-agents.
  The nearest equivalent, the sync engine's progress beat, is invariant 3.
