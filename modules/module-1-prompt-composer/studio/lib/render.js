// A tiny registry so the columns can ask each other to redraw without
// importing each other.
//
// The side panel wires its modules together in its entry file for the
// same reason; here there are enough cross-column effects — ticking an
// asset changes the assembled prompt, expanding a scene changes all
// three columns — that a named registry beats passing callbacks down
// through every module.

const renderers = new Map();

export function registerRenderer(name, fn) {
  renderers.set(name, fn);
}

export function render(...names) {
  names.forEach((name) => {
    const fn = renderers.get(name);
    if (fn) fn();
    else console.warn(`[Edge Studio] No renderer registered for "${name}".`);
  });
}

export function renderAll() {
  renderers.forEach((fn) => fn());
}
