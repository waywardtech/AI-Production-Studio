// The studio server: a JSON API over the studio service, and the UI.
//
//   node pipeline/server.mjs          → http://localhost:4173
//
// node:http and nothing else. State lives in pipeline/.data/studio.json.
// Imported media lives beside it in pipeline/.data/files/.
//
// Nothing here calls an AI service. Generators are either the built-in
// mocks or hand-offs to a chat subscription (src/handoff.mjs), where a
// person sends the prompt and imports the result.

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './src/store.mjs';
import { createAdapters, ModelError } from './src/adapters.mjs';
import { createStudio } from './src/studio.mjs';
import { seedDemo } from './src/demo.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const DATA = process.env.DATA_FILE || join(ROOT, '.data', 'studio.json');
mkdirSync(join(DATA, '..'), { recursive: true });

// "Chaos" lets the recovery paths be seen without waiting for a real
// outage: make the first attempt of everything fail, or take the video
// model down entirely.
let chaos = 'none';
const faults = (recipe, attempt) => {
  if (chaos === 'flaky' && attempt === 1) throw new ModelError('transient', 'Simulated: upstream 503 on the first attempt.');
  if (chaos === 'video-down' && recipe.modelId === 'motion-v2') throw new ModelError('timeout', 'Simulated: motion-v2 is not answering.');
};

// Imported files are named by content hash, so writing one twice is
// harmless and none is ever changed.
const FILES = join(DATA, '..', 'files');
mkdirSync(FILES, { recursive: true });
const filePath = (id) => join(FILES, id.replace(/[^a-zA-Z0-9_]/g, ''));
const files = {
  put: (id, bytes) => { if (!existsSync(filePath(id))) writeFileSync(filePath(id), bytes); },
  get: (id) => (existsSync(filePath(id)) ? readFileSync(filePath(id)) : null),
};
const MAX_UPLOAD = 1024 * 1024 * 1024;

const store = createStore({ file: DATA });
const studio = createStudio({ store, files, adapters: createAdapters({ faults, latencyMs: Number(process.env.LATENCY_MS || 700) }), queueOptions: { backoffMs: (n) => 400 * n } });
if (store.list('shots').length === 0) seedDemo(studio);

// Anything left "running" by a previous process is dealt with before the
// queue starts handing out work.
const recovered = studio.queue.recover ? studio.queue.recover() : null;
if (recovered?.requeued) console.log(`Recovered ${recovered.requeued} interrupted job(s).`);
setInterval(() => { studio.queue.pump().catch((error) => console.error(error)); }, 250);

const shotDetail = (id) => {
  const view = studio.inspect(id);
  const takes = studio.takesOf(id).map((take) => ({ ...take, recipe: store.get('recipes', take.recipeId), master: studio.masterOf(take), promotion: studio.promotionCheck ? studio.promotionCheck(take.id) : null }));
  return { ...view, world: undefined, takes, status: studio.staleness(id) };
};

const routes = [
  ['GET', /^\/api\/state$/, () => ({
    board: studio.board(), graph: studio.graph(), models: studio.models, chaos, routing: studio.routing(),
    handoffs: store.list('jobs', (job) => job.byHand && job.status === 'waiting').sort((a, b) => a.createdAt - b.createdAt).map((job) => ({ ...studio.handoffSheet(job.id), createdAt: job.createdAt })),
    bible: store.list('bible').map((entity) => ({ ...entity, version: store.get('bibleVersions', entity.headVersionId), downstream: studio.downstreamShots(entity.id).length })),
    jobs: store.list('jobs').sort((a, b) => b.createdAt - a.createdAt).slice(0, 30),
    delivery: studio.exportManifest(),
  })],
  ['GET', /^\/api\/shots\/([^/]+)$/, (m) => shotDetail(m[1])],
  ['POST', /^\/api\/shots\/([^/]+)$/, (m, body) => studio.updateShot(m[1], body)],
  ['POST', /^\/api\/shots\/([^/]+)\/render$/, (m, body) => studio.render(m[1], body)],
  ['POST', /^\/api\/shots\/([^/]+)\/refine$/, (m) => studio.applyRefine(m[1])],
  ['POST', /^\/api\/shots\/([^/]+)\/lock$/, (m, body) => studio.setLock(m[1], body.key, body.text)],
  ['POST', /^\/api\/shots\/([^/]+)\/approve$/, (m, body) => studio.approve(m[1], body.takeId)],
  ['POST', /^\/api\/takes\/([^/]+)\/promote$/, (m) => studio.promote(m[1])],
  ['POST', /^\/api\/takes\/([^/]+)\/branch$/, (m, body) => studio.branch(m[1], body)],
  ['POST', /^\/api\/promote-approved$/, (m, body) => studio.promoteApproved(body)],
  ['POST', /^\/api\/rerender$/, (m, body) => studio.rerender(body.shotIds)],
  ['POST', /^\/api\/bible\/([^/]+)$/, (m, body) => studio.reviseEntity(m[1], body)],
  ['POST', /^\/api\/jobs\/([^/]+)\/retry$/, (m) => studio.queue.retry(m[1])],
  ['POST', /^\/api\/jobs\/([^/]+)\/fallback$/, (m) => studio.retryWithFallback(m[1])],
  ['POST', /^\/api\/batches\/([^/]+)\/resume$/, (m) => studio.queue.resumeBatch(m[1])],
  ['POST', /^\/api\/shots\/([^/]+)\/bakeoff$/, (m, body) => studio.bakeoff(m[1], body)],
  ['POST', /^\/api\/takes\/([^/]+)\/prefer$/, (m) => studio.preferGeneratorOf(m[1])],
  ['POST', /^\/api\/routing$/, (m, body) => studio.setRouting(body)],
  ['POST', /^\/api\/jobs\/([^/]+)\/refused$/, (m, body) => studio.reportRefusal(m[1], body.message)],
  ['POST', /^\/api\/jobs\/([^/]+)\/cancel$/, (m) => studio.cancelHandoff(m[1])],
  ['POST', /^\/api\/chaos$/, (m, body) => ({ chaos: (chaos = body.mode) })],
];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const blob = url.pathname.match(/^\/api\/blob\/([^/]+)$/);
    if (blob) {
      const found = studio.readBlob(blob[1]);
      if (!found?.bytes) return res.writeHead(404).end();
      // Outputs are addressed by content hash, so they never change.
      const headers = { 'Content-Type': found.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Accept-Ranges': 'bytes' };
      if (url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="${(url.searchParams.get('download') || blob[1]).replace(/[^\w .-]/g, '_')}"`;
      // Video players ask for byte ranges.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && (range[1] || range[2])) {
        const size = found.bytes.length;
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size) return res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 }).end(found.bytes.subarray(start, end + 1));
      }
      return res.writeHead(200, { ...headers, 'Content-Length': found.bytes.length }).end(found.bytes);
    }
    // The result of a hand-off: the file itself as the request body.
    const delivery = req.method === 'POST' && url.pathname.match(/^\/api\/jobs\/([^/]+)\/deliver$/);
    if (delivery) {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_UPLOAD) throw Object.assign(new Error('That file is larger than 1 GB.'), { refusal: true });
        chunks.push(chunk);
      }
      const result = studio.deliver(delivery[1], { bytes: Buffer.concat(chunks), mime: req.headers['content-type'] || '', filename: url.searchParams.get('name') });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    }
    for (const [method, pattern, handler] of routes) {
      const match = req.method === method && url.pathname.match(pattern);
      if (!match) continue;
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const result = await handler(match, raw ? JSON.parse(raw) : {});
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result ?? {}));
    }
    const path = normalize(join(ROOT, 'ui', url.pathname === '/' ? 'index.html' : url.pathname));
    if (path.startsWith(join(ROOT, 'ui')) && existsSync(path)) {
      return res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' }).end(readFileSync(path));
    }
    res.writeHead(404).end('Not found');
  } catch (error) {
    // A refused action (a blocked render, an unsafe promotion) is an
    // answer, not a crash: the reason goes back to be shown.
    res.writeHead(error.blockers || error.refusal ? 409 : 400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: error.message, blockers: error.blockers || null }));
  }
}).listen(PORT, () => console.log(`Studio running at http://localhost:${PORT}`));
