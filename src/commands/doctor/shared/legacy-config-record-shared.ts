// Shared record helpers for legacy config migration modules.
type JsonRecord = Record<string, unknown>;

import { isRecord } from "../../../utils.js";

export type { JsonRecord };
export { isRecord };

/** Clone a record-like config section, treating undefined as an empty object. */
export function cloneRecord<T extends JsonRecord>(value: T | undefined): T {
  return { ...value } as T;
}

/** Ensure a nested config value is a mutable record and return it. */
export function ensureRecord(target: JsonRecord, key: string): JsonRecord {
  const current = target[key];
  if (isRecord(current)) {
    return current;
  }
  const next: JsonRecord = {};
  target[key] = next;
  return next;
}

/** Own-property guard used by migrations that must preserve falsy values. */
export function hasOwnKey(target: JsonRecord, key: string): boolean {
  return Object.hasOwn(target, key);
}
