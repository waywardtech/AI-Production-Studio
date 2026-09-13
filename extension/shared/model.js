// The vocabulary every page shares: projects, and the records that live
// inside one. Pure — no DOM, no chrome — so it can be tested directly.
//
// A project is the top-level organising unit (spec decision #1): a
// client, a show, a campaign. Prompts, replies, productions, assets and
// documents all belong to exactly one project, and tags cut across them.
// In Google Drive, a project is a folder.

import { newId, nowISO } from './store.js';

export const STATUSES = ['Draft', 'In Review', 'Approved', 'Archived'];

// Tags are stored lowercase so "Apex", "apex" and "APEX" are one group.
export function parseTags(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
}

export function newProject(name = 'Untitled project') {
  const now = nowISO();
  return {
    id: newId('prj'),
    name: String(name).trim() || 'Untitled project',
    status: 'Draft',
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function newPrompt({ projectId, title, blocks = [], tags = [], status = 'Draft' }) {
  return {
    id: newId('prompt'),
    projectId,
    title: String(title || '').trim() || 'Untitled prompt',
    blocks: structuredClone(blocks),
    tags: parseTags(tags),
    status,
  };
}

export function newReply({ projectId, title, text, source, tags = [], status = 'Draft', capturedAt = null }) {
  return {
    id: newId('reply'),
    projectId,
    title: String(title || '').trim() || 'Untitled reply',
    text: String(text || ''),
    // Per the "links, not copies" rule the reply points back at where it
    // came from rather than pretending to be the original.
    source: { platform: null, tabLabel: null, url: null, kind: null, ...(source || {}) },
    tags: parseTags(tags),
    status,
    capturedAt: capturedAt || nowISO(),
  };
}

// A document is any free-standing text a production keeps: a script or
// notes waiting in the in-box, a dailies report filed in the out-box.
export const DOCUMENT_BOXES = ['inbox', 'outbox'];
export const DOCUMENT_KINDS = ['script', 'note', 'report'];

export function newDocument({ projectId, productionId = null, box = 'inbox', kind = 'note', title, text }) {
  return {
    id: newId('doc'),
    projectId,
    productionId,
    box: DOCUMENT_BOXES.includes(box) ? box : 'inbox',
    kind: DOCUMENT_KINDS.includes(kind) ? kind : 'note',
    title: String(title || '').trim() || 'Untitled document',
    text: String(text || ''),
  };
}

export const RECORD_LABELS = {
  projects: 'project',
  prompts: 'prompt',
  replies: 'reply',
  productions: 'production',
  assets: 'asset',
  documents: 'document',
};
