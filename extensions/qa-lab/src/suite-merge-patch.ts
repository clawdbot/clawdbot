// Qa Lab plugin module implements suite merge patch behavior.
import { isRecord as isPlainObject } from "openclaw/plugin-sdk/string-coerce-runtime";

const QA_MERGE_PATCH_BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isQaMergePatchObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

function isObjectWithStringId(value: unknown): value is { id: string } & Record<string, unknown> {
  return isQaMergePatchObject(value) && typeof value.id === "string" && value.id.length > 0;
}

// Entry composition differs between applying a patch and merging two patch
// documents, so the caller supplies it; the id-keyed array contract itself is
// stated once here.
function mergeObjectArraysById(
  target: unknown[],
  patch: unknown[],
  mergeEntry: (target: unknown, patch: unknown) => unknown,
): unknown[] | undefined {
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
    merged[existingIndex] = mergeEntry(merged[existingIndex], patchEntry);
  }
  return merged;
}

// Merging two patch documents is not the same as applying one to a config: a
// `null` here is the deletion a scenario still intends, so it survives to the
// application step instead of deleting a key the empty accumulator never had.
export function mergeQaMergePatchDocuments(target: unknown, patch: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(patch)) {
    // Two scenarios patching the same id-keyed entry each own part of it, so
    // the accumulator composes them the way the application step would rather
    // than letting the later document drop the earlier one's fields.
    return (
      mergeObjectArraysById(target, patch, mergeQaMergePatchDocuments) ?? structuredClone(patch)
    );
  }
  if (!isQaMergePatchObject(patch) || !isQaMergePatchObject(target)) {
    return structuredClone(patch);
  }
  const result = structuredClone(target);
  for (const [key, value] of Object.entries(patch)) {
    if (QA_MERGE_PATCH_BLOCKED_KEYS.has(key)) {
      continue;
    }
    result[key] = mergeQaMergePatchDocuments(result[key], value);
  }
  return result;
}

export function applyQaMergePatch(target: unknown, patch: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(patch)) {
    return mergeObjectArraysById(target, patch, applyQaMergePatch) ?? structuredClone(patch);
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
