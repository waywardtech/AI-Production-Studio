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

**Module 1 (Prompt Composer & Injection)** — Phase 1 MVP working: block
builder, ChatGPT tab detection/labeling, injection with clipboard
fallback, local prompt library, and variable placeholders. See
`modules/module-1-prompt-composer/README.md` for install steps and a
ticket-by-ticket status table.

**Core (auth/Drive)**, **Module 2 (Response Manager)**, and **Module 3
(Visual Reference Pipeline)** — spec'd and ticketed, not yet built.
