// How Edge Studio records read as Google Docs, and how an edited Doc is
// read back. Pure — no DOM, no chrome, no network — so round trips can
// be tested exactly.
//
// The rule for every format: a Doc should read naturally to a person
// opening it in Google Docs, and whatever that person is likely to edit
// must come back intact. So the text that matters sits in plain,
// clearly-marked sections, and the metadata that's managed in Edge
// Studio (status, tags, where a reply came from) sits in a short header
// that's ignored on the way back in.

export const RULE = '────────────────────────────────';

const BLOCK_HEADING = /^\s*\[([^\]\n]{1,60})\]\s*$/;

export function normalizeText(text) {
  return String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function metaLine(record) {
  const bits = [`Status: ${record.status || 'Draft'}`];
  if (record.tags && record.tags.length) bits.push(`Tags: ${record.tags.join(', ')}`);
  return bits.join(' · ');
}

// Drive's `description` is searchable in Drive, so tags and status put
// there make "apex" findable from Drive's own search box.
function describe(kind, record, extra = []) {
  return [`Edge Studio ${kind}`, metaLine(record), ...extra].filter(Boolean).join(' · ');
}

// The body of a Doc: everything between the first rule and the footer
// rule, if there is one.
function bodyOf(text) {
  const lines = normalizeText(text).split('\n');
  const first = lines.findIndex((l) => l.trim() === RULE);
  if (first === -1) return lines.join('\n');
  let last = -1;
  for (let i = lines.length - 1; i > first; i -= 1) {
    if (lines[i].trim() === RULE) {
      last = i;
      break;
    }
  }
  return lines.slice(first + 1, last === -1 ? undefined : last).join('\n');
}

// ---------- prompts ----------

export function promptToDoc(prompt, blockTypes = []) {
  const labelOf = (type) => blockTypes.find((t) => t.id === type)?.label || type;
  const blocks = (prompt.blocks || [])
    .map((b) => `[${labelOf(b.type)}]\n${(b.text || '').trim()}`)
    .join('\n\n');

  return {
    name: prompt.title,
    description: describe('prompt', prompt),
    text: [
      prompt.title,
      metaLine(prompt),
      RULE,
      '',
      blocks || '[Scenario]\n',
      '',
      RULE,
      'Edit the text under each [Heading] and Edge Studio picks it up on its next sync. Keep the headings in square brackets; add a new [Heading] to add a block.',
    ].join('\n'),
  };
}

// Returns the prompt's blocks as read from an edited Doc, or null when
// the Doc no longer has any [Heading] to hang blocks on — in which case
// the existing blocks are kept rather than collapsed into one.
export function docToPromptBlocks(text, prompt, blockTypes = []) {
  const lines = bodyOf(text).split('\n');
  const sections = [];
  let current = null;

  lines.forEach((line) => {
    const heading = line.match(BLOCK_HEADING);
    if (heading) {
      current = { label: heading[1].trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  });

  if (sections.length === 0) return null;

  const typeFor = (label) => {
    const key = label.toLowerCase();
    const known = blockTypes.find((t) => t.label.toLowerCase() === key || t.id === key);
    if (known) return known.id;
    // A heading typed in Docs that isn't a block type yet keeps its own
    // name as the type, which the builder shows as-is.
    return key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';
  };

  const previous = prompt.blocks || [];
  return sections.map((section, index) => {
    const type = typeFor(section.label);
    const text = section.lines.join('\n').trim();
    // Keep a block's id when it's still the same type in the same place,
    // so a reordering in the builder isn't mistaken for a whole new block.
    const same = previous[index] && previous[index].type === type ? previous[index] : null;
    return {
      id: same ? same.id : `${type}-${index}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      text,
    };
  });
}

// ---------- replies ----------

export function replyToDoc(reply) {
  const source = reply.source || {};
  const from = [source.platform, source.tabLabel].filter(Boolean).join(' — ');
  const captured = reply.capturedAt ? new Date(reply.capturedAt).toISOString().slice(0, 16).replace('T', ' ') : '';

  return {
    name: reply.title,
    description: describe('reply', reply, [from && `From ${from}`]),
    text: [
      reply.title,
      from ? `From: ${from}` : '',
      source.url ? `Source: ${source.url}` : '',
      [captured && `Captured: ${captured} UTC`, metaLine(reply)].filter(Boolean).join(' · '),
      RULE,
      '',
      reply.text || '',
    ]
      .filter((line, i) => i >= 4 || line !== '')
      .join('\n'),
  };
}

export function docToReplyText(text) {
  return bodyOf(text).trim();
}

// ---------- documents (in-box scripts and notes, out-box reports) ----------

// A script or a report is the document: no header, so it reads and
// prints like the thing it is. Its kind and status live in the Drive
// description instead.
export function documentToDoc(doc) {
  return {
    name: doc.title,
    description: describe(doc.kind === 'report' ? 'report' : doc.box === 'outbox' ? 'out-box document' : 'in-box document', doc),
    text: doc.text || '',
  };
}

export function docToDocumentText(text) {
  return normalizeText(text).trim();
}

// ---------- productions (generated, one way) ----------

// The shot list is written from the studio and never read back — scenes
// have structure a Doc can't carry faithfully. The Doc says so.
export function productionToDoc(production, { assembleShot, targetLabel, profileLabel }) {
  const shots = (production.scenes || []).map((scene, i) => {
    const number = String(i + 1).padStart(2, '0');
    const body = assembleShot(scene) || '(nothing written yet)';
    return `${number} · ${scene.name}\n\n${body}`;
  });

  const sequences = (production.sequences || []).map((sequence) => {
    const names = sequence.sceneIds
      .map((id) => production.scenes.find((s) => s.id === id)?.name)
      .filter(Boolean);
    return `${sequence.name}: ${names.join(' → ') || '(empty)'}`;
  });

  return {
    name: `${production.name} — shot list`,
    description: describe('shot list', production, [targetLabel, profileLabel]),
    text: [
      `${production.name} — shot list`,
      [`Generator: ${targetLabel}`, `Profile: ${profileLabel}`, metaLine(production)].join(' · '),
      RULE,
      '',
      ...(sequences.length ? ['Sequences', ...sequences, ''] : []),
      shots.join(`\n\n${'·'.repeat(12)}\n\n`) || 'No scenes yet.',
      '',
      RULE,
      'Generated by Edge Studio from the studio. Edits made here are not read back — change the scenes in the studio and this list is rewritten.',
    ].join('\n'),
  };
}
