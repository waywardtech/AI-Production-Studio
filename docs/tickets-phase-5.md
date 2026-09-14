# Far Edge Studio — Engineering Tickets (Phase 5)

Media files: importing them, keeping them, and sending them to a chat
alongside the prompt that talks about them.

Derived from decisions 19–22 in `far-edge-studio-productivity-suite-spec.md`.

---

## Epic: Phase 5 — Files

**M5-1 — Local import of any file kind** ✅ *Implemented*
Widen intake past images to video, audio, scripts, PDFs and documents, and keep the bytes so a file can be attached later.
*Acceptance:* Dropping or picking a mixed batch sorts media into the asset pool and readable scripts into the In-box; nothing is silently skipped.
*Built as:* `shared/blobs.js` holds bytes in IndexedDB keyed by blob id; asset records keep a reference only. `studio/lib/files.js` classifies a file rather than asking "is it an image", and takes a video's poster frame from a quarter of the way in. Over 50 MB a file stays a reference and the tile says so.

**M5-2 — Asset files in Drive** ✅ *Implemented*
Mirror an asset's bytes into its project's Drive folder, and fetch them back on a machine that doesn't have them.
*Acceptance:* A file is uploaded once, survives an unrelated edit to its asset, and is trashed with the asset.
*Built as:* `Edge Studio/<Project>/Assets`. Uploads are keyed by blob id, so editing a description doesn't re-send a clip; replacing the bytes trashes the old file. Nothing is downloaded eagerly — "Fetch file" pulls one down when it's wanted, through the worker, whose IndexedDB is the pages'.

**M5-3 — Import from Google Drive** ✅ *Implemented*
Browse the Drive that already exists and bring files in.
*Acceptance:* Folders can be walked and searched; picked files arrive as assets, Google Docs as In-box text.
*Built as:* A folder browser on the Drive REST API, behind a separate `drive.readonly` grant in Settings. The Google Picker was ruled out: it only works by loading remotely hosted code, which MV3 forbids in an extension page.

**M5-4 — Attach files to a chat or generator** ✅ *Implemented*
Send an asset's file into the tab alongside the prompt.
*Acceptance:* Files reach the composer and wait there; a page with nowhere to put them says so rather than failing silently.
*Built as:* Bytes cross page → worker → content script as base64 in ~1.5 MB chunks, assembled into Files only at commit. Three strategies in order: the page's own file input, a paste on the composer, a drop on the composer. Produce attaches a shot's still and references; the side panel has a picker for the next Insert. Nothing is ever sent.

**M5-5 — Selector verification on the live sites** ❌ *Not started*
The attachment selectors, and the generator input selectors before them, have only been exercised against stubs.
*Acceptance:* Each of ChatGPT, Claude, Gemini, Sora and Flow confirmed by hand, with the working selector recorded.

**M5-6 — Per-project Drive asset folder of Dan's choosing (P1)** ❌ *Not started*
Point a project at a folder that already exists rather than the one Edge Studio makes. Needs the full `drive` scope — decision #21.

**M5-7 — Attachment reuse across a production (P1)** ❌ *Not started*
Remember that a reference was already attached in this conversation, and don't send it again with the next shot.

---

*Sizing and sprint assignment intentionally left open, same as the earlier ticket sets.*
