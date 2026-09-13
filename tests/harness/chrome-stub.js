// Stub chrome.* for running extension pages in a plain browser tab.
//
// Tabs are simulated: each has an `input` (what's currently sitting in
// its prompt box — every write REPLACES it, exactly like the real
// adapter's selectAll + insertText) and a `reply` (what a capture reads).
// Tests drive __tabs directly to simulate a chat answering.
(() => {
  const mem = { local: {}, session: {} };
  const listeners = [];

  const area = (bag, areaName) => ({
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(bag);
      const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      const out = {};
      list.forEach((k) => {
        if (k in bag) out[k] = structuredClone(bag[k]);
      });
      return out;
    },
    async set(obj) {
      const changes = {};
      Object.entries(obj).forEach(([k, v]) => {
        changes[k] = { oldValue: bag[k], newValue: structuredClone(v) };
        bag[k] = structuredClone(v);
      });
      listeners.forEach((fn) => fn(changes, areaName));
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      list.forEach((k) => {
        changes[k] = { oldValue: bag[k] };
        delete bag[k];
      });
      listeners.forEach((fn) => fn(changes, areaName));
    },
    async getKeys() {
      return Object.keys(bag);
    },
  });

  window.__mem = mem;
  window.__tabs = {
    1: { title: 'Shot writer', platform: 'chatgpt', platformLabel: 'ChatGPT', kind: 'chat', input: '', reply: 'earlier answer', writes: [] },
    2: { title: 'Sora', platform: 'sora', platformLabel: 'Sora', kind: 'generator', input: '', reply: '', writes: [] },
    3: { title: 'Gemini notes', platform: 'gemini', platformLabel: 'Gemini', kind: 'chat', input: '', reply: 'old gemini', writes: [] },
  };

  window.chrome = {
    storage: {
      local: area(mem.local, 'local'),
      session: area(mem.session, 'session'),
      onChanged: { addListener: (fn) => listeners.push(fn), removeListener() {} },
    },
    identity: {
      getRedirectURL: () => 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
      // Simulates Google's consent redirect. Tests read __authRequests to
      // see what was asked for, and can set __authResult to fail it.
      async launchWebAuthFlow({ url, interactive }) {
        window.__authRequests = window.__authRequests || [];
        window.__authRequests.push({ url, interactive });
        if (window.__authResult === 'deny') throw new Error('The user did not approve access.');
        const scopes = new URL(url).searchParams.get('scope');
        return `https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/#access_token=fake-token&expires_in=3599&token_type=Bearer&scope=${encodeURIComponent(scopes)}`;
      },
    },
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getURL: (p) => `${location.origin}/${p}`,
      getManifest: () => ({ version: '0.9.0-harness' }),
      openOptionsPage: () => { window.__optionsOpened = (window.__optionsOpened || 0) + 1; },
      async sendMessage(msg) {
        const tab = window.__tabs[msg.tabId];
        switch (msg.type) {
          case 'EDGE_STUDIO_GET_TABS':
            return Object.entries(window.__tabs).map(([id, t]) => ({
              id: Number(id), title: t.title, url: `https://example/${id}`, windowId: 1,
              platform: t.platform, platformLabel: t.platformLabel, kind: t.kind,
            }));
          case 'EDGE_STUDIO_SEND_TO_TAB':
            if (!tab) return { success: false, reason: 'no tab' };
            tab.input = msg.text; // replaces, like the real adapter
            tab.writes.push(msg.text);
            return { success: true };
          case 'EDGE_STUDIO_CAPTURE_RESPONSE':
            if (!tab || tab.kind === 'generator') return { success: false, reason: 'generator' };
            return tab.reply ? { success: true, text: tab.reply, url: 'https://example' } : { success: false, reason: 'none' };
          case 'EDGE_STUDIO_CAPTURE_SELECTION':
            return { success: false, reason: 'none' };
          case 'EDGE_STUDIO_CAPTURE_USAGE':
            return { success: false, reason: 'none' };
          case 'EDGE_STUDIO_SYNC_NOW':
            window.__syncRequests = (window.__syncRequests || 0) + 1;
            return { pushed: 0, pulled: 0, readBack: 0, trashed: 0, created: 0, errors: [] };
          default:
            return undefined;
        }
      },
    },
    tabs: { async query() { return []; }, async create() {}, async update() {} },
    windows: { async update() {}, async getCurrent() { return { id: 1 }; } },
    sidePanel: { async open(opts) { window.__sidePanelOpened = opts; } },
  };

  // Clipboard writes are recorded rather than performed.
  window.__clipboard = [];
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t) => { window.__clipboard.push(t); } },
    });
  } catch { /* some browsers lock this down; tests that need it will say so */ }
})();
