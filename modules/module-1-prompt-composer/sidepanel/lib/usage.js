// Usage & resource tracking (CORE-8 / CORE-9, M1-10 / M1.5-8).
//
// The spec's P0 asks for three things: one place showing consumption
// per connected service, a live cost estimate inline in the composer,
// and a warning state when a service is projected to cross a
// threshold (default 10% remaining, editable per service).
//
// A note on where the numbers come from. None of ChatGPT, Claude or
// Gemini publishes a usage API, and none of them reliably renders a
// quota figure in the page either — what's shown varies by plan, by
// model, and by whether you're near a limit at all. So this is built
// the way CORE-8 asks for it: manual entry is the primary path and
// always works, and "Read from tabs" is a best-effort scrape layered
// on top that says plainly when it finds nothing. That keeps the tab
// useful today rather than blocked on a scrape that may never be
// dependable.

import { state } from './state.js';
import { getUsage, saveUsage } from './storage.js';
import { openModal } from './modal.js';
import { showToast } from './ui.js';
import { tabDisplayName } from './targets.js';

const usageListEl = document.getElementById('usage-list');
const costMeterEl = document.getElementById('cost-meter');

const DEFAULT_THRESHOLD_PCT = 10;

const DEFAULT_SERVICES = [
  { id: 'chatgpt', label: 'ChatGPT', platform: 'chatgpt', unit: 'messages' },
  { id: 'claude', label: 'Claude', platform: 'claude', unit: 'messages' },
  { id: 'gemini', label: 'Gemini', platform: 'gemini', unit: 'messages' },
];

const UNITS = [
  { value: 'messages', label: 'messages' },
  { value: 'tokens', label: 'tokens' },
  { value: 'usd', label: 'USD' },
];

function seedService(seed) {
  return {
    ...seed,
    used: null,
    limit: null,
    thresholdPct: DEFAULT_THRESHOLD_PCT,
    updatedAt: null,
    source: null, // 'manual' | 'scraped'
  };
}

export async function loadUsage() {
  const stored = await getUsage();
  state.usage = stored && stored.services?.length
    ? stored
    : { services: DEFAULT_SERVICES.map(seedService) };
}

async function persistUsage() {
  await saveUsage(state.usage);
}

// ---------- Maths ----------

export function remainingPct(service) {
  if (service.limit === null || service.limit <= 0 || service.used === null) return null;
  const left = Math.max(0, service.limit - service.used);
  return Math.max(0, Math.min(100, (left / service.limit) * 100));
}

export function isWarning(service) {
  const pct = remainingPct(service);
  if (pct === null) return false;
  return pct <= (service.thresholdPct ?? DEFAULT_THRESHOLD_PCT);
}

// A rough count, and labelled as one everywhere it's shown. Roughly
// four characters per token holds well enough for English prose to be
// useful as a "is this prompt huge?" signal, which is what the spec
// asks for — it is not a billing-grade number and shouldn't be read as
// one.
export function estimateTokens(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.round(trimmed.length / 4));
}

function formatAmount(value, unit) {
  if (value === null || value === undefined) return '—';
  if (unit === 'usd') return `$${Number(value).toFixed(2)}`;
  return String(value);
}

// ---------- Usage tab ----------

function buildMeter(service) {
  const pct = remainingPct(service);
  const meter = document.createElement('div');
  meter.className = 'meter';

  const fill = document.createElement('div');
  fill.className = 'meter-fill';
  if (pct === null) {
    fill.style.width = '0%';
    meter.classList.add('unset');
  } else {
    // The bar shows what's LEFT, so it drains as the service is used.
    fill.style.width = `${pct}%`;
    if (isWarning(service)) meter.classList.add('warning');
  }
  meter.appendChild(fill);
  return meter;
}

async function editService(service) {
  const result = await openModal({
    title: `${service.label} usage`,
    hint: 'Enter what the service itself reports. Leave the limit blank if it has no fixed quota.',
    fields: [
      { name: 'label', label: 'Service name', value: service.label },
      {
        name: 'unit',
        label: 'Measured in',
        type: 'select',
        value: service.unit,
        options: UNITS,
      },
      { name: 'used', label: 'Used so far', value: service.used ?? '' },
      { name: 'limit', label: 'Limit / quota', value: service.limit ?? '' },
      {
        name: 'thresholdPct',
        label: 'Warn at % remaining',
        value: String(service.thresholdPct ?? DEFAULT_THRESHOLD_PCT),
      },
    ],
    confirmLabel: 'Save',
  });
  if (result === null) return;

  const num = (raw) => {
    const trimmed = String(raw).trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const label = result.label.trim();
  if (!label) {
    showToast('A service needs a name.', 'warning');
    return;
  }

  service.label = label;
  service.unit = result.unit;
  service.used = num(result.used);
  service.limit = num(result.limit);
  const threshold = num(result.thresholdPct);
  service.thresholdPct = threshold === null ? DEFAULT_THRESHOLD_PCT : Math.min(100, threshold);
  service.updatedAt = new Date().toISOString();
  service.source = 'manual';

  await persistUsage();
  renderUsage();
  updateCostEstimate();
  showToast(`${label} updated.`);
}

async function addService() {
  const result = await openModal({
    title: 'Add service',
    hint: 'For anything else that burns quota — an image generator, an API budget.',
    fields: [
      { name: 'label', label: 'Service name' },
      { name: 'unit', label: 'Measured in', type: 'select', value: 'messages', options: UNITS },
    ],
    confirmLabel: 'Add',
  });
  if (result === null) return;

  const label = result.label.trim();
  if (!label) {
    showToast('Give the service a name.', 'warning');
    return;
  }

  state.usage.services.push(
    seedService({
      id: `service-${Date.now()}`,
      label,
      platform: null,
      unit: result.unit,
    })
  );
  await persistUsage();
  renderUsage();
  showToast(`Added ${label}.`);
}

async function removeService(service) {
  const confirmed = await openModal({
    title: 'Remove service',
    body: `Stop tracking "${service.label}"?`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (confirmed === null) return;

  state.usage.services = state.usage.services.filter((s) => s !== service);
  await persistUsage();
  renderUsage();
  updateCostEstimate();
  showToast(`Removed ${service.label}.`);
}

export function renderUsage() {
  usageListEl.innerHTML = '';

  state.usage.services.forEach((service) => {
    const row = document.createElement('div');
    row.className = 'usage-row';
    if (isWarning(service)) row.classList.add('warning');

    const head = document.createElement('div');
    head.className = 'usage-head';

    const label = document.createElement('span');
    label.className = 'usage-label';
    label.textContent = service.label;
    head.appendChild(label);

    const pct = remainingPct(service);
    const figure = document.createElement('span');
    figure.className = 'usage-figure';
    figure.textContent =
      pct === null
        ? 'not set'
        : `${Math.round(pct)}% left · ${formatAmount(service.used, service.unit)} / ${formatAmount(
            service.limit,
            service.unit
          )} ${service.unit === 'usd' ? '' : service.unit}`.trim();
    head.appendChild(figure);

    const edit = document.createElement('span');
    edit.className = 'row-action';
    edit.textContent = '✎';
    edit.title = 'Edit usage and warning threshold';
    edit.addEventListener('click', () => editService(service));
    head.appendChild(edit);

    const del = document.createElement('span');
    del.className = 'delete-item';
    del.textContent = '✕';
    del.title = 'Stop tracking';
    del.addEventListener('click', () => removeService(service));
    head.appendChild(del);

    row.appendChild(head);
    row.appendChild(buildMeter(service));

    const foot = document.createElement('div');
    foot.className = 'usage-foot';
    const when = service.updatedAt
      ? `${service.source === 'scraped' ? 'read from tab' : 'entered'} ${new Date(
          service.updatedAt
        ).toLocaleString()}`
      : 'no reading yet';
    foot.textContent = `warn at ${service.thresholdPct ?? DEFAULT_THRESHOLD_PCT}% left · ${when}`;
    row.appendChild(foot);

    usageListEl.appendChild(row);
  });

  if (state.usage.services.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No services tracked. Add one below.';
    usageListEl.appendChild(empty);
  }
}

// ---------- M1-10 / M1.5-8: best-effort scrape ----------

async function readFromTabs() {
  if (state.detectedTabs.length === 0) {
    showToast('No chat tabs open to read from.', 'warning');
    return;
  }

  const found = [];
  const missing = [];

  for (const tab of state.detectedTabs) {
    const result = await chrome.runtime.sendMessage({
      type: 'EDGE_STUDIO_CAPTURE_USAGE',
      tabId: tab.id,
    });

    if (result && result.success) {
      const service = state.usage.services.find((s) => s.platform === tab.platform);
      if (!service) continue;

      if (result.limit !== null) service.limit = result.limit;
      if (result.used !== null) {
        service.used = result.used;
      } else if (result.remaining !== null && service.limit !== null) {
        // The page said what's left, not what's spent. That only becomes
        // a "used" figure once a limit is known — otherwise the reading
        // is kept as-is rather than guessed at.
        service.used = Math.max(0, service.limit - result.remaining);
      }

      service.updatedAt = new Date().toISOString();
      service.source = 'scraped';
      found.push(`${service.label}: ${result.raw}`);
    } else {
      missing.push(tabDisplayName(tab.id));
    }
  }

  if (found.length) {
    await persistUsage();
    renderUsage();
    updateCostEstimate();
  }

  if (found.length && !missing.length) {
    showToast(`Read usage from ${found.length} tab(s).`);
  } else if (found.length) {
    showToast(`Read ${found.length}. No figure shown in: ${missing.join(', ')}.`, 'warning');
  } else {
    // This is the expected case most of the time, so say why rather
    // than implying something broke.
    showToast(
      'No usage figures on those pages — these services only show one near a limit. Enter it by hand with ✎.',
      'warning'
    );
  }
}

// ---------- Inline cost estimate (spec §Usage P0) ----------
// Sits under the builder preview so the cost of what's about to be sent
// is visible before Insert, not after.

export function updateCostEstimate() {
  const previewEl = document.getElementById('preview');
  const text = previewEl.value.trim();

  costMeterEl.innerHTML = '';
  if (!text) {
    costMeterEl.classList.add('hidden');
    return;
  }
  costMeterEl.classList.remove('hidden');

  const tokens = document.createElement('span');
  tokens.className = 'cost-tokens';
  tokens.textContent = `~${estimateTokens(text).toLocaleString()} tokens`;
  tokens.title = 'Rough estimate (about 4 characters per token), not a billing figure';
  costMeterEl.appendChild(tokens);

  // Show a meter for each platform actually being sent to, so the
  // warning is about the service that's about to be spent.
  const platforms = [
    ...new Set(
      [...state.selectedTabIds]
        .map((id) => state.detectedTabs.find((t) => t.id === id)?.platform)
        .filter(Boolean)
    ),
  ];

  platforms.forEach((platform) => {
    const service = state.usage.services.find((s) => s.platform === platform);
    if (!service) return;
    const pct = remainingPct(service);
    if (pct === null) return;

    const chip = document.createElement('span');
    chip.className = 'cost-chip';
    if (isWarning(service)) chip.classList.add('warning');

    const name = document.createElement('span');
    name.textContent = `${service.label} ${Math.round(pct)}%`;
    chip.appendChild(name);

    const bar = document.createElement('span');
    bar.className = 'cost-bar';
    const fill = document.createElement('span');
    fill.className = 'cost-bar-fill';
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    chip.appendChild(bar);

    chip.title = isWarning(service)
      ? `${service.label} is at or below its ${service.thresholdPct}% warning threshold`
      : `${service.label}: ${Math.round(pct)}% of quota remaining`;

    costMeterEl.appendChild(chip);
  });
}

export function initUsage() {
  document.getElementById('usage-read-btn').addEventListener('click', readFromTabs);
  document.getElementById('usage-add-btn').addEventListener('click', addService);
}
