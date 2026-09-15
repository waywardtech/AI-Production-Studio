# Page harness

Stubs for opening an extension page in an ordinary browser tab, without
loading the extension at all — useful for poking at layout and flows by
hand.

- `chrome-stub.js` — a fake `chrome.*`: storage in memory, and simulated
  chat tabs whose prompt box and latest reply the page can drive.
- `seed-legacy.js` — writes data in the pre-v2 shape, so the migration
  can be watched running.

Copy an extension page and these next to each other, serve the folder
(`python -m http.server`), and open it.

For the real thing — the extension actually loaded into Chrome, with
IndexedDB, content scripts and the background worker — see
`../browser/`.
