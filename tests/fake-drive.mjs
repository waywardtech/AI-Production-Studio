// A simulated Google Drive v3, implementing exactly the requests
// extension/shared/drive.js makes, with the documented behaviours the
// sync engine relies on:
//
//   - uploading text with the Google Docs mime type creates a Doc;
//     exporting it as text/plain returns a byte-order mark and CRLF
//     line endings, the way Drive's export does
//   - trashing keeps the file (trashed: true) and hides it from
//     `trashed = false` queries
//   - app-data files live in a separate space
//   - a bad or expired token gets 401
//
// What this cannot prove is that Google's real servers behave the same;
// it proves the engine is correct against the documented contract.

export function createFakeDrive() {
  const files = new Map();
  const requests = [];
  let seq = 0;
  let lastTime = 0;
  let validToken = 'token-1';
  let failNext401 = false;

  const stamp = () => {
    lastTime = Math.max(Date.now(), lastTime + 1);
    return new Date(lastTime).toISOString();
  };
  const newFileId = () => `f${++seq}`;

  const publicFile = (f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    webViewLink: `https://drive.example/${f.id}`,
    trashed: !!f.trashed,
    parents: f.parents,
    appProperties: f.appProperties || {},
  });

  const unescape = (s) => s.replace(/\\(['\\])/g, '$1');

  function matchesQuery(file, q) {
    if (!q) return true;
    const quoted = "'((?:[^'\\\\]|\\\\.)*)'";
    const ok = [];
    const prop = q.match(new RegExp(`appProperties has \\{ key=${quoted} and value=${quoted} \\}`));
    if (prop) ok.push((file.appProperties || {})[unescape(prop[1])] === unescape(prop[2]));
    const parent = q.match(new RegExp(`${quoted} in parents`));
    if (parent) ok.push((file.parents || []).includes(unescape(parent[1])));
    if (/trashed = false/.test(q)) ok.push(!file.trashed);
    return ok.every(Boolean);
  }

  function parseMultipart(body, contentType) {
    const boundary = contentType.match(/boundary=([^;]+)/)[1];
    const parts = body.split(`--${boundary}`).slice(1, -1).map((part) => {
      const [, ...rest] = part.split('\r\n\r\n');
      return rest.join('\r\n\r\n').replace(/\r\n$/, '');
    });
    return { metadata: JSON.parse(parts[0]), content: parts[1] };
  }

  const respond = (status, payload, { text = false } = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return typeof payload === 'string' ? JSON.parse(payload) : payload;
    },
    async text() {
      return typeof payload === 'string' ? payload : JSON.stringify(payload);
    },
    async blob() {
      return new Blob([typeof payload === 'string' ? payload : JSON.stringify(payload)]);
    },
    _isText: text,
  });

  async function fetchImpl(href, { method = 'GET', headers = {}, body } = {}) {
    const url = new URL(href);
    // An upload of file bytes arrives as a Blob rather than a string;
    // read it back out before the multipart parser sees it.
    if (body && typeof body.text === 'function') body = await body.text();
    requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams) });

    if (failNext401 || headers.Authorization !== `Bearer ${validToken}`) {
      failNext401 = false;
      return respond(401, { error: { message: 'Invalid Credentials' } });
    }

    const path = url.pathname;
    const idMatch = path.match(/\/files\/([^/]+)(\/export)?$/);

    if (method === 'GET' && path === '/drive/v3/about') {
      return respond(200, { user: { emailAddress: 'dan@thefaredge.com', displayName: 'Dan' } });
    }

    if (method === 'GET' && path === '/drive/v3/files') {
      const space = url.searchParams.get('spaces') || 'drive';
      const q = url.searchParams.get('q');
      const list = [...files.values()].filter((f) => f.space === space && matchesQuery(f, q)).map(publicFile);
      return respond(200, { files: list });
    }

    if (idMatch) {
      const file = files.get(decodeURIComponent(idMatch[1]));
      if (!file) return respond(404, { error: { message: 'File not found' } });

      if (method === 'GET' && idMatch[2]) {
        const exported = '\uFEFF' + String(file.content || '').replace(/\n/g, '\r\n');
        return respond(200, exported, { text: true });
      }
      if (method === 'GET' && url.searchParams.get('alt') === 'media') {
        return respond(200, file.content);
      }
      if (method === 'GET') return respond(200, publicFile(file));

      if (method === 'PATCH' && path.startsWith('/upload/')) {
        const { metadata, content } = parseMultipart(body, headers['Content-Type']);
        if (metadata.name !== undefined) file.name = metadata.name;
        if (metadata.description !== undefined) file.description = metadata.description;
        if (metadata.appProperties) file.appProperties = { ...file.appProperties, ...metadata.appProperties };
        file.content = content;
        file.modifiedTime = stamp();
        return respond(200, publicFile(file));
      }
      if (method === 'PATCH') {
        const patch = JSON.parse(body);
        Object.assign(file, patch);
        file.modifiedTime = stamp();
        return respond(200, publicFile(file));
      }
    }

    if (method === 'POST' && path === '/drive/v3/files') {
      const meta = JSON.parse(body);
      const file = {
        id: newFileId(), space: 'drive', name: meta.name, mimeType: meta.mimeType,
        parents: meta.parents || ['root'], appProperties: meta.appProperties || {}, modifiedTime: stamp(),
      };
      files.set(file.id, file);
      return respond(200, publicFile(file));
    }

    if (method === 'POST' && path === '/upload/drive/v3/files') {
      const { metadata, content } = parseMultipart(body, headers['Content-Type']);
      const parents = metadata.parents || ['root'];
      if (parents.some((p) => p !== 'appDataFolder' && p !== 'root' && !files.has(p))) {
        return respond(404, { error: { message: `Parent not found: ${parents}` } });
      }
      const file = {
        id: newFileId(),
        space: parents.includes('appDataFolder') ? 'appDataFolder' : 'drive',
        name: metadata.name, mimeType: metadata.mimeType, parents,
        description: metadata.description, appProperties: metadata.appProperties || {},
        content, modifiedTime: stamp(),
      };
      files.set(file.id, file);
      return respond(200, publicFile(file));
    }

    return respond(400, { error: { message: `Fake Drive doesn't handle ${method} ${path}` } });
  }

  return {
    fetchImpl,
    files,
    requests,
    // Test controls
    auth(token = validToken) {
      return {
        getAccessToken: async () => token,
        invalidateToken: async () => {},
      };
    },
    rotateToken(next) {
      validToken = next;
    },
    reject401Once() {
      failNext401 = true;
    },
    // Simulates someone editing a Doc in Google Docs.
    editDoc(id, content, name) {
      const file = files.get(id);
      file.content = content;
      if (name) file.name = name;
      file.modifiedTime = stamp();
    },
    trashExternally(id) {
      files.get(id).trashed = true;
    },
    byName: (name) => [...files.values()].filter((f) => f.name === name),
    childrenOf: (id) => [...files.values()].filter((f) => (f.parents || []).includes(id)),
    appDataFiles: () => [...files.values()].filter((f) => f.space === 'appDataFolder'),
    mutations: (since = 0) => requests.slice(since).filter((r) => r.method !== 'GET'),
  };
}
