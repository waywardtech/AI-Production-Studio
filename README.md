# AI Production Studio

A modular toolset for The Far Edge studio: a shared core (Google auth,
Drive-backed repository) with independent modules on top — prompt
composition and injection across AI chat platforms, response
management/archiving, and a visual reference pipeline for production
work like the **V.O.** project.

## Layout

```
docs/
  far-edge-studio-productivity-suite-spec.md   — Full product spec (Core + 3 modules)
  tickets-phase-0-2.md                          — Engineering tickets, Phases 0–2

modules/
  module-1-prompt-composer/                     — Chrome extension (Phase 1 MVP, in progress)
```

## Status

The extension is named **Edge Studio**. Its directory keeps the
`module-1-prompt-composer` name the spec and ticket docs use.

**Module 1 (Prompt Composer & Injection)** — Phase 1 MVP working: block
builder, ChatGPT tab detection/labeling, injection with clipboard
fallback, local prompt library, and variable placeholders.

**Module 2 (Response Manager & Archive)** — first three tickets working
in the same extension: capture the latest response or a page selection
from any tracked tab, save it with a link back to its source, and send
it back into the builder as a block. Drive-backed export (M2-4/M2-5) and
the reformat pipeline (M2-6) are still open.

See `modules/module-1-prompt-composer/README.md` for install steps and a
ticket-by-ticket status table.

**Core (auth/Drive)** and **Module 3 (Visual Reference Pipeline)** —
spec'd and ticketed, not yet built.
