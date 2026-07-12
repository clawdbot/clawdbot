// Applies JSON merge-patch updates to config-like objects.
import { isPlainObject } from "../infra/plain-object.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";

type PlainObject = Record<string, unknown>;

type MergePatchOptions = {
  mergeObjectArraysById?: boolean;
  replaceArrayPaths?: ReadonlySet<string>;
  path?: string;
};

function isObjectWithStringId(value: unknown): value is Record<string, unknown> & { id: string } {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.id === "string" && value.id.length > 0;
}

function formatMergePatchPath(parentPath: string | undefined, key: string): string {
  return parentPath ? `${parentPath}.${key}` : key;
}

function formatMergePatchArrayEntryPath(arrayPath: string): string {
  return `${arrayPath}[]`;
}

/** Whether a merge-patch key is safe at its exact config path. */
export function isMergePatchObjectKeyAllowed(key: string, parentPath?: string): boolean {
  if (!isBlockedObjectKey(key)) {
    return true;
  }
  // Browser profile names are schema-validated map ids. Their values still
  // recurse through this guard, so nested prototype-related keys stay blocked.
  return parentPath === "browser.profiles" && (key === "constructor" || key === "prototype");
}

/**
 * Merge arrays of object-like entries keyed by `id`.
 *
 * Contract:
 * - Base array must be fully id-keyed; otherwise return undefined (caller should replace).
 * - Patch entries with valid id merge by id (or append when the id is new).
 * - Patch entries without valid id append as-is, avoiding destructive full-array replacement.
 */
function mergeObjectArraysById(
  base: unknown[],
  patch: unknown[],
  options: MergePatchOptions,
  arrayPath: string,
): unknown[] | undefined {
  if (!base.every(isObjectWithStringId)) {
    return undefined;
  }

  const merged: unknown[] = [...base];
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

    merged[existingIndex] = applyMergePatch(merged[existingIndex], patchEntry, {
      ...options,
      path: formatMergePatchArrayEntryPath(arrayPath),
    });
  }

  return merged;
}

/**
 * Applies an RFC 7396-style object merge patch with OpenClaw config safeguards.
 *
 * Non-object patches replace the base, `null` deletes keys, blocked prototype
 * keys are ignored outside schema-owned record-key paths, and id-keyed arrays
 * may merge when the caller opts in.
 */
export function applyMergePatch(
  base: unknown,
  patch: unknown,
  options: MergePatchOptions = {},
): unknown {
  if (!isPlainObject(patch)) {
    return patch;
  }

  const result: PlainObject = isPlainObject(base) ? { ...base } : {};

  for (const [key, value] of Object.entries(patch)) {
    const path = formatMergePatchPath(options.path, key);
    if (!isMergePatchObjectKeyAllowed(key, options.path)) {
      continue;
    }
    if (value === null) {
      delete result[key];
      continue;
    }
    if (options.mergeObjectArraysById && Array.isArray(result[key]) && Array.isArray(value)) {
      if (options.replaceArrayPaths?.has(path)) {
        result[key] = value;
        continue;
      }
      // Config arrays like agents/plugins can patch by id; non-id arrays keep RFC replacement.
      const mergedArray = mergeObjectArraysById(result[key] as unknown[], value, options, path);
      if (mergedArray) {
        result[key] = mergedArray;
        continue;
      }
    }
    if (isPlainObject(value)) {
      const baseValue = result[key];
      result[key] = applyMergePatch(isPlainObject(baseValue) ? baseValue : {}, value, {
        ...options,
        path,
      });
      continue;
    }
    result[key] = value;
  }

  return result;
}
