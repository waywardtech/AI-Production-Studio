// Turning a page check into something readable (M5-5).
//
// Pure — takes the content script's report and returns lines. It's here
// rather than in the panel so it can be tested without a browser, and
// because the text is meant to be copied out and kept: a record of which
// selector worked on which site, on which day, is the only real answer
// to "have these been verified".

const TICK = '✓';
const CROSS = '✗';
const DASH = '—';

function selectorLine(entries) {
  return entries
    .map((entry) => `${entry.selector} (${entry.count}${entry.usable !== undefined && entry.usable !== entry.count ? `, ${entry.usable} usable` : ''})`)
    .join(' · ');
}

function describeFileInput(entry) {
  if (!entry || !entry.first) return null;
  const bits = [entry.selector];
  if (entry.first.accept) bits.push(`accept="${entry.first.accept}"`);
  if (entry.first.multiple) bits.push('multiple');
  if (entry.usable !== entry.count) bits.push(`${entry.count - entry.usable} disabled`);
  return bits.join(', ');
}

// How Attach would go, in the words the toast would use afterwards.
export function attachSummary(report) {
  if (report.attachPlan === 'file-input') {
    return `${TICK} file input — ${describeFileInput(report.fileInput)}`;
  }
  if (report.attachPlan === 'paste') {
    return `${TICK} no file input; would paste onto the composer (may not be accepted)`;
  }
  return `${CROSS} nowhere to put a file — Attach would fail and say so`;
}

export function insertSummary(report) {
  if (!report.input) return `${CROSS} no input found — Insert would fall back to the clipboard`;
  return `${TICK} ${report.input.selector || 'found'} (${report.input.kind})`;
}

export function captureSummary(report) {
  if (report.platform.kind === 'generator') return `${DASH} generator page — nothing to capture`;
  const hit = report.assistantTried.find((entry) => entry.count > 0);
  if (hit) return `${TICK} ${hit.selector} — ${hit.count} found`;
  if (report.assistantFallback) return `${TICK} via the turn fallback — ${report.assistantFallback} found`;
  return `${CROSS} no replies matched — capture would report nothing found`;
}

export function usageSummary(report) {
  return report.usage.found ? `${TICK} "${report.usage.raw}"` : `${DASH} no figure shown right now`;
}

// True when everything this page is meant to support actually resolved,
// which is what "verified" means for M5-5.
export function probeIsClean(report) {
  if (!report.success) return false;
  const insertOk = !!report.input;
  const attachOk = report.attachPlan === 'file-input';
  const captureOk = report.platform.kind === 'generator' || report.assistantFound;
  return insertOk && attachOk && captureOk;
}

export function formatProbe(report, { tabLabel = null } = {}) {
  if (!report || !report.success) {
    return [`Page check — ${tabLabel || 'tab'}`, report?.url || '', '', report?.reason || 'No answer from the page.'].join('\n');
  }

  const lines = [
    `Page check — ${report.platform.label}${tabLabel && tabLabel !== report.platform.label ? ` (${tabLabel})` : ''}`,
    report.url,
    report.at,
    '',
    `Insert    ${insertSummary(report)}`,
    `Attach    ${attachSummary(report)}`,
    `Capture   ${captureSummary(report)}`,
    `Usage     ${usageSummary(report)}`,
    '',
    'Selectors tried',
    `  input       ${selectorLine(report.inputTried)}`,
    `  file input  ${selectorLine(report.fileTried)}`,
  ];

  if (report.assistantTried.length) {
    lines.push(`  assistant   ${selectorLine(report.assistantTried)}`);
  }
  if (report.assistantFallback !== null) {
    lines.push(`  turn fallback  ${report.assistantFallback}`);
  }

  return lines.join('\n');
}

export function formatProbes(reports) {
  return reports.map(({ report, tabLabel }) => formatProbe(report, { tabLabel })).join('\n\n---\n\n');
}
