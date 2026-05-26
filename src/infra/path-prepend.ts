import path from "node:path";
import {
  normalizeStringEntries,
  normalizeUniqueStringEntries,
} from "../shared/string-normalization.js";

/**
 * Find the actual key used for PATH in the env object.
 * On Windows, `process.env` stores it as `Path` (not `PATH`),
 * and after copying to a plain object the original casing is preserved.
 */
export function findPathKey(env: Record<string, string>): string {
  if ("PATH" in env) {
    return "PATH";
  }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") {
      return key;
    }
  }
  return "PATH";
}

export function normalizePathPrepend(entries?: string[]) {
  if (!Array.isArray(entries)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function mergePathPrepend(existing: string | undefined, prepend: string[]) {
  if (prepend.length === 0) {
    return existing;
  }
  return normalizeUniqueStringEntries([...prepend, ...(existing ?? "").split(path.delimiter)]).join(
    path.delimiter,
  );
}

export function removePathPrepend(
  existing: string | undefined,
  prepend: string[],
): string | undefined {
  if (!existing || prepend.length === 0) {
    return existing;
  }

  const prependEntries = new Set<string>(normalizeStringEntries(prepend));

  const remaining = normalizeStringEntries((existing ?? "").split(path.delimiter)).filter(
    (part) => !prependEntries.has(part),
  );

  return remaining.join(path.delimiter);
}

export function applyPathPrepend(
  env: Record<string, string>,
  prepend: string[] | undefined,
  options?: { requireExisting?: boolean },
) {
  if (!Array.isArray(prepend) || prepend.length === 0) {
    return;
  }
  // On Windows the PATH key may be stored as `Path` (case-insensitive env vars).
  // After coercing to a plain object the original casing is preserved, so we must
  // look up the actual key to read the existing value and write the merged result back.
  const pathKey = findPathKey(env);
  if (options?.requireExisting && !env[pathKey]) {
    return;
  }
  const merged = mergePathPrepend(env[pathKey], prepend);
  if (merged) {
    env[pathKey] = merged;
  }
}
