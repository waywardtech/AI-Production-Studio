// Model adapters — the only code that would talk to a media model.
//
// Each adapter declares what it can do (resolution tiers, whether it
// honours a seed, how long a prompt it takes, which prompt dialect it
// wants) and implements generate(recipe, { signal }). Everything above
// this file reasons from those declarations, never from a model's name.
//
// The adapters here are mocks, and deliberately faithful ones: output is
// an SVG whose composition is derived from the recipe's seed, prompt and
// references. A model that locks its seed draws the same composition at
// any resolution; one that doesn't lets resolution leak in. That makes
// "did promoting to master preserve the shot" a property a test can
// check, instead of something to eyeball.
//
// Swapping in a real model means implementing generate() and filling in
// the same declaration. Nothing else changes.

import { hashOf } from './ids.mjs';

export const MODELS = [
  {
    id: 'sketch-v1', kind: 'image', label: 'Sketch v1 (storyboard frames)',
    tiers: { proxy: { w: 512, h: 288 }, master: { w: 2048, h: 1152 } },
    seedLock: true, promptStyle: 'tags', maxPromptTokens: 90, supportsNegative: true,
    fallback: 'sketch-lite',
  },
  {
    id: 'sketch-lite', kind: 'image', label: 'Sketch Lite (fallback)',
    tiers: { proxy: { w: 512, h: 288 }, master: { w: 1024, h: 576 } },
    seedLock: true, promptStyle: 'tags', maxPromptTokens: 60, supportsNegative: false,
    fallback: null,
  },
  {
    id: 'motion-v2', kind: 'video', label: 'Motion v2 (video shots)',
    tiers: { proxy: { w: 854, h: 480 }, master: { w: 3840, h: 2160 } },
    seedLock: true, promptStyle: 'prose', maxPromptTokens: 160, supportsNegative: true,
    fallback: 'motion-lite',
  },
  {
    // No seed lock: the same seed at a different resolution is a
    // different clip. Promotion has to be guided by the proxy's frames.
    id: 'motion-lite', kind: 'video', label: 'Motion Lite (fallback, no seed lock)',
    tiers: { proxy: { w: 854, h: 480 }, master: { w: 1920, h: 1080 } },
    seedLock: false, supportsInitFrame: true, promptStyle: 'prose', maxPromptTokens: 100, supportsNegative: false,
    fallback: null,
  },
  { id: 'voice-v1', kind: 'voice', label: 'Voice v1', tiers: { proxy: { w: 0, h: 0 }, master: { w: 0, h: 0 } },
    seedLock: true, promptStyle: 'prose', maxPromptTokens: 200, supportsNegative: false, fallback: null },
  { id: 'lipsync-v1', kind: 'lipsync', label: 'Lip-sync v1', tiers: { proxy: { w: 854, h: 480 }, master: { w: 1920, h: 1080 } },
    seedLock: true, promptStyle: 'prose', maxPromptTokens: 60, supportsNegative: false, fallback: null },

  // ---- Hand-off generators: your chat subscriptions, used by hand ----
  //
  // No API and no per-render charge. The studio writes the prompt and
  // the list of attachments; you send it and import what comes back
  // (src/handoff.mjs). None of these honours a seed, so a master is
  // always guided by its proxy. The tier sizes are what gets asked for;
  // the platform decides what it actually returns.
  {
    id: 'chatgpt-image', kind: 'image', mode: 'handoff', provider: 'chatgpt', cost: 'subscription',
    label: 'ChatGPT (stills, by hand)', url: 'https://chatgpt.com/',
    tiers: { proxy: { w: 1024, h: 576 }, master: { w: 2048, h: 1152 } },
    seedLock: false, supportsInitFrame: true, promptStyle: 'prose', maxPromptTokens: 400, supportsNegative: false, fallback: null,
  },
  {
    id: 'gemini-image', kind: 'image', mode: 'handoff', provider: 'gemini', cost: 'subscription',
    label: 'Gemini (stills, by hand)', url: 'https://gemini.google.com/app',
    tiers: { proxy: { w: 1024, h: 576 }, master: { w: 2048, h: 1152 } },
    seedLock: false, supportsInitFrame: true, promptStyle: 'prose', maxPromptTokens: 400, supportsNegative: false, fallback: null,
  },
  {
    id: 'chatgpt-video', kind: 'video', mode: 'handoff', provider: 'chatgpt', cost: 'subscription',
    label: 'Sora (video, by hand)', url: 'https://sora.chatgpt.com/',
    tiers: { proxy: { w: 854, h: 480 }, master: { w: 1920, h: 1080 } },
    seedLock: false, supportsInitFrame: true, promptStyle: 'prose', maxPromptTokens: 400, supportsNegative: false, fallback: null,
  },
  {
    id: 'gemini-video', kind: 'video', mode: 'handoff', provider: 'gemini', cost: 'subscription',
    label: 'Gemini / Flow (video, by hand)', url: 'https://labs.google/fx/tools/flow',
    tiers: { proxy: { w: 854, h: 480 }, master: { w: 1920, h: 1080 } },
    seedLock: false, supportsInitFrame: true, promptStyle: 'prose', maxPromptTokens: 400, supportsNegative: false, fallback: null,
  },
];

export const modelById = (id) => MODELS.find((model) => model.id === id) || null;
export const defaultModelFor = (kind) => MODELS.find((model) => model.kind === kind);

// ---------- errors ----------
//
// What went wrong decides what can be done about it, so every failure is
// sorted into a class before the queue or the UI sees it.

export class ModelError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind; // 'transient' | 'timeout' | 'content_filter' | 'malformed_prompt'
  }
}

export function classifyError(error) {
  const kind = error?.kind || (error?.name === 'AbortError' || error?.code === 'stalled' ? 'timeout' : 'unknown');
  const table = {
    transient: { retryable: true, action: 'retry', advice: 'The model service hiccupped. Retrying usually works.' },
    timeout: { retryable: true, action: 'retry', advice: 'The model took too long. Retry, or use the fallback model.' },
    content_filter: { retryable: false, action: 'edit', advice: 'The model refused this prompt. Edit the shot or its locked clauses — retrying the same recipe will be refused again.' },
    malformed_prompt: { retryable: false, action: 'recompile', advice: 'The model could not read this prompt. Recompile it, or switch model.' },
    unknown: { retryable: false, action: 'inspect', advice: 'An unexpected error. Nothing was retried automatically.' },
  };
  return { class: kind, message: error?.message || String(error), ...(table[kind] || table.unknown) };
}

// ---------- the mock renderer ----------

function rng(seedText) {
  let state = parseInt(hashOf(seedText).slice(0, 8), 16) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0xffffffff;
  };
}

// What the "model" draws. With a seed lock the composition depends on
// the seed, the prompt and the references — never on resolution.
export function compositionKey(recipe, model) {
  const parts = [recipe.seed, recipe.compiledPrompt, recipe.negativePrompt, recipe.referenceHashes];
  // A model with no seed lock lays the shot out differently at every
  // resolution — unless it is handed the proxy's frames to follow, in
  // which case it reproduces the layout it drew at proxy size.
  if (!model.seedLock) parts.push(recipe.upscaleGuidance ? model.tiers.proxy : recipe.resolution);
  return hashOf(parts);
}

function renderSvg(recipe, model) {
  const { w, h } = recipe.resolution.w ? recipe.resolution : { w: 640, h: 120 };
  const rand = rng(compositionKey(recipe, model));
  const hue = Math.floor(rand() * 360);
  const shapes = Array.from({ length: 5 }, () => {
    const cx = (rand() * 100).toFixed(1), cy = (20 + rand() * 60).toFixed(1), r = (6 + rand() * 16).toFixed(1);
    return `<circle cx="${cx}%" cy="${cy}%" r="${r}%" fill="hsl(${Math.floor(hue + rand() * 80)} 55% ${30 + Math.floor(rand() * 35)}%)" opacity="0.85"/>`;
  }).join('');
  const horizon = (45 + rand() * 25).toFixed(1);
  // Fine grain exists only at master resolution: the visible difference
  // between tiers is detail, never layout.
  const grain = recipe.resolutionTier === 'master'
    ? `<g stroke="rgba(255,255,255,0.25)" stroke-width="0.15%">${Array.from({ length: 24 }, (_, i) => `<line x1="${i * 4.3}%" y1="${horizon}%" x2="${i * 4.3 + 2}%" y2="100%"/>`).join('')}</g>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" data-composition="${compositionKey(recipe, model)}">`
    + `<rect width="100%" height="100%" fill="hsl(${hue} 30% 14%)"/>`
    + `<rect y="${horizon}%" width="100%" height="100%" fill="hsl(${(hue + 40) % 360} 28% 22%)"/>`
    + shapes + grain
    + `<text x="2%" y="94%" font-family="monospace" font-size="${Math.max(10, h / 24)}" fill="#fff" opacity="0.8">${recipe.resolutionTier.toUpperCase()} ${w}×${h} · seed ${recipe.seed} · ${model.id}</text>`
    + '</svg>';
}

// `faults(recipe, attempt)` may throw or delay — tests use it to
// simulate slow and failing models. `latencyMs` paces the demo server.
export function createAdapters({ faults = null, latencyMs = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const attempts = new Map();
  return {
    calls: attempts,
    async generate(recipe, { signal } = {}) {
      const model = modelById(recipe.modelId);
      if (!model) throw new ModelError('malformed_prompt', `Unknown model "${recipe.modelId}"`);
      // A hand-off generator is a person with a subscription. If one ever
      // reaches this point it is a bug upstream, and drawing a mock in
      // its place would pass off a placeholder as their work.
      if (model.mode === 'handoff') throw new ModelError('malformed_prompt', `${model.label} is done by hand and cannot be called.`);
      const attempt = (attempts.get(recipe.id) || 0) + 1;
      attempts.set(recipe.id, attempt);

      if (faults) await faults(recipe, attempt, { signal });
      if (latencyMs) await sleep(latencyMs);
      if (signal?.aborted) throw signal.reason ?? new ModelError('timeout', 'Aborted');

      if (/\bFILTERME\b/.test(recipe.compiledPrompt)) throw new ModelError('content_filter', 'The prompt was refused by the content filter.');
      const content = renderSvg(recipe, model);
      return { mime: 'image/svg+xml', content, composition: compositionKey(recipe, model) };
    },
  };
}
