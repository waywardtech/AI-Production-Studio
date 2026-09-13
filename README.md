# AI Production Studio

Tooling for The Far Edge studio's AI production work, built as one Chrome
extension — **Edge Studio** — on a shared core.

- **Compose** prompts from reusable blocks and put them into ChatGPT,
  Claude or Gemini; optimize them for a platform; save and tag them.
- **Capture** what comes back, save it, and reuse all or part of it.
- **Produce** video: turn a script into scenes, build each shot, hand it to
  Sora or Veo, review what comes back, file dailies.
- **Organise** everything by project, kept in Google Docs once connected.

Edge Studio never calls an AI model itself and never presses send — it
works through the chat and generator tabs already open, and every prompt
waits in the input box.

**Start here:** [`extension/README.md`](extension/README.md) — install,
the everyday workflow, and each part in detail.

## Layout

```
extension/     the Chrome extension — load this folder unpacked
docs/
  far-edge-studio-productivity-suite-spec.md   the product spec: Core and Modules 1–4
  tickets-phase-0-2.md                          tickets for Core, Module 1 and Module 2
  tickets-phase-4.md                            tickets for Module 4
tests/         `npm test` (Node, no dependencies); tests/harness for driving pages in a browser
```

## Status

| Part | State |
|---|---|
| **Core** — projects, one record store shared by every page, migration from earlier builds | Built |
| **Core** — Google sign-in and Google Docs sync (every document a Doc, organised by project, two-way) | Built; tested against a simulated Drive, awaiting its first live run with your OAuth client |
| **Core** — usage meters and thresholds, backup and restore | Built |
| **Module 1** — prompt composer, variables, optimize, injection across ChatGPT, Claude, Gemini, Sora, Flow | Built |
| **Module 2** — reply capture, save, reuse, send to the studio | Built; Gemini native save and the reformat pipeline open |
| **Module 3** — visual reference pipeline | Spec'd, not ticketed |
| **Module 4** — production pipeline: scenes, assets, shot builder, Produce, review, dailies | Built; P1 extras open |

Ticket-by-ticket detail is in the extension README's reference section and
in `docs/`.
