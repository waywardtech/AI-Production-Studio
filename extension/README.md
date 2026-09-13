# Edge Studio

A working Chrome extension covering the Phase 1 and Phase 1.5 ticket
sets, the first three Phase 2 tickets from
`../../docs/tickets-phase-0-2.md`, and Phase 4's production pipeline
from `../../docs/tickets-phase-4.md`. Load it, use it on ChatGPT today,
then keep building on top of it.

The panel has three tabs — **Prompts** (build, save, tag, insert,
optimize), **Replies** (capture, save, reuse) and **Usage** — over a
shared **Chat tabs** list, since both act on the same ticked tabs.

**Production ↗** in the panel header opens the Module 4 workspace: a
full window with a scene rail and the three columns — assets, running
order, shot builder — that compose clip prompts for Sora and Veo. See
[The production workspace](#the-production-workspace-module-4) below.

The extension is named **Edge Studio** and lives in `extension/`. It
used to sit in `modules/module-1-prompt-composer`, a name that stopped
being true once it held Modules 1, 2 and 4.

## Install (unpacked, Chrome only)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the repo's `extension/` folder
5. Click the extension's toolbar icon to open the side panel
6. Open a ChatGPT, Claude or Gemini tab, click **Refresh** under Chat
   tabs, tick the tab, build a prompt on the **Prompts** tab, and click
   **Insert**
7. To pull work back out, switch to **Replies** and use **Latest
   response** (or highlight text in the page and use **Selection**)
8. For video work, click **Production ↗** in the panel header

## What's implemented

| Ticket | Status | Notes |
|---|---|---|
| M1-1 Extension scaffold | ✅ | Manifest V3, service worker, side panel |
| M1-2 Block builder UI | ✅ | Drag Scenario / Expertise / Ask into the canvas, edit inline |
| M1-3 Prompt library (save/load) | ⚠️ Partial | Saves to `chrome.storage.local`, not Drive — see "What's stubbed" below |
| M1-4 Filter + flat list | ✅ | Single filter box over a flat library list |
| M1-5 Chat tab detection | ✅ | Background worker queries open ChatGPT, Claude and Gemini tabs |
| M1-6 Manual tab labeling | ✅ | Editable label per tab, scoped to the browser session |
| M1-7 Destination picker | ✅ | Checkbox list, multi-tab select supported |
| M1-8 Injection engine | ✅ | Multi-strategy (contenteditable + textarea) across all three platforms, see caveat below |
| M1-9 Clipboard fallback | ✅ | Auto-triggers on injection failure with a clear toast |
| M1-10 / M1.5-8 Usage scrape | ⚠️ Partial | Best-effort text scrape; these services rarely show a figure — see below |
| M1-11 Variable placeholders | ✅ | See below |
| M1.5-1 Format block | ✅ | Ships as a default block type; block types are editable — see below |
| M1.5-2 Optimize step | ✅ | Runs in a chat you already have open, no bundled API call — see below |
| M1.5-3 Optimize result intake | ✅ | Scraped reply is shown for approve / edit / copy before it touches the builder |
| M1.5-4 Claude injection | ✅ | Shared page adapter, ProseMirror composer |
| M1.5-5 Gemini injection | ✅ | Shared page adapter, Quill (`rich-textarea`) composer |
| M1.5-6 Claude + Gemini detection | ✅ | Chat tabs lists all three, badged by platform |
| M1.5-7 Multi-platform destination | ✅ | Tick tabs across platforms and Insert reaches all of them |
| M2-1 Reply capture panel | ✅ | Captures the latest reply, or the page selection, per ticked tab, on all three platforms |
| M2-2 Select & save | ✅ | Staged captures are editable before saving, which is also how "save just this section" works |
| M2-3 Send to prompt | ✅ | Drops a capture or saved response into the builder as a Scenario block |
| M2-4 Gemini native save | ❌ Not started | Unblocked now Gemini is supported; still to build |
| M2-5 Export-to-Drive fallback | ❌ Not started | Blocked on CORE-1/CORE-4, same as M1-3 |
| M2-6 Reformat pipeline | ❌ Not started | P1 |
| M2-7 Alternate export formats | ⚠️ Partial | **Copy MD** puts a saved response on the clipboard as Markdown; writing real files waits on Drive |
| CORE-10 Shared chat round trip | ✅ | Optimize's send → wait → scrape loop extracted so the pipeline reuses it |
| M4-1 Workspace scaffold | ✅ | Full window, opened from the panel; shares its modal, toast and stylesheet |
| M4-2 Production/scene/shot model | ⚠️ Partial | Same local-storage stand-in as M1-3, behind the same seam |
| M4-3 Scene rail + sequences | ✅ | Reorder, duplicate, bundle; a duplicate carries the shot but not the renders |
| M4-4 Asset pool | ✅ | Search, category chips, click to attach, ☆ for the still |
| M4-5 Asset intake | ✅ | Upload, URL or description; references and thumbnails, never copies |
| M4-6 Running order | ✅ | Ten block types, drag to reorder, blanks marked |
| M4-7 Shot builder | ✅ | The five sketched aspects, plus camera/motion/duration/ratio behind **More** |
| M4-8 Per-block preview | ✅ | Selecting a block highlights its segment in the assembled prompt |
| M4-9 Targets + job profiles | ✅ | Sora and Veo; seven profiles, defaults fill blanks only |
| M4-10 Seed expansion | ✅ | Fills blanks only — see below |
| M4-11 Chat to refine | ✅ | The one path allowed to rewrite what's already written |
| M4-12 Scenes from a script | ✅ | The comic-page case: source material in, shot list out |
| M4-13 In-box / out-box | ⚠️ Partial | Working, on local storage; real Drive folders wait on CORE-2/CORE-3 |
| M4-14 Produce | ✅ | One shot at a time into the generator tab, pausing between shots; rewording runs in a separate chat; never presses send |
| M4-15 Review loop | ✅ | Keep / reject / regenerate with notes carried forward |
| M4-16 Dailies report | ✅ | Markdown, filed to the out-box, downloadable |
| M4-17 Import material | ✅ | JSON loads directly; freeform notes go through an open chat |
| M4-18/19/20/21 | ❌ Not started | P1: cost estimate, continuity warnings, more generators, contact sheet |

## Variable placeholders

A token inside `<angle brackets>` in a block — with or without a prefix
attached, e.g. `w<current-week>` or `<session-date>` — is a variable.
Templates keep the raw `<placeholder>` form when saved to the library.
On **Insert**, every unique variable in the assembled prompt is
collected and a small form asks for each value once; the same value
fills every occurrence.

Example: `Review w<current-week> session and compare it to the session
on <session-date>` prompts for `current-week` and `session-date`. Enter
`37` and `01-28-1969` and the text actually sent/copied becomes:
`Review w37 session and compare it to the session on 01-28-1969` — the
saved template is untouched, so it's reusable next time with new values.

**A name must look like an identifier.** It starts with a letter or
underscore, then letters, digits, hyphens or underscores. That keeps
things that merely sit inside angle brackets from being mistaken for
variables — `</closing>` tags, `<dan@thefaredge.com>`,
`<https://example.com>`, `Map<string,int>` are all left alone.

**Blank means "leave it as-is".** If you clear a field (or ignore it),
that token stays exactly as written instead of being deleted. This
matters for the cases a pattern can't tell apart: `<li>` and
`Array<string>` do look like variables, so they'll appear in the form —
leave them blank and they pass through untouched.

**Escape with a backslash** to keep brackets literal and skip the
prompt entirely: `\<li\>` reaches the target as `<li>` and is never
offered as a variable.

**Values are remembered.** The last value you gave a variable is
prefilled (and pre-selected, so it's easy to overwrite) the next time
that name comes up, since most variables — a client name, a session
date — repeat across inserts.

## Block types (M1-2 / M1.5-1)

The palette ships with Scenario, Expertise, Ask and Format. **Manage**
opens an editor where they can be renamed, removed, or added to — a
studio that thinks in "Guard Rails" or "Reference" blocks can have
those instead.

Renaming keeps a block type's underlying id, so saved prompts using it
follow the new name. Removing one leaves existing blocks working; they
just show the raw id, and the type stays selectable on those blocks so
switching away from it is a deliberate choice rather than silent.

Every block in the builder carries a **type dropdown**, so a block typed
as Ask that should have been a Scenario is one click to change, with its
text untouched.

## Optimize (M1.5-2 / M1.5-3)

**Optimize** rewrites the current prompt for a chosen platform. Per
spec decision #4 it never calls an LLM API — it uses a chat you already
have open:

1. Pick which open chat does the work, and which system the result
   should be tuned for (ChatGPT, Claude or Gemini).
2. Edge Studio writes an optimization request into that chat. It does
   **not** press send — the extension never submits anything in your
   chat, so press Enter there yourself.
3. It then watches that tab and waits for the answer to finish arriving
   rather than scraping a half-streamed reply. **Use latest now** grabs
   whatever is there if you'd rather not wait.
4. The rewrite comes back cleaned up (code fence and any "Here's the
   prompt:" preamble stripped) for you to edit, **Copy**, or use to
   **Replace builder**.

The request tells the model to preserve `<angle bracket>` placeholders
exactly and to structure with markdown headings rather than XML-style
tags — tags would come back and be read as placeholders by the variable
syntax above.

## Tags and grouping (CORE-5)

Saved prompts take free-form tags alongside the standard **Status** tag.
Tags are stored lowercase, so `Apex`, `apex` and `APEX` are one group.

With **All** selected the library groups by tag, and a prompt tagged
both `apex` and `work` appears under both — that's the point of tagging
rather than foldering. Selecting a tag chip narrows to a flat list of
just that tag. The text filter matches titles, statuses and tags, and
combines with whichever tag is selected.

The ✎ on a saved prompt edits its name, tags and Status.

## Usage tab (CORE-8 / CORE-9)

A third tab tracks what each service has left, with a meter that drains
as quota is spent and turns red at a threshold you set per service
(default 10% remaining).

**Read the note on the tab before trusting the scrape.** None of
ChatGPT, Claude or Gemini publishes a usage API, and none of them
reliably renders a quota either — what's on screen depends on your plan,
the model, and how close to a limit you are. So the tab is built the way
CORE-8 asks for it: **manual entry via ✎ is the primary path and always
works**, and **Read from tabs** is a best-effort text scrape layered on
top that says plainly when it finds nothing, naming the tabs it couldn't
read. It recognises phrasings like "12 messages remaining", "18 of your
40 messages" and "5/25 prompts"; anything else needs entering by hand.

Services can be measured in messages, tokens or USD, and **Add service**
covers anything else that burns budget — an image generator, an API
spend cap.

### Cost estimate in the composer

Under the builder preview sits the spec's other P0 item: a rough token
count for the assembled prompt, plus a meter for each service you're
about to send to, which turns red when that service is at or below its
threshold. The token figure is roughly four characters per token — a
"is this prompt huge?" signal, labelled as an estimate, not a billing
number.

## Capturing replies (M2-1 / M2-2 / M2-3)

**Capture** pulls work back out of the tabs ticked under **Chat tabs**:

- **Latest response** grabs the most recent assistant message from each
  ticked tab.
- **Selection** grabs whatever you've highlighted in the page, which is
  how you save part of a response rather than all of it.

Captures are staged, not saved. Each one lands in an editable box so you
can trim it down first — that edit *is* the "save just this section"
step, so there's no separate selection UI to learn. From there:

- **Save** stores it under **Saved Replies**, tagged `Draft`, with a
  link back to the conversation it came from (the repository keeps
  references, not copies — CORE-4).
- **To builder** appends the text to the current prompt as a block.
- **New prompt** starts a fresh prompt from it (asking first if the
  builder isn't empty).
- **Copy MD** (on saved items) puts the reply on the clipboard as
  Markdown with its source link.

Both **To builder** and **New prompt** use whatever you've highlighted
in the reply's text box, falling back to the whole thing if nothing is
highlighted — so pulling one paragraph out of a long reply and turning
it into a prompt is a highlight and a click. Either one switches you to
the Prompts tab so you can see what landed.

Saved replies have their own filter, which matches on title, body text
and source tab.

## The production workspace (Module 4)

Open it with **Production ↗**. It is a full extension page rather than a
fourth panel tab because the layout is a scene rail plus three columns,
which the side panel cannot carry.

```
 Scenes │ 1 · Assets      │ 2 · Running order  │ 3 · Shot builder
 ───────┼─────────────────┼────────────────────┼──────────────────
 Scene 1│ search + grid   │ seed               │ still
 Scene 2│ tick to attach  │ Location           │ time of day
 Scene 3│ upload / URL /  │ Setting            │ atmosphere
 Seq. A │ describe        │ Scene / Action     │ look · lighting
        │                 │ Set Dressing       │ exposure
        │                 │ + add block        │ chat to refine
        │                 │                    │ assembled preview
```

**The loop.** Write a seed — one line of what the shot is. **Fill
blanks** asks an open chat for the empty blocks and aspects only, and
applies only what it asked for; anything already written survives every
pass untouched. Keep going until the scene is built, or fill blocks in
by hand, or push it around with **Refine**, which is the one path
allowed to rewrite what's already there.

**Preview per block.** The assembled prompt is drawn segment by segment.
Click into a block and its contribution lights up inside the whole, so
you can see which part of the shot to change when the result is wrong.

**Produce** writes each shot into the generator's tab and then waits:
press Enter there, come back, and continue to the next — the next shot
goes into the same input box, so it would otherwise replace the one
you haven't sent. Rewording for the generator is optional and runs in a
*separate* chat you pick, so it never spends a generation-quota message
or clutters the session the clips are made in. Like Insert and
Optimize, nothing is submitted for you. What was sent is recorded in the out-box
with the exact prompt, a field for the clip's link, and keep / reject /
regenerate. A rejected pass's notes are carried into the next attempt
rather than retyped. **File dailies report** turns the lot into Markdown.

**In-box / out-box.** Drop scripts and images anywhere on the page:
images join the asset pool, text files land in the in-box. From there a
script becomes a shot list (**Break into shots**) or a pool of
characters and locations (**Import material**).

**Generators.** Sora and Veo, per spec decision #12. A Sora prompt can
go to the Sora page (`sora.chatgpt.com`) or a ChatGPT chat; a Veo prompt
to Flow (`labs.google/fx`) or a Gemini chat. Sora and Flow are
*generator pages* — they take a prompt but have no reply to read, so
Optimize, Fill blanks and Refine only ever run in chats. Their input
selectors are generic and unverified; if one can't be found, the prompt
goes to the clipboard as usual. Adding another is an entry in `VIDEO_TARGETS` in
`studio/lib/prompt.js` with its own guidance — nothing else changes.

**Assets are references.** An uploaded image is stored as a 320px
thumbnail plus a note of the original's name, size and type. The bytes
stay where they are; Drive becomes the canonical home when CORE-4 lands.

## Code layout

Both pages are ES module graphs, one module per concern, with anything
they have in common in `shared/`:

```
shared/
  modal.js            the one dialog both pages use
  ui.js               toasts, tab switching, clipboard, selection
  roundtrip.js        one trip through an open chat tab: send, wait, read
  variables.js        <placeholder> logic — pure, no DOM, no chrome APIs

sidepanel/
  sidepanel.js        entry — wires the modules together and starts them
  lib/
    state.js          shared mutable panel state
    storage.js        every chrome.storage read/write — the CORE-4 seam
    blocks.js         block types: the palette and the Manage editor
    builder.js        the canvas, and everything that puts text into it
    library.js        saved prompts, tags and grouping
    targets.js        the shared Chat tabs list
    insert.js         Insert, the variable form, clipboard fallback
    optimize.js       the platform-targeted rewrite loop
    replies.js        capture, save, and reuse
    usage.js          the Usage tab and the composer's cost meter

studio/
  studio.html         the production workspace page
  studio.css          imports the panel's stylesheet, adds the layout
  studio.js           entry — wires the modules together and starts them
  lib/
    model.js          data shapes, block types, aspects, categories
    prompt.js         assembly, targets, profiles, requests, parsers
    state.js          shared mutable page state
    repository.js     every chrome.storage read/write — the CORE-4 seam
    render.js         the redraw registry the columns talk through
    files.js          reading dropped files; writing the report out
    scenes.js         the scene rail, sequences, and productions
    assets.js         column 1 — the asset pool
    runorder.js       column 2 — the blocks of the script for the scene
    shot.js           column 3 — still, aspects, refine, preview
    seed.js           the chat round trips: expand, refine, script, import
    produce.js        produce → out-box, and the dailies report
    boxes.js          the in-box/out-box drawer and the review loop
```

`variables.js` is deliberately dependency-free so it can be imported and
tested outside a browser; `model.js` and `prompt.js` are the same, which
is what makes the per-block preview cheap enough to recompute on every
keystroke. `storage.js` and `studio/lib/repository.js` are the only
places that talk to `chrome.storage`, which is what makes the Drive swap
below a contained change rather than a sweep.

Neither page imports the other's code: what they share is in `shared/`.
One dialog implementation, one toast, one send-and-scrape loop — a fix to
any of them lands in both surfaces.

Tests live at the repo root in `tests/` and run with `npm test`.

## What's stubbed and why (CORE-1 / CORE-4)

The Phase 0 tickets call for Google OAuth login and a Drive-backed
repository. Both need a **Google Cloud project and OAuth client ID
registered under your own Google account** — that's not something that
can be generated on your behalf, it has to come from you.

So for this build, the prompt library, the saved replies, the block
types and the remembered variable values all use the extension's own
local storage (`chrome.storage.local`) instead. They work fully — save,
load, filter, tag, delete — they just aren't synced to Drive yet, and
they're scoped to this one browser profile.

**To wire in the real thing later:**
1. Create a project in Google Cloud Console, enable the Drive API
2. Create an OAuth 2.0 Client ID (type: Chrome Extension), using this
   extension's ID (visible on `chrome://extensions` once loaded)
3. Add `identity` to `manifest.json` permissions and the client ID under
   `oauth2`
4. Rewrite `lib/storage.js` against the Drive API instead of
   `chrome.storage.local` — nothing outside that file needs to change

Everything else (blocks, tabs, injection, capture, fallback) doesn't
need to change when that happens. Saved responses already carry the
`source` link back to their conversation that CORE-4 expects.

## Tab labels are per browser session

Labels are keyed by Chrome's tab ID and stored in `chrome.storage.session`,
so they're cleared when the browser closes. That's deliberate: tab IDs
are only unique within a session and Chrome reissues them after a
restart, so a label persisted to disk would eventually reattach itself
to an unrelated tab. Labels that survive a restart need a stable key
(the conversation URL) — that's a change worth its own ticket, not a
silent behaviour.

## Tabs opened before the extension loaded

Manifest content scripts only run on navigation, so a ChatGPT tab that
was already open when the extension was installed or reloaded has no
content script and can't be injected into. The background worker now
detects that case and injects `chat-adapter.js` programmatically via
`chrome.scripting`, then retries — no reload needed. The M1-9 clipboard
fallback still covers the cases that can't be recovered (tab
mid-navigation, or a URL outside the extension's host permissions).

## Known caveat: these sites will change their markup

`content-scripts/chat-adapter.js` is the only file that touches any
chat platform's markup, and it's the accepted screen-scraping tradeoff
documented in the spec (§8). One adapter serves all three platforms —
the plumbing and insertion strategies are identical and only the
selectors differ, so those live in a single `PLATFORMS` table at the
top of the file. That table is where a redesign lands.

Each platform lists selectors most-specific first and falls back to
generic structure, so a renamed test id degrades to "still works via
the contenteditable fallback" rather than breaking outright:

| Platform | Composer | Replies |
|---|---|---|
| ChatGPT | `#prompt-textarea` → contenteditable → textarea | `[data-message-author-role="assistant"]` → conversation turns minus the user's |
| Claude | `.ProseMirror` contenteditable → contenteditable → textarea | `[data-testid="assistant-message"]` → `.font-claude-message` → `[data-is-streaming]` |
| Gemini | `rich-textarea .ql-editor` → `.ql-editor` → contenteditable → textarea | `model-response` → `message-content.model-response-text` → `.model-response-text` |

The Claude and Gemini selectors are best-effort and unverified against
the live sites — if capture comes back empty on one of them, that table
is the one thing to fix.

## Next up

Phases 1 and 1.5 are complete, as is the Usage tab, and Phase 4's
pipeline is working end to end on local storage. What's left is mostly
blocked on Phase 0: CORE-1/CORE-4 (Google auth and the Drive-backed
repository, which the prompt library, saved replies, block types, usage
figures and now productions are all waiting on), then M2-4/M2-5 (export
to Drive) and M2-6 (the reformat pipeline). Module 3 (visual reference
pipeline) is still unstarted — Module 4 takes stills from wherever they
come from, so it didn't wait.
