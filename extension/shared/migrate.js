// Moves data saved by earlier builds into the record store.
//
// Before: one key per list — `library` (prompts), `responses`, and
// `productions`, with each production carrying its own assets, in-box
// and out-box — plus loose settings keys. Nothing belonged to a project.
//
// After: one key per record, everything inside a project. Existing work
// lands in "My first project"; assets move up from each production to
// the project, since a character or location is worth sharing across
// every production in it.
//
// Safe to run from every page and from the background worker, in any
// order, any number of times:
//   - record ids are kept, so a second run writes the same keys;
//   - a record that already exists in the new layout is never overwritten,
//     so a page that migrated first and has since been edited wins;
//   - the old keys are copied to es:backup:v1 before they're removed.

import { getSetting, nowISO, recordKey, updateSetting } from './store.js';
import { FIRST_PROJECT_ID } from './projects.js';

export const SCHEMA_VERSION = 2;

const LEGACY_KEYS = [
  'library',
  'responses',
  'blockTypes',
  'variableValues',
  'usage',
  'productions',
  'activeProductionId',
];

const BACKUP_KEY = 'es:backup:v1';

function stamp(record, created, updated = created) {
  const now = nowISO();
  record.createdAt = record.createdAt || created || now;
  record.updatedAt = record.updatedAt || updated || record.createdAt;
  return record;
}

// Pure: legacy values in, new-layout writes out. Exported for tests.
export function planMigration(legacy, { projectId = FIRST_PROJECT_ID, now = nowISO() } = {}) {
  const records = {};
  const add = (collection, record) => {
    records[recordKey(collection, record.id)] = record;
  };

  const hasAnything =
    (legacy.library || []).length ||
    (legacy.responses || []).length ||
    (legacy.productions || []).length;

  if (hasAnything) {
    add('projects', {
      id: projectId,
      name: 'My first project',
      status: 'Draft',
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  (legacy.library || []).forEach((item) => {
    add(
      'prompts',
      stamp(
        {
          id: item.id,
          projectId,
          title: item.title || 'Untitled prompt',
          blocks: item.blocks || [],
          tags: item.tags || [],
          status: item.status || 'Draft',
          createdAt: item.createdAt,
        },
        item.createdAt
      )
    );
  });

  (legacy.responses || []).forEach((item) => {
    add(
      'replies',
      stamp(
        {
          id: item.id,
          projectId,
          title: item.title || 'Untitled reply',
          text: item.text || '',
          source: item.source || {},
          tags: item.tags || [],
          status: item.status || 'Draft',
          capturedAt: item.capturedAt || item.savedAt || now,
        },
        item.savedAt || item.capturedAt
      )
    );
  });

  (legacy.productions || []).forEach((production) => {
    (production.assets || []).forEach((asset) => {
      const { addedAt, ...rest } = asset;
      add('assets', stamp({ ...rest, projectId }, addedAt));
    });

    (production.inbox || []).forEach((item) => {
      add(
        'documents',
        stamp(
          {
            id: item.id,
            projectId,
            productionId: production.id,
            box: 'inbox',
            kind: item.kind === 'script' ? 'script' : 'note',
            title: item.name || 'Untitled document',
            text: item.text || '',
          },
          item.at
        )
      );
    });

    // Out-box: only filed reports carry over. The { kind: 'clip' }
    // entries were never shown — renders are listed off their scenes.
    (production.outbox || [])
      .filter((item) => item.kind === 'report')
      .forEach((item) => {
        add(
          'documents',
          stamp(
            {
              id: item.id,
              projectId,
              productionId: production.id,
              box: 'outbox',
              kind: 'report',
              title: item.title || 'Dailies report',
              text: item.body || '',
            },
            item.at
          )
        );
      });

    const { assets, inbox, outbox, ...rest } = production;
    add('productions', stamp({ ...rest, projectId }, production.createdAt, production.updatedAt));
  });

  const settings = {
    app: {
      schemaVersion: SCHEMA_VERSION,
      ...(hasAnything ? { activeProjectId: projectId } : {}),
      ...(legacy.activeProductionId ? { activeProductionId: legacy.activeProductionId } : {}),
      ...(legacy.blockTypes && legacy.blockTypes.length ? { blockTypes: legacy.blockTypes } : {}),
    },
    usage: legacy.usage || null,
    variables: legacy.variableValues ? { values: legacy.variableValues } : null,
  };

  return { records, settings };
}

let running = null;

export function migrate() {
  // One run per context at a time; concurrent callers share it.
  if (!running) running = runMigration().finally(() => { running = null; });
  return running;
}

async function runMigration() {
  const app = (await getSetting('app', {})) || {};
  if ((app.schemaVersion || 0) >= SCHEMA_VERSION) return { migrated: false };

  const legacy = await chrome.storage.local.get(LEGACY_KEYS);
  const found = LEGACY_KEYS.filter((k) => legacy[k] !== undefined);

  if (found.length === 0) {
    await updateSetting('app', { schemaVersion: SCHEMA_VERSION });
    return { migrated: false };
  }

  // Keep a copy of exactly what was there. Never overwrite an existing
  // backup: a second run after the first removed the old keys would
  // otherwise replace the real backup with an empty one.
  const { [BACKUP_KEY]: existingBackup } = await chrome.storage.local.get(BACKUP_KEY);
  if (!existingBackup) {
    await chrome.storage.local.set({ [BACKUP_KEY]: { at: nowISO(), data: legacy } });
  }

  const { records, settings } = planMigration(legacy);

  const already = await chrome.storage.local.get(Object.keys(records));
  const writes = {};
  Object.entries(records).forEach(([key, record]) => {
    if (!already[key]) writes[key] = record;
  });
  if (Object.keys(writes).length) await chrome.storage.local.set(writes);

  if (settings.usage && !(await getSetting('usage'))) {
    await chrome.storage.local.set({ 'es:settings:usage': settings.usage });
  }
  if (settings.variables && !(await getSetting('variables'))) {
    await chrome.storage.local.set({ 'es:settings:variables': settings.variables });
  }
  await updateSetting('app', (current) => ({
    ...settings.app,
    // Anything a page already chose since the migration started wins.
    ...Object.fromEntries(Object.entries(current).filter(([k]) => k !== 'schemaVersion')),
    schemaVersion: SCHEMA_VERSION,
  }));

  await chrome.storage.local.remove(found);
  return { migrated: true, records: Object.keys(writes).length, from: found };
}
