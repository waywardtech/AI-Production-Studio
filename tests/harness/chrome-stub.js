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
    runtime: {
      getURL: (p) => `${location.origin}/${p}`,
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
          default:
            return undefined;
        }
      },
    },
    tabs: { async query() { return []; }, async create() {}, async update() {} },
    windows: { async update() {} },
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
