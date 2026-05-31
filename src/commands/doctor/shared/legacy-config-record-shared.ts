type JsonRecord = Record<string, unknown>;

import { isRecord } from "../../../utils.js";

export type { JsonRecord };
export { isRecord };

export function cloneRecord<T extends JsonRecord>(value: T | undefined): T {
  return { ...value } as T;
}

export function ensureRecord(target: JsonRecord, key: string): JsonRecord {
  const current = target[key];
  if (isRecord(current)) {
    return current;
  }
  const next: JsonRecord = {};
  target[key] = next;
  return next;
}

export function hasOwnKey(target: JsonRecord, key: string): boolean {
  return Object.hasOwn(target, key);
}
