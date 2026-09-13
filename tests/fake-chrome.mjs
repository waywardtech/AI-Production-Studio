// An in-memory chrome.storage for Node tests, faithful where it matters:
// values are deep-copied in and out (so tests catch code that relies on
// storage handing back the same object), and onChanged fires to every
// listener with old and new values, the way it does across real pages.

export function installFakeChrome() {
  const areas = {};
  const listeners = [];

  const makeArea = (name) => {
    const bag = new Map();
    areas[name] = bag;
    const emit = (changes) => listeners.forEach((fn) => fn(changes, name));
    return {
      async get(keys) {
        const out = {};
        if (keys === null || keys === undefined) {
          bag.forEach((v, k) => { out[k] = structuredClone(v); });
          return out;
        }
        const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
        list.forEach((k) => { if (bag.has(k)) out[k] = structuredClone(bag.get(k)); });
        return out;
      },
      async set(items) {
        const changes = {};
        Object.entries(items).forEach(([k, v]) => {
          changes[k] = { oldValue: bag.has(k) ? structuredClone(bag.get(k)) : undefined, newValue: structuredClone(v) };
          bag.set(k, structuredClone(v));
        });
        emit(changes);
      },
      async remove(keys) {
        const changes = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
          if (bag.has(k)) {
            changes[k] = { oldValue: structuredClone(bag.get(k)), newValue: undefined };
            bag.delete(k);
          }
        });
        if (Object.keys(changes).length) emit(changes);
      },
      async getKeys() {
        return [...bag.keys()];
      },
    };
  };

  globalThis.chrome = {
    storage: {
      local: makeArea('local'),
      session: makeArea('session'),
      onChanged: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
  };

  return { areas, listeners, raw: (name = 'local') => Object.fromEntries(areas[name]) };
}

export function makeChecker() {
  let pass = 0;
  let fail = 0;
  const eq = (got, want, label) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  };
  const done = () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  };
  return { eq, done };
}
