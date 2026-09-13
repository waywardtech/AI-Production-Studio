# Far Edge Studio Productivity Suite — Product Spec (v0.1 Draft)

**Owner:** Dan (The Far Edge)
**Primary account:** dan@thefaredge.com
**Status:** Brain-dump captured, unscoped — for structure review before build starts

---

## 1. Vision

A modular toolset that removes friction from the recurring, manual parts of running a one-person (for now) studio: composing and reusing prompts across multiple AI platforms, capturing and organizing what comes back, and running a repeatable visual-asset production pipeline for projects like **V.O.**

The suite is built as **one shared core** (auth, storage, repository) with **independent modules** stacked on top, so any module can be built, shipped, and used on its own without waiting on the others.

---

## 2. Architecture at a Glance

```
┌─────────────────────────────────────────────────────┐
│                      CORE LAYER                      │
│  Google Auth · Drive Access · Repository · Archive    │
└─────────────────────────────────────────────────────┘
        │             │              │               │
        ▼             ▼              ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   Module 1    │ │   Module 2    │ │   Module 3    │ │   Module 4    │
│Prompt Composer│ │   Response    │ │    Visual     │ │ Video & Media │
│  & Injection  │ │Mgr. & Archive │ │Ref. Pipeline  │ │  Production   │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

Module 4 picks up where Module 3 stops: Module 3 approves a still, Module 4 turns stills, references and a script into produced clips.

Every module reads and writes through the Core repository rather than keeping its own storage, so there's one consistent source of truth regardless of which AI platform actually did the work.

---

## 3. Core Layer

### Problem Statement
Every module needs the same three things — who's logged in, where files live, and a consistent place to store prompts/responses/assets. Building this once avoids each module reinventing storage and creating inconsistent data.

### Goals
- Single sign-on with dan@thefaredge.com (Google account) unlocks every module
- Google Drive functions as the system of record — no separate database to keep in sync
- A shared repository schema (prompts, responses, chat archives, visual assets) that every module reads/writes against
- Documents are referenced by link rather than duplicated, so there's one canonical copy of any given asset
- Unified visibility into usage/resource consumption across every connected service, surfaced in one place
- Export/import of the entire repository or subsets of it

### Non-Goals (v1)
- Multi-user accounts or permissions — this is single-user (Dan) for now
- A hosted database independent of Drive — Drive *is* the backend
- Building an AI model of our own — the suite orchestrates existing platforms (ChatGPT, Claude, Gemini, image tools), it doesn't replace them

### User Stories
- As Dan, I want to log in once with my Google account so that every module has Drive access without re-authenticating.
- As Dan, I want to point a module at a specific Drive folder so that project-specific data (e.g., a client's knowledge base) stays organized where I expect it.
- As Dan, I want to export my whole prompt/response repository so that I have a backup independent of any single platform.
- As Dan, I want to export a full chat transcript from a tab so that I can archive or reuse it later.
- As Dan, I want to feed an archived transcript back in and get an optimized prompt that re-initiates an equivalent chat elsewhere, so that I don't need to reconstruct context from scratch.
- As Dan, I want every project's assets organized under one Drive folder per project, with a lightweight tagging layer on top, so that I can drill in by project or by tag without a complicated structure.
- As Dan, I want to see how much of my usage/quota I've used across every connected AI service in one place so that I don't get caught without compute resources mid-task.
- As Dan, I want a live estimate of a prompt's cost while I'm building it so that I can see a warning before I send something that will eat into my limits.

### Requirements

**Must-Have (P0)**
- Google OAuth login, scoped to Drive read/write
- Folder picker so any module can target a specific Drive location
- Repository schema for: prompt blocks, saved prompts, saved responses, chat archives
- Drive structure: one folder per project at the top level, with a data-type layout nested inside (prompts / responses / visual assets / archives)
- A lightweight tagging layer on top of the folder structure — one standard system tag, **Status** (Draft / In Review / Approved / Archived), always present, plus user-created custom tags on top
- Atomic documents stored as links/references, not duplicated copies; an internal link database as a fallback wherever a platform's Drive integration isn't reliable
- Full chat export (transcript → Drive file)

**Nice-to-Have (P1)**
- "Re-seed from transcript" — take an archived transcript and format it into a prompt to start a new equivalent session on another platform
- Repository-wide export/import (backup/restore)

**Future Considerations (P2)**
- Multi-user access with role-based permissions, if others join the studio
- Alternate storage backends beyond Drive

### Usage & Resource Tracking (Cross-Cutting)

Every connected service (ChatGPT, Claude, Gemini, image-gen tools, etc.) reports usage/quota in its own place, if at all. This pulls that into one view inside the suite so Dan doesn't run out of resources mid-task without warning.

**Must-Have (P0)**
- A single **Usage** tab surfacing consumption/quota per connected service in one place
- A live cost estimate shown inline in the Prompt Composer before sending — a simple percentage marker or thermometer
- A clear warning state (e.g. flashing red) when usage is projected to cross a threshold — defaults to **10% of quota/budget remaining**, editable by Dan per service

**Nice-to-Have (P1)**
- Historical usage trends per service, not just current state
- Per-project or per-tag usage breakdowns

Where a service doesn't expose usage data via an official API, this falls under the same general screen-scraping fallback policy as the rest of the suite (see §8).

### Decisions
- **Folder structure:** Projects are the top-level physical structure in Drive; each project folder contains a data-type layout underneath. A lightweight tag layer (a few standard system tags plus user-created ones) sits on top for cross-cutting filtering. Atomic documents are stored as links/references rather than duplicated copies.
- **Re-seed from transcript:** Doesn't call an LLM API directly — it formats the transcript into a ready-to-use prompt and hands it off for Dan to paste into whichever platform is already open.

---

## 4. Module 1 — Prompt Composer & Injection

### Problem Statement
Building good prompts from scratch every time, then manually retyping or pasting them into whichever platform is open, is slow and inconsistent — especially across ChatGPT, Claude, and Gemini, each with different quirks.

### Goals
- Assemble a prompt from reusable blocks (Scenario, Expertise/Persona, Ask, Format) via drag-and-drop
- Maintain a library of blocks and full prompts for reuse
- Identify currently open target tabs (ChatGPT first, then Claude, then Gemini) and let Dan choose which to inject into — including distinguishing between multiple open tabs of the *same* platform tied to different projects
- Optionally run a per-platform "optimize" pass before injection
- Insert the final prompt into the chosen tab(s) with minimal manual steps

### Non-Goals (v1)
- Bypassing browser security to silently write into tabs the extension has no legitimate content-script access to — not attempting anything beyond what an extension is allowed to do
- Full parity on mobile — desktop/extension is the primary target; mobile gets a degraded fallback (see §8)
- Auto-detecting *which* open ChatGPT tab belongs to which project without Dan labeling it first

### User Stories
- As Dan, I want to drag a "Scenario" block, an "Expertise" block, and an "Ask" block into a builder so that I can assemble a prompt visually instead of typing it linearly.
- As Dan, I want to save a completed prompt (or any individual block) back to my library so that I can reuse it later.
- As Dan, I want to see a list of my currently open ChatGPT/Claude/Gemini tabs so that I can pick exactly which one gets the prompt.
- As Dan, I want to label an open tab (e.g., "Client X knowledge base") so that I can tell it apart from other tabs on the same platform.
- As Dan, I want an optional "Optimize?" step that shows me a platform-tailored rewrite of my prompt, which I can accept, edit, or regenerate before it's sent.
- As Dan, I want the extension to insert the approved prompt into the target tab, or tell me clearly that insertion is ready if it can't do it automatically.

### Requirements

**Must-Have (P0)**
- Block types: Scenario, Expertise/Persona, Ask (Format is optional/P1)
- Drag-and-drop builder UI, desktop-first, full-screen capable
- Prompt/block library backed by Core repository
- Tab detection for ChatGPT (initial target platform)
- Manual tab labeling so multiple same-platform tabs can be told apart
- Destination picker supporting single or multiple target tabs
- Injection into ChatGPT via extension content script
- Clear "insertion available" notification per tab when auto-injection isn't possible

**Nice-to-Have (P1)**
- Claude and Gemini support (same injection pattern extended to their domains)
- Format block as a fourth prompt component
- Optimize step: formats a platform-aware optimization request and hands it to whichever AI tab is already open (no bundled API key/call) — Dan runs it there and brings the result back to approve/edit before insertion
- Approve / regenerate / edit-inline loop on the optimized suggestion

**Future Considerations (P2)**
- Firefox extension parity alongside Chrome
- Auto-suggesting which saved prompt fits a given open tab based on context

### Decisions & Open Questions
- **Chrome only for v1** — Firefox deferred to a future phase.
- **Optimize step** doesn't call an LLM API directly — it hands a formatted optimization request to whichever platform tab is already open, and Dan brings the result back to approve/edit before insertion.
- **(Engineering, open)** Injection pattern: content script + background service worker, closest analog to how a password manager like 1Password autofills — needs a per-platform DOM adapter since ChatGPT/Claude/Gemini each render their input differently.

---

## 5. Module 2 — Response Manager & Archive

### Problem Statement
Once a prompt gets a response, there's no consistent way to save it, tag it to a project, pull a piece of it back into a new prompt, or push it onward for reformatting — it all happens by hand right now, inconsistently, across platforms with different (or missing) native save/export support.

### Goals
- Surface responses from currently open target tabs in one place
- Let Dan select a full response or a highlighted section and save it to the repository, tagged to a project
- Let Dan take a saved response (or selection) and send it back into the Prompt Composer as input for a follow-up
- Support a "reformat" loop: send content to another chat/task with instructions, then store the result in the correct repository/Drive location
- Handle platforms with inconsistent native export support (e.g., Gemini) without breaking consistency of where things end up stored

### Non-Goals (v1)
- Full two-way sync that keeps a live copy of a chat updated in real time — this is snapshot-based (export/save on demand), not continuous
- Automatic reformatting without Dan specifying the instruction each time

### User Stories
- As Dan, I want to see the latest response from each open tab in one panel so that I don't have to tab-hop to review outputs.
- As Dan, I want to select part of a response and save just that section so that I'm not stuck archiving entire responses when I only need a piece.
- As Dan, I want to send a saved response back into the prompt builder so that I can iterate on it in a new session.
- As Dan, I want to send a selection to "reformat," specify what should happen to it, and have the result land in the right Drive folder automatically so that I don't have to manually re-file things afterward.
- As Dan, I want the tool to fall back to its own export mechanism when a platform (like Gemini) doesn't reliably save content itself, so that storage stays consistent regardless of platform.

### Requirements

**Must-Have (P0)**
- Response capture panel per open/tracked tab
- Save full response or selection → repository, with project tagging
- "Send to prompt" action that routes saved content into Module 1's builder

**Nice-to-Have (P1)**
- "Reformat" pipeline: selection → instruction → new chat/task → result auto-filed to Drive
- Export to alternate formats (e.g., plain text, Markdown, PDF)
- Fallback export path for platforms without reliable native save support

**Future Considerations (P2)**
- Diffing between versions of a response across regenerations
- Batch tagging/filing across multiple saved responses at once

### Decisions
- **Gemini save behavior:** Start with whatever's easiest to implement first (native save-to-Drive where it works). The end goal is for the extension to take full control so every asset consistently lands in the correct Drive project folder regardless of platform — this is a migration target, not a permanent split.

---

## 6. Module 3 — Visual Reference Pipeline

### Problem Statement
Producing visual assets for a project (e.g., **V.O.**) currently means manually gathering reference images for locations, characters, wardrobe, and vehicles, manually combining them into prompts, and manually cycling through review/regeneration — a standard production pipeline done by hand, repeatedly, for every batch of shots. This is the most time-costly of the three modules today.

### Goals
- Organize reference material into **Reference Sets** (e.g., Location, Characters, Wardrobe, Vehicles, Mood/Lighting) per project, sourced from image search, personal photos, or upload — always keeping the source URL
- Build a **Shot Request** by combining one or more reference sets with a text description (scene, action, mood)
- Generate multiple variants per shot (e.g., 2–3) via whichever image-gen platform is open, guiding Dan to open/create that tab and pre-populating what it can
- Run a review cycle: keep / reject / regenerate, with notes on what to change
- Produce an approved **punch list** of final assets, organized by project → scene → shot, ready to hand off (e.g., to social)

### Non-Goals (v1)
- Video generation — stills only for v1; video is a planned future phase using the same reference-set model
- Multi-person review/handoff workflows — this is single-user (Dan reviewing his own output) for now, though the data model should support handoff later
- Deep API integration with every possible image-gen tool at launch — start with whatever platform(s) are already in Dan's regular rotation, extend from there

### User Stories
- As Dan, I want to create a project (e.g., "V.O.") that contains reference sets so that all the visual material for that project lives in one place.
- As Dan, I want to build a reference set (e.g., "Front Range wardrobe") from image searches or my own photos so that I have a reusable, tagged pool of visual context.
- As Dan, I want to combine specific reference sets ("this location" + "this character" + "this wardrobe") into a shot request with a scene description so that the generation prompt is assembled consistently instead of by hand each time.
- As Dan, I want to generate 2–3 variants of a shot at once so that I have options to choose from immediately.
- As Dan, I want to keep, reject, or request a regeneration of each variant, optionally with notes, so that I can iterate quickly without starting over.
- As Dan, I want approved shots to land in a punch list organized by project/scene so that I (or eventually someone else) can pull straight from it for publishing.
- As Dan, I want the tool to tell me when I need a tab open that isn't (e.g., an image-gen tool), give me a link, and pre-fill what it can once I click through, so that the pipeline doesn't stall on setup steps.

### Requirements

**Must-Have (P0)**
- Project → Reference Set data model, with source URL retained per asset
- Manual reference set building via image search / upload, tagged by category
- Shot Request builder combining N reference sets + text prompt
- Batch generation (2–3 variants) via an open image-gen tab (ChatGPT and Gemini first), guided setup if the tab isn't open
- Keep / reject / regenerate review loop with notes
- Approved punch list, organized project → scene → shot, consisting of: an index document, the final asset files, and links back to the platform/session each asset was generated in

**Nice-to-Have (P1)**
- Pre-population of the target platform's prompt field from the assembled shot request
- Notes/instructions carried into regeneration requests automatically
- Multiple image-gen platform support beyond the first one integrated

**Future Considerations (P2)**
- Video asset generation using the same reference-set/shot-request model
- Multi-person handoff: assigning review or generation steps to other people
- Batch generation across an entire day's/week's worth of shots for a content calendar in one pass

### Decisions
- **Priority image-gen integrations:** ChatGPT and Gemini first.
- **Punch list format:** An index document, the final asset files themselves, plus links back to the platform/session each asset was generated in.

---

## 7. Module 4 — Video & Media Production Pipeline

### Problem Statement
Module 3 stops at an approved still. Turning those stills into finished clips is still done by hand: re-describing the same location and character in every prompt, keeping a shot's look consistent across a scene, remembering which generator wants which phrasing, and tracking what was produced from what. A page of a comic book that needs to become a sequence of clips currently means breaking it down on paper, writing each shot prompt from scratch, and filing the results manually afterwards.

### Goals
- A drag-and-drop **clip generation** workspace built on three columns: assets, running order, shot builder
- Start from a **scene seed** and let each iteration fill in the blanks, building out the script / playbook / run book — or work block-by-block and fill the blanks by hand
- Reuse scenes: duplicate an existing one, bundle scenes into **sequences**, rebuild scenes from a script
- Preview per block, so the effect of changing one part of a shot on the whole result is visible before generating
- **Optimize the prompt for the target video generator**, with job profiles for recurring kinds of work
- **In-box / out-box folders** per production: scripts and assets go in, produced clips and a dailies report come out
- Import existing production data — characters, scenes, locations, action sequences, dialogue, mood/lighting

### Non-Goals (v1)
- Rendering or stitching video inside the tool — generation happens on the platform, the suite composes the prompt, records the result, and files it
- Editing/NLE features (timeline trimming, colour, audio mixing) — the out-box hands off to a real editor
- Automatic frame-to-frame continuity enforcement — continuity is carried by reference assets and the wording of a shot's aspects, not verified by the tool
- Unattended batch production — Dan is in the loop on every generate, same as Module 3

### The Three-Column Workspace

The workspace is one full-window page (the side panel is too narrow for it), with a scene rail on the left and three working columns:

| Column | Purpose |
|---|---|
| **1 — Assets** | Discovery, customization and creation. Search media in Drive or on the web, upload it, or describe an asset that doesn't exist yet. Multi-select grid: ticked assets attach to the current scene, crossed-out ones are excluded. |
| **2 — Running Order** | The blocks of the script for the scene, in order: Location, Setting, Scene/Action, Set Dressing, Characters, Dialogue, Camera, Sound, Transition. Drag to reorder, add or remove, and see at a glance which blocks are still blank. |
| **3 — Shot Builder** | Scene builder via still, then refine. A still anchors the shot; its aspects — time of day, atmosphere, look, lighting, exposure, plus camera, motion, duration and aspect ratio — are editable inline. A "chat to refine" box takes plain-language changes. |

### The Build Loop

1. **Seed.** A scene starts as one line of intent.
2. **Iterate.** Each expansion pass fills in *blanks only* — blocks and aspects Dan has already written stay untouched, so refinement is additive rather than destructive. Expansion runs in a chat tab that's already open, following the same hand-off rule as the Optimize step (decision #2 / #4): no bundled API key, no direct model call.
3. **Or go manual.** Fill blocks in directly, or refine with a prompt of Dan's own wording.
4. **Preview.** Every block shows its own contribution to the assembled prompt, and selecting one highlights its segment in the whole, so the impact of a change is visible before anything is generated.
5. **Produce.** The assembled prompt is optimized for the chosen generator and job profile, handed to the generator's tab, and the result is recorded in the out-box with a link back to the session that made it.
6. **Review.** Keep / reject / regenerate per render, with notes; notes carry into the regeneration. A **dailies report** summarises the session — what was produced, from which prompt, with which verdict.

### User Stories
- As Dan, I want to start a scene from one line and have the system fill in the blanks over successive passes, so that I get to a full shot description without writing every field myself.
- As Dan, I want anything I've already written to survive an expansion pass, so that iterating never overwrites my own wording.
- As Dan, I want to tick reference assets into a shot, so that the same location and character description doesn't get retyped for every clip.
- As Dan, I want to reorder the blocks of a scene by dragging, so that the running order matches how the scene actually plays.
- As Dan, I want to see what each block contributes to the final prompt, so that I can tell which part of a shot to change when the result is wrong.
- As Dan, I want to duplicate a scene and bundle scenes into a sequence, so that repeated coverage isn't rebuilt from scratch.
- As Dan, I want to drop a script into the in-box and have it broken into scenes and shots, so that a page of a comic book becomes a shot list I can work through.
- As Dan, I want the prompt tuned for whichever generator I'm sending it to, so that I'm not rewriting the same shot three ways.
- As Dan, I want job profiles for the kinds of work I do repeatedly, so that a vertical social clip and an establishing shot don't need the same settings entered by hand each time.
- As Dan, I want produced clips and a dailies report to land in the production's out-box, so that a day's output is reviewable in one place.
- As Dan, I want to import the characters, locations and scenes I already have written down, so that the pipeline starts from my existing material.

### Requirements

**Must-Have (P0)**
- Production → Scene → Shot data model, with sequences grouping scenes, backed by the Core repository seam
- Three-column workspace as described above, in a full-window extension page
- Asset column: search/filter by name, description, tag and category; multi-select; add by upload, by URL (source URL always retained), or by description for an asset that doesn't exist yet
- Running order: typed blocks, drag-to-reorder, add/remove, blank indicator
- Shot builder: still + the five sketched aspects (time of day, atmosphere, look, lighting, exposure) plus camera, motion, duration and aspect ratio, all editable inline
- Scene seed expansion that fills blanks only, run through an already-open chat tab
- Chat-to-refine box that applies a plain-language change to the current shot
- Per-block preview and highlight-in-assembled-prompt
- Duplicate scene; bundle scenes into a sequence; rebuild scenes from a pasted or dropped script
- Prompt optimization per target generator — **Sora (on the Sora page or in ChatGPT) and Veo (in Flow or Gemini)** — plus job profiles for recurring work
- In-box / out-box per production: drop scripts and assets in; produced clips, links and the dailies report out
- Produce action: assemble → optimize → hand to the generator tab (clipboard fallback) → record the render
- Review loop: keep / reject / regenerate with notes, notes carried into the regeneration
- Dailies report generated from a session's renders, exportable as Markdown
- Import of existing data: characters, scenes, locations, action sequences, dialogue, mood/lighting

**Nice-to-Have (P1)**
- Generator profiles beyond the first two (Runway, Kling, Luma)
- Continuity warnings when a character or location is described differently across scenes in one sequence
- Cost estimate per production run, feeding the Usage tab (CORE-8)
- Storyboard contact sheet across a sequence

**Future Considerations (P2)**
- Self-hosted generation via ComfyUI workflows for volume beyond what web-tab generation sustains (see §10)
- Multi-person handoff: assigning shots for review or generation
- Audio/dialogue track assembly across a sequence

### Decisions
- **Surface:** a full-window extension page, not a side-panel tab — the three-column layout needs the width. It opens from the side panel and shares the panel's storage seam, modal and toast.
- **Generation stays hands-off:** the pipeline composes and hands off the prompt exactly as Optimize does; it never presses send in Dan's chat and never carries an API key.
- **Expansion is additive:** a pass fills blanks and leaves written fields alone. Overwriting is an explicit choice, never a side effect of iterating.
- **Priority generators:** Sora (Sora page or ChatGPT) and Veo (Flow or Gemini), matching the existing image-gen decision (#6). Generator pages take a prompt but have no reply to read, so rewording always runs in a separate chat.
- **Storage:** productions live behind the same repository seam as everything else — local until CORE-4, Drive after, with no UI change. Dropped files are held as a reference plus a thumbnail rather than copied wholesale, consistent with the "links, not copies" rule (#1).

---

## 8. Cross-Cutting Technical Constraints

- **Cross-tab injection is extension-only.** A web page cannot reach into another tab and type for security reasons. The realistic pattern is a browser extension with content scripts on each supported domain (ChatGPT, Claude, Gemini) plus a background service worker — architecturally similar to how a password manager like 1Password autofills fields. Each platform needs its own DOM adapter since their input UIs differ.
- **Mobile is a degraded experience, not a blocked one.** iOS/mobile browser extension APIs are far more limited than desktop. The fallback path is: build the prompt in-app → copy to clipboard → clear "ready to paste" prompt → Dan manually switches app and pastes. This should be designed in from the start rather than bolted on later, since mobile use was explicitly called out as painful today.
- **Same-platform, multiple tabs.** Because Dan runs multiple ChatGPT tabs for different projects/clients, tabs need a manual labeling scheme so the destination picker can tell them apart — there's no reliable way to auto-detect "which project" a tab belongs to.
- **Drive as single source of truth.** All modules should file through Core's repository layer rather than each inventing its own storage, specifically to avoid the consistency problem Dan flagged with platforms (like Gemini) that may or may not reliably save things natively.
- **Screen-scraping is an accepted general fallback**, not just for usage stats — wherever a platform doesn't expose what's needed via an official API, the suite scrapes the UI instead and accepts the maintenance overhead of adapting when that UI changes.
- **Build on existing tools where possible.** Before building any piece from scratch, evaluate open-source projects that are already close to what's needed (e.g. existing prompt-manager or browser-automation extensions) and adapt/modernize rather than reinvent. This is a direct lesson from an earlier attempt at repurposing WordPress for this exact tool, which got unwieldy once cross-tab injection and stats scraping came into play.

---

## 9. Suggested Build Sequence

| Phase | Scope |
|---|---|
| **0** | Core: Google auth, Drive folder access, repository schema (projects + tags + link-based docs), Usage tab |
| **1** | Module 1 MVP: block-based builder, Chrome-only, ChatGPT-only injection, manual tab labeling, no optimize step yet |
| **1.5** | Add optimize step (hands off to an open tab); extend injection to Claude and Gemini |
| **2** | Module 2: response capture, save/tag, send-to-prompt loop |
| **2.5** | Chat archive export + re-seed-from-transcript |
| **3** | Module 3: visual reference pipeline, stills only, ChatGPT + Gemini first |
| **4** | Module 4: video & media production pipeline — three-column workspace, scene seed/expansion loop, produce + dailies, Sora and Veo profiles |
| **5 (future)** | Multi-person handoff, native mobile app, Firefox parity, self-hosted generation |

Module 4 is built against the same repository seam as everything before it, so it does not wait on Phase 0 — it runs on local storage until Core lands, exactly as Modules 1 and 2 do today.

---

## 10. Open-Source Building Blocks to Evaluate

Per the "don't reinvent the wheel" principle in §8, here's what's actually out there worth evaluating before building each piece from scratch. Adoption decisions (fork vs. use as reference vs. build fresh) are still Dan's call — this is a research pass, not a final selection.

**For Module 1 (Prompt Composer & Injection)**
- **carlosguadian/universal-prompt-library** — a local-first Chrome extension to manage, organize, and inject prompts into ChatGPT, Claude, Gemini, and other chatbots, with folders, drag-and-drop, and variable placeholders. This is the closest existing match to Module 1's core loop and the strongest candidate to fork or study closely — it already solves prompt libraries, multi-platform injection, and JSON export/import.
- **LayneIns/Ask-Gemini-Extension** — a Chrome extension with a multi-strategy text-injection approach specifically for Gemini's contenteditable/rich-textarea input, useful as a reference for the trickiest of the three injection targets.
- **terrydavis-toyota/Text-Injector** — a simpler Chrome extension for saving and injecting text into ChatGPT with macro folders and JSON export/import, useful as a lighter-weight reference pattern.

**For Module 2 (Response Manager & Archive)**
- **ThreadPort** — an open-source browser extension built specifically to move an entire AI conversation from one platform to another (e.g. Claude to ChatGPT) without manually copying and losing formatting or context, directly relevant to the "re-seed from transcript" and cross-platform handoff requirements.
- **caiyongji/ChatMultiAI** — an open-source Chrome extension for chatting with ChatGPT, Claude, Gemini, and others from a single side panel, a useful reference for the "many tabs/sessions, one interface" pattern.

**For Module 3 (Visual Reference Pipeline)**
- **ComfyUI** with IP-Adapter/ControlNet workflows is the established open-source approach for reference-image-driven, identity-consistent character and scene generation with batch output — combining ControlNet for structural control with IP-Adapter to preserve a character's appearance across scenes, using folders of 2–3 reference images per character. This is worth evaluating as a self-hosted fallback/complement to the ChatGPT/Gemini web-UI path, especially if volume grows past what manual web-tab generation can keep up with.

---

## 11. Decisions Log & Remaining Open Questions

### Decided
| # | Question | Decision |
|---|---|---|
| 1 | Drive repository folder structure | Projects as top-level structure; data-type layout nested inside each project; lightweight tag layer on top; documents stored as links/references, not copies |
| 2 | Re-seed from transcript mechanism | Formats text only — hands off to an already-open platform tab, no bundled API call |
| 3 | Chrome vs. Firefox | Chrome only for v1 |
| 4 | Optimize rewrite mechanism | Same as #2 — formatted and handed to an already-open tab |
| 5 | Gemini save reliance | Start with whichever is easiest (native save where it works); extension taking full storage control is the end goal |
| 6 | Priority image-gen platforms | ChatGPT and Gemini |
| 7 | Punch list handoff format | Index document + final asset files + links back to the generating platform/session |
| 8 | Usage warning threshold | Defaults to 10% of quota/budget remaining, editable per service |
| 9 | Open-source tools worth evaluating | Researched — see §10 for candidates per module; final adoption still Dan's call |
| 10 | System tag taxonomy | One standard tag — **Status** (Draft / In Review / Approved / Archived) — plus user-created custom tags on top |
| 11 | Module 4 surface | A full-window extension page opened from the side panel, not a fourth panel tab — the three-column workspace needs the width |
| 12 | Priority video generators | Sora (Sora page or ChatGPT) and Veo (Flow or Gemini), matching decision #6 |
| 13 | Scene expansion behaviour | Additive — a pass fills blanks only; overwriting written fields is an explicit choice, never a side effect of iterating |
| 14 | Module 4 storage | Same repository seam as the other modules: local until CORE-4, Drive after. Dropped files are held as a reference plus a thumbnail, per #1 |

*No open questions remain. All decisions above are ready to build against.*

---

*Phases 0–2 are ticketed in `tickets-phase-0-2.md`; Phase 4 is ticketed in `tickets-phase-4.md`. Module 3 (Phase 3) is spec'd but not yet ticketed.*
