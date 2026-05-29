import { isRecord as isPlainObject } from "openclaw/plugin-sdk/string-coerce-runtime";

const QA_MERGE_PATCH_BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isQaMergePatchObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

function isObjectWithStringId(value: unknown): value is { id: string } & Record<string, unknown> {
  return isQaMergePatchObject(value) && typeof value.id === "string" && value.id.length > 0;
}

function mergeObjectArraysById(target: unknown[], patch: unknown[]): unknown[] | undefined {
  if (!target.every(isObjectWithStringId)) {
    return undefined;
  }
  const merged: unknown[] = target.map((entry) => structuredClone(entry));
  const indexById = new Map<string, number>();
  for (const [index, entry] of merged.entries()) {
    if (!isObjectWithStringId(entry)) {
      return undefined;
    }
    indexById.set(entry.id, index);
  }
  for (const patchEntry of patch) {
    if (!isObjectWithStringId(patchEntry)) {
      merged.push(structuredClone(patchEntry));
      continue;
    }
    const existingIndex = indexById.get(patchEntry.id);
    if (existingIndex === undefined) {
      merged.push(structuredClone(patchEntry));
      indexById.set(patchEntry.id, merged.length - 1);
      continue;
    }
    merged[existingIndex] = applyQaMergePatch(merged[existingIndex], patchEntry);
  }
  return merged;
}

export function applyQaMergePatch(target: unknown, patch: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(patch)) {
    return mergeObjectArraysById(target, patch) ?? structuredClone(patch);
  }
  if (!isQaMergePatchObject(patch)) {
    return structuredClone(patch);
  }
  const result = isQaMergePatchObject(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (QA_MERGE_PATCH_BLOCKED_KEYS.has(key)) {
      continue;
    }
    if (value === null) {
      delete result[key];
      continue;
    }
    result[key] = applyQaMergePatch(result[key], value);
  }
  return result;
}
