# Far Edge Studio — Engineering Tickets (Phase 4)

Derived from §7 of `far-edge-studio-productivity-suite-spec.md`. Covers
**Module 4 — Video & Media Production Pipeline**: the three-column
clip-generation workspace, the scene seed loop, produce and dailies.

Phase 3 (Module 3, the visual reference pipeline) is spec'd but not yet
ticketed. Module 4 does not wait on it — it stands on the same
repository seam as Modules 1 and 2, and takes stills from wherever they
come from.

---

## Epic: Phase 4 — Module 4 (Video & Media Production Pipeline)

**M4-1 — Production workspace scaffold** ✅ *Implemented*
A full-window extension page (spec decision #11) reachable from the side panel, sharing the panel's stylesheet, modal, toast and chat round-trip rather than growing a second copy of each.
*Acceptance:* The page opens from the panel, focuses an existing workspace tab instead of opening a second one, and renders the scene rail plus three columns.
*Built as:* `studio/studio.html` + `studio/lib/*`, opened by **Studio ↗** in the side panel header (and **Composer** in the studio opens the side panel back). Both pages use the same `shared/` modules — dialog, toasts, chat round trip, project bar, record store — so they behave identically. Columns stack below 1100px rather than squeezing.

**M4-2 — Production / Scene / Shot data model** ✅ *Implemented*
Define production → scenes → blocks / shot / renders, with sequences, an asset pool, and in-box/out-box, all behind the Core repository seam.
*Depends on:* CORE-4 (for the Drive backing; the seam ships without it)
*Acceptance:* CRUD works against the schema and every write goes through one module.
*Built as:* `studio/lib/model.js` holds the shapes and vocabularies; `studio/lib/repository.js` reads and writes through the shared record store (`shared/store.js`), coalescing writes so typing in a block doesn't hit storage per keystroke. Productions, assets and in-box/out-box documents are separate records inside a project; the asset pool belongs to the project and is shared by all its productions (spec decision #17). Synced to Google Docs by Core once connected.

**M4-3 — Scene rail: scenes, ordering, duplication, sequences** ✅ *Implemented*
Create, rename, reorder, duplicate and delete scenes; bundle scenes into named sequences.
*Acceptance:* A duplicated scene carries its blocks and shot but not its render history; a scene can belong to more than one sequence.
*Built as:* Drag-to-reorder rail with a filled/total count per scene, double-click to rename and set Status. Fixed after review: the rail's drag handler was missing, so reordering silently did nothing. Sequences are a checklist over the production's scenes and always play in rail order.

**M4-4 — Column 1: asset pool, search and multi-select** ✅ *Implemented*
Searchable, category-filtered grid; ticking attaches an asset to the current scene; one asset can be promoted to the shot's opening still.
*Acceptance:* Attached assets appear in the assembled prompt with their source URL retained.
*Built as:* Click to attach, ☆ to make it the still. (Originally double-click, which fought the click-to-attach — un-setting a still that way could never work.) Category chips carry counts. Search covers name, description, category and tags.

**M4-5 — Asset intake: upload, URL, describe** ✅ *Implemented*
Three ways in: a local image, a URL, or a description of something that doesn't exist yet.
*Acceptance:* Every asset keeps its origin and, where there is one, its source URL.
*Built as:* Uploads are downscaled to a 320px thumbnail and stored as a reference (name, size, type) rather than a copy of the bytes — decision #14. A described asset has no picture and shows its category initial until one is attached.

**M4-6 — Column 2: running order** ✅ *Implemented*
Typed blocks — Location, Setting, Scene/Action, Set Dressing, Characters, Wardrobe, Dialogue, Camera, Sound, Transition — with drag-to-reorder, add/remove, and a blank marker.
*Acceptance:* Reordering changes the assembled prompt; blank blocks are visibly distinct from filled ones.
*Built as:* A new scene starts with the four blocks from the sketch. Blanks are dashed and badged, because that's what the seed pass is allowed to fill.

**M4-7 — Column 3: shot builder** ✅ *Implemented*
Still plus aspects — time of day, atmosphere, look, lighting, exposure, then camera, motion, duration, aspect ratio and what to avoid — all editable inline.
*Acceptance:* Every aspect reaches the assembled prompt; the mechanical settings are separable from the description.
*Built as:* The five sketched aspects are always shown and read out as one cinematography line; **More** reveals the rest, which are emitted as their own settings.

**M4-8 — Per-block preview and highlight** ✅ *Implemented*
Show what each block contributes to the whole prompt, so the effect of a change is visible before generating.
*Acceptance:* Selecting a block highlights its segment inside the full assembled prompt.
*Built as:* The preview renders segment by segment rather than as one string; focusing a block's textarea lights up its segment. A footer counts parts and characters.

**M4-9 — Generator targets and job profiles** ✅ *Implemented*
Prompt shaping per target generator, plus profiles for recurring kinds of work.
*Acceptance:* Switching generator changes how the shot is worded; switching profile fills that profile's settings.
*Built as:* Targets are **Sora** (the Sora page, or a ChatGPT chat) and **Veo** (Flow, or a Gemini chat) per decision #12. Switching profile re-applies across every scene, replacing only values a profile set — hand-typed settings stay. Profiles: general, comic page → shots, social vertical, establishing/B-roll, dialogue two-shot, action beat, insert. Profile defaults fill blanks only, so choosing one never rewrites a duration set by hand.

**M4-10 — Scene seed expansion (blanks only)** ✅ *Implemented*
Start from a one-line seed and have each pass fill the blanks, building the scene out over iterations.
*Depends on:* M4-2, M4-6, M4-7
*Acceptance:* Anything already written survives a pass untouched; the pass count is visible.
*Built as:* **Fill blanks** collects the empty blocks and aspects, asks for exactly those, and applies only what it asked for — a returned field that wasn't blank is discarded rather than trusted. Runs through a chat tab that's already open (decisions #2/#4), never an API call.

**M4-11 — Chat to refine** ✅ *Implemented*
A plain-language change applied to the current shot.
*Acceptance:* Only the fields the change affects are rewritten, and the instruction is logged.
*Built as:* Refine is the one path allowed to overwrite written fields, because that's the explicit ask. Each instruction lands in a per-scene log with how many fields it moved.

**M4-12 — Rebuild scenes from a script** ✅ *Implemented*
Paste or drop a script, a treatment or a comic page description and get an ordered shot list.
*Acceptance:* Scenes are created in order, populated from what the source supports, appended or replacing.
*Built as:* The real-world case from the notes. Shot cap is settable; each returned shot becomes a scene with its blocks and aspects pre-filled.

**M4-13 — In-box and out-box** ✅ *Implemented*
Per-production folders: scripts and assets in, produced clips and reports out.
*Acceptance:* A dropped script is readable in the in-box and can be turned into scenes or imported as material; produced work is listed in the out-box.
*Built as:* One drawer for both. Page-wide file drop: images go straight into the asset pool, text files into the in-box. Each production is a Drive folder with In-box and Out-box folders, and every in-box script or note and every filed report is a Google Doc in them. A saved reply can be sent straight to the in-box from the side panel (**To studio**).

**M4-14 — Produce** ✅ *Implemented*
Assemble → reword for the target → write into the generator's tab → record what was sent.
*Acceptance:* Scope can be one scene, a sequence or the whole production; every produced shot is recorded with the exact prompt used.
*Built as:* Optional per-shot rewording round trip before the hand-off. A cancelled rewrite stops the run rather than silently sending the unoptimized wording. Injection fills the input and stops — pressing send stays with Dan.

**M4-15 — Review loop** ✅ *Implemented*
Keep / reject / regenerate per render, with notes, and a field for the clip's link.
*Acceptance:* Notes carry into the regeneration; the link back to the generating session is stored with the render.
*Built as:* In the out-box, colour-coded by verdict. Regenerate re-runs Produce for that one scene with the note appended to the prompt.

**M4-16 — Dailies report** ✅ *Implemented*
A Markdown summary of what was produced, from which prompt, with which verdict.
*Acceptance:* Filed into the out-box, viewable and downloadable.
*Built as:* Counts by verdict, sequences, every shot with its renders, prompts and links, and the references used. Filed as a document in the out-box (a Google Doc when connected) and downloadable as `dailies-<production>-<date>.md`.

**M4-17 — Import existing material** ✅ *Implemented*
Bring in characters, scenes, locations, action sequences, dialogue and mood/lighting that already exist.
*Acceptance:* Imported entries land in the same asset pool as everything else.
*Built as:* Structured JSON is loaded directly — no round trip spent on material that's already structured. Freeform notes are pulled apart by an open chat instead.

**M4-18 — Production cost estimate (P1)** ❌ *Not started*
Feed the shot count and prompt sizes of a production run into the Usage tab (CORE-8), the way the composer's estimate does.
*Depends on:* CORE-8

**M4-19 — Continuity warnings (P1)** ❌ *Not started*
Warn when a character or location is described differently across the scenes of one sequence.

**M4-20 — Further generator profiles (P1)** ❌ *Not started*
Runway, Kling and Luma. The target list is data — a new one is an entry in `VIDEO_TARGETS` plus its guidance, no other change.

**M4-21 — Storyboard contact sheet (P1)** ❌ *Not started*
A single sheet of the stills across a sequence, for review at a glance.

---

## Shared work this phase pulled in

**CORE-10 — Shared chat round trip** ✅ *Implemented*
The send-to-tab → wait → scrape loop that Optimize (M1.5-2) introduced, extracted so Module 4's expansion, refine, breakdown, import and produce steps all use one implementation.
*Built as:* `extension/shared/roundtrip.js` (originally `sidepanel/lib/roundtrip.js`, before the shared modules were given their own folder). `optimize.js` now calls it rather than carrying its own poller, so a fix to streaming detection lands in both surfaces at once.

---

*Sizing and sprint assignment intentionally left open, same as the earlier ticket sets.*
