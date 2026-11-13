// The metadata store.
//
// Collections of records keyed by id, kept in memory and written to one
// JSON file. Two rules matter more than the storage medium:
//
//   - Some collections are immutable. A recipe, a take, a Story Bible
//     version: once written they are never changed, only superseded.
//     insert() refuses to overwrite, so "edit" can't quietly destroy
//     lineage — it has to create something new.
//   - Reads hand back copies. Nothing outside the store holds a live
//     reference it could mutate by accident.
//
// The file is written to a temporary name and renamed into place, so a
// crash mid-write leaves the previous file intact rather than half of a
// new one.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const IMMUTABLE = new Set(['recipes', 'takes', 'bibleVersions', 'blobs']);
const COLLECTIONS = ['project', 'bible', 'bibleVersions', 'scenes', 'shots', 'recipes', 'takes', 'blobs', 'jobs', 'batches'];

export function createStore({ file = null } = {}) {
  const data = Object.fromEntries(COLLECTIONS.map((name) => [name, new Map()]));

  if (file && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    COLLECTIONS.forEach((name) => (saved[name] || []).forEach((record) => data[name].set(record.id, record)));
  }

  function persist() {
    if (!file) return;
    const out = Object.fromEntries(COLLECTIONS.map((name) => [name, [...data[name].values()]]));
    writeFileSync(`${file}.tmp`, JSON.stringify(out));
    renameSync(`${file}.tmp`, file);
  }

  const table = (name) => {
    if (!data[name]) throw new Error(`Unknown collection "${name}"`);
    return data[name];
  };

  return {
    get(name, id) {
      const record = table(name).get(id);
      return record ? structuredClone(record) : null;
    },
    has: (name, id) => table(name).has(id),
    list(name, predicate = () => true) {
      return [...table(name).values()].filter(predicate).map((record) => structuredClone(record));
    },
    // Create only. For immutable collections this is the only way in.
    // Returns false, changing nothing, if the id is already taken.
    insert(name, record) {
      if (!record?.id) throw new Error(`A ${name} record needs an id`);
      if (table(name).has(record.id)) return false;
      table(name).set(record.id, structuredClone(record));
      persist();
      return true;
    },
    // Create or replace — mutable collections only.
    put(name, record) {
      if (IMMUTABLE.has(name)) throw new Error(`${name} is immutable: insert a new record instead of changing one`);
      if (!record?.id) throw new Error(`A ${name} record needs an id`);
      table(name).set(record.id, structuredClone(record));
      persist();
      return record;
    },
    remove(name, id) {
      if (IMMUTABLE.has(name)) throw new Error(`${name} is immutable: records are never removed`);
      table(name).delete(id);
      persist();
    },
  };
}
