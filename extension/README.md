# Edge Studio

A Chrome extension for The Far Edge studio's AI work: build prompts from
reusable blocks and put them into ChatGPT, Claude or Gemini; capture what
comes back; turn scripts into shot lists and hand them to Sora or Veo; and
keep all of it organised by project — in Google Docs, once connected.

It never calls an AI model itself and never presses send. It works through
the chat tabs you already have open, and every prompt waits in the input
box for you.

## Install (unpacked, Chrome only)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → choose this `extension/` folder.
3. Click the Edge Studio toolbar icon. The side panel opens with a short
   "How Edge Studio works" guide at the top.

## How it's organised

**Projects.** Everything belongs to a project — a client, a show, a
campaign. The project bar at the top of every page switches between them,
and every page follows the same choice: pick "Apex" in the side panel and
the studio shows Apex too. In Google Drive a project is a folder.

**Three places to work.**

| Where | What it's for |
|---|---|
| **Side panel** (toolbar icon) | Sits beside your chats. **Prompts**: build, insert, optimize, save. **Replies**: capture and reuse what came back. **Usage**: how much quota each service has left. |
| **Studio ↗** (full window) | Productions: scenes, an asset pool, shot prompts for Sora and Veo, Produce, review, dailies. **Composer** in its header opens the side panel beside it. |
| **Settings ⚙** | Connect Google Docs; download or restore a backup. |

**Chat tabs.** Open ChatGPT, Claude, Gemini, Sora or Flow tabs are listed
at the top of the side panel, badged by platform. Tick the ones to act on;
give one a label ("Client X") and it's called that everywhere, in the
studio's pickers too. Labels last until the browser closes.

**Where your work is.** In this browser from the start; in Google Docs as
well once connected. The line under the project bar always says which —
*Local only*, *In Google Docs · 2 min ago*, *Syncing…*, or *Reconnect
Google* — and clicking it opens Settings.

## The everyday loop

1. **Open a chat** and press **Refresh** under Chat tabs; tick it.
2. **Build a prompt** on **Prompts**: click a block (Scenario, Expertise,
   Ask, Format…), write, repeat. Press **Insert** — it lands in the chat's
   input box; press Enter there.
3. **Capture the answer** on **Replies** → **Latest response**, or
   highlight part of it in the page → **Selection**. Trim it, then:
   **Save**, **To builder**, **New prompt**, or **To studio**.
4. **For video**, a script or scene list sent **To studio** waits in the
   production's in-box → **Break into shots** → **Fill blanks** → **Produce**.
5. **Review** in the out-box: paste each clip's link, keep / reject /
   regenerate, then **File dailies report**.

## Prompts (the composer)

**Blocks.** Click or drag a block into the builder. Each block has a type
dropdown, so an Ask that should have been a Scenario is one click to
change. **Manage** renames, removes or adds block types — a studio that
thinks in "Guard Rails" or "Reference" blocks can have those instead.
Renaming keeps the underlying id, so saved prompts follow the new name.

**Variables.** A token like `<client>` or `w<current-week>` is a variable.
On **Insert**, a form asks for each value once and fills every
occurrence; the saved prompt keeps the placeholder for next time, and the
last value you used is prefilled.

- A name must look like an identifier, so `</closing>` tags,
  `<dan@thefaredge.com>`, `<https://…>` and `Map<string,int>` are left
  alone.
- **Blank means leave it as-is** — `<li>` or `Array<string>` look like
  variables, so they appear in the form; leave them blank and they pass
  through untouched.
- `\<li\>` escapes the brackets and is never offered as a variable.

**Optimize.** Rewrites the prompt for ChatGPT, Claude or Gemini using a
chat you already have open (never a generator page, which can't answer).
Edge Studio writes the request into that chat, you press Enter, it waits
for the full answer, then shows the rewrite to edit, **Copy**, or
**Replace builder**. The request tells the model to keep `<placeholders>`
intact and to use headings rather than XML-style tags, which would come
back looking like placeholders.

**Saved prompts.** **Save** stores the builder in the current project,
with tags. With **All** selected they're grouped by tag — a prompt tagged
`apex` and `work` shows under both; a tag chip narrows to one. ✎ edits
name, tags and Status (Draft / In Review / Approved / Archived). Once
synced, **Doc ↗** opens the prompt in Google Docs.

**Cost estimate.** Under the preview: a rough token count (about four
characters per token — a size signal, not a bill) and a meter for each
service you're about to send to, red at its warning threshold.

## Replies

**Latest response** captures the newest answer from each ticked chat;
**Selection** captures what you've highlighted in the page. Captures are
staged in editable boxes — trimming one down *is* how you save part of an
answer.

Saved replies carry a link to the conversation they came from, tags and a
Status, and a filter across title, text, tags and source. On each:

- **To builder** — append to the current prompt.
- **New prompt** — start a fresh prompt from it.
- **To studio** — into the in-box of the production the studio has open.
- **Copy MD** — Markdown with its source link.
- **Doc ↗** — once synced, open it in Google Docs.

To builder, New prompt and To studio use whatever you've highlighted in
the reply's text box, or the whole reply if nothing is.

## The studio (productions)

```
 Scenes  │ 1 · Assets         │ 2 · Running order │ 3 · Shot builder
 ────────┼────────────────────┼───────────────────┼─────────────────────────
 Alpha   │ search, categories │ seed              │ still
 Bravo   │ click to attach    │ Location          │ time of day · look
 Charlie │ ☆ = opening frame  │ Setting           │ lighting · exposure
 Seq. A  │ upload / URL /     │ Scene / Action    │ refine
         │ describe           │ + add block       │ preview → Save to prompts
```

A project holds any number of productions (header: Production, **+ New**,
✎). Each production has scenes (drag to reorder, double-click to rename,
**Duplicate**, bundle into **Sequences**), an in-box and an out-box. The
**asset pool belongs to the project**, so a character or location is
reused across every production in it.

**Build a scene.** Write a one-line seed. **Fill blanks** asks an open chat
for the empty blocks and aspects only — anything already written survives
every pass. **Refine** takes a plain-language change and is the one path
allowed to rewrite written fields. Click into a block and its part of the
assembled prompt lights up in the preview. **Save to prompts** keeps a
finished shot in the project's Saved prompts, tagged `shot`.

**Generator and job profile.** Sora (the Sora page, or a ChatGPT chat) or
Veo (Flow, or a Gemini chat), and a profile — general, comic page → shots,
social vertical, establishing, dialogue two-shot, action beat, insert.
A profile fills its settings (duration, aspect ratio, what to avoid) into
every scene, replacing only values a profile set; anything you typed stays.

**Scripts and material.** Drop text files or images anywhere on the page:
text lands in the in-box, images join the asset pool as thumbnails and
references. **Scenes from script…** turns a script or a comic page into
scenes; **Import material…** reads characters, locations, wardrobe and so
on from JSON directly (a list, `{assets:[…]}` or `{characters:[…]}`) or
from notes via a chat.

**Produce.** Choose the scope (this scene, a sequence, every scene), the
generator tab, and optionally a *separate* chat to reword each shot for
the generator first — never the generator tab itself, which would spend
its quota. Each shot is written into the generator's input box and the run
**waits** for you to send it before the next one replaces it. Stopping
records only what was actually sent.

**Review.** The out-box lists every render with its exact prompt: paste
the clip's link, keep / reject, or **Regenerate** with a note that's
carried into the next attempt. **File dailies report** writes the lot up —
filed in the out-box, downloadable, and a Google Doc when connected.

## Usage

One row per service with a meter that drains as quota is spent, turning
red at a threshold you set (default 10% left). None of the chat services
publishes a usage API or reliably shows a quota, so **manual entry (✎) is
the reliable path**; **Read from tabs** is a best-effort scan for phrasings
like "12 messages remaining" and says plainly when it finds nothing.
**Add service** covers anything else with a budget.

## Google Docs and Settings

Connected, Edge Studio keeps a Google Doc for everything that's a
document, organised by project:

```
Edge Studio/
  <Project>/
    Prompts/          a Doc per saved prompt — edit the text under each [Heading]
    Replies/          a Doc per saved reply
    Productions/
      <Production>/   its shot list (generated from the studio)
        In-box/       a Doc per script or note
        Out-box/      a Doc per dailies report
```

- **Edits in Google Docs come back** on the next sync — text under a
  prompt's `[Heading]`, a new heading as a new block, a fixed typo in a
  reply or script, a renamed Doc. If it was also changed in Edge Studio
  since, the later edit wins. A prompt Doc with every heading deleted is
  ignored rather than wiping the prompt. The shot list is one-way and says so.
- **Deleting moves Docs to Drive's trash**, where they can be restored —
  delete dialogs say so when Google is connected.
- **Tags and status** go into each Doc's Drive description, so Drive search
  finds them.
- **A second computer catches up** from a small hidden index in Drive's
  app-data folder, without duplicating a folder or a Doc.
- Sync runs in the background a few seconds after an edit, every five
  minutes, and on **Sync now**.

**Setting it up** — once, about five minutes; Settings walks through it
and shows the exact values to copy:

1. Create a Google Cloud project and enable the **Google Drive API**.
2. OAuth consent screen: **Internal** for a Google Workspace account;
   otherwise **External**, left in **Testing**, with your address added as
   a test user (Google may then ask you to reconnect about weekly).
3. Create an **OAuth client ID** → **Web application**, with the redirect
   URI Settings shows (`https://<extension-id>.chromiumapp.org/`).
4. Paste the client ID into Settings → **Connect**.

Edge Studio asks for `drive.file` (only files it creates — never the rest
of your Drive) and `drive.appdata` (its hidden index). Neither is a
sensitive scope, so there's no Google review. Access tokens live in
session storage only. The extension ID comes from the folder Edge Studio
is loaded from, so loading it from somewhere else changes the redirect URI;
Settings always shows the current one.

**Backup.** Settings downloads everything in this browser as one file and
restores it by merging — missing or newer records come in, nothing is
deleted or replaced with an older copy.

**What's verified.** The sync engine is tested against a simulated Drive
that follows the documented API (`tests/sync.test.mjs`). It hasn't run
against Google's live servers, which needs your client ID — the first real
sync is the confirmation.

---

## Reference

### Ticket status

| Area | Status |
|---|---|
| Core: projects, record store, migration (CORE-4) | ✅ |
| Core: Google sign-in (CORE-1), Drive folders (CORE-3), Docs sync (CORE-4) | ✅ — live Google untested, see above |
| Core: folder picker (CORE-2) | Superseded — Edge Studio owns an `Edge Studio/<Project>` tree instead |
| Core: Status + tags (CORE-5) | ✅ Status on projects, productions, scenes, prompts, replies; custom tags on prompts, replies, assets |
| Core: chat transcript export (CORE-6) | ❌ |
| Core: backup / restore (CORE-7) | ✅ |
| Core: usage tab + thresholds (CORE-8/9) | ✅ — scraping best-effort |
| Core: shared chat round trip (CORE-10) | ✅ |
| Module 1: composer, injection, variables, optimize (M1-1…M1-11, M1.5-1…7) | ✅ |
| Module 1: usage scrape (M1-10, M1.5-8) | ⚠️ best-effort |
| Module 2: capture, save, reuse (M2-1…3) | ✅ |
| Module 2: Gemini native save (M2-4), reformat pipeline (M2-6) | ❌ |
| Module 2: export to Drive (M2-5) | ✅ via Google Docs sync |
| Module 2: other export formats (M2-7) | ⚠️ Copy MD only |
| Module 3: visual reference pipeline | ❌ not ticketed |
| Module 4: production pipeline (M4-1…M4-17) | ✅ |
| Module 4: cost estimate, continuity, more generators, contact sheet (M4-18…21) | ❌ P1 |

Full notes per ticket: `docs/tickets-phase-0-2.md` and `docs/tickets-phase-4.md`.

### Code layout

```
background.js         tab detection, the content-script relay, and Google sync
content-scripts/
  chat-adapter.js     the only code that touches chat and generator pages
shared/               used by every page (and some by the background worker)
  store.js            every record and setting, one key each; change events
  model.js            projects, prompts, replies, documents; statuses, tags
  projects.js         the active project; create, rename, delete
  project-bar.js      the project switcher every page shows
  migrate.js          brings data from earlier builds into projects
  tabs.js             open chat tabs and what they're called
  google-auth.js      signing in to Google; tokens kept per session
  drive.js            the few Drive v3 calls Edge Studio makes
  docs-format.js      how records read as Docs, and how edits come back
  sync.js             pull, read back, push — the Google Docs sync engine
  sync-status.js      the "where is my work" line; delete-dialog wording
  modal.js            the one dialog every page uses
  ui.js               toasts, tab switching, clipboard, selection
  roundtrip.js        one trip through an open chat: send, wait, read
  variables.js        <placeholder> logic — pure
sidepanel/            Prompts, Replies, Usage (lib/: one module per concern)
studio/               productions (lib/: model and prompt are pure)
settings/             Google Docs connection, backup and restore
```

`shared/store.js` is the only durable-storage module, so no page knows or
cares whether a record came from this browser or from Drive. Sync runs
only in the background worker, so two open pages can never push the same
change twice. Neither page imports the other's code. Tests are at the repo
root: `npm test`.

### Chat and generator pages

`content-scripts/chat-adapter.js` holds one `PLATFORMS` table — the single
place a site redesign lands. Selectors run most-specific first and fall
back to generic structure:

| Platform | Prompt box | Replies |
|---|---|---|
| ChatGPT | `#prompt-textarea` → contenteditable → textarea | `[data-message-author-role="assistant"]` → turns minus the user's |
| Claude | `.ProseMirror` → contenteditable → textarea | `[data-testid="assistant-message"]` → `.font-claude-message` → `[data-is-streaming]` |
| Gemini | `rich-textarea .ql-editor` → `.ql-editor` → contenteditable → textarea | `model-response` → `.model-response-text` |
| Sora, Flow | textarea → contenteditable | — (generator pages; no replies) |

These sites change their markup without notice, so the selectors are
best-effort — the Sora and Flow ones especially, which are generic. When a
prompt box can't be found, the prompt goes to the clipboard with a clear
message, and a capture that finds nothing says so. A tab that was open before the extension
loaded gets the adapter injected on demand — no reload needed.

Tab labels live in `chrome.storage.session` because Chrome reuses tab IDs
after a restart; a label saved to disk would eventually reattach to the
wrong tab.
