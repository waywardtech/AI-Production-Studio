// Identity and content hashing.
//
// Two kinds of id. Things a person creates (a shot, a character) get a
// random id. Things that are *defined by their content* (a recipe, a
// rendered output) get an id derived from that content, so the same
// recipe is the same recipe wherever and whenever it is built — which is
// what makes a job safe to run twice.

import { createHash, randomUUID } from 'node:crypto';

export const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

// JSON with keys in a fixed order, so two objects with the same content
// always produce the same text regardless of how they were assembled.
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

export function hashOf(value) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
