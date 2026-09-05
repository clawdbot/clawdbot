// Browser-safe path/key rules shared by merge patches and explicit array-deletion intent.
import { isPlainObject } from "../infra/plain-object.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";

export function formatConfigPatchPath(parentPath: string | undefined, key: string): string {
  return parentPath ? `${parentPath}.${key}` : key;
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

/** Collect only beneath a subtree the caller explicitly intends to delete. */
export function collectBaseArrayPaths(base: unknown, path: string): string[] {
  if (Array.isArray(base)) {
    return [path];
  }
  if (!isPlainObject(base)) {
    return [];
  }
  const paths: string[] = [];
  for (const [key, value] of Object.entries(base)) {
    const childPath = formatConfigPatchPath(path, key);
    if (!isMergePatchObjectKeyAllowed(key, path)) {
      continue;
    }
    paths.push(...collectBaseArrayPaths(value, childPath));
  }
  return paths;
}

function normalizeConfigPatchReplacePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.endsWith("[]")) {
    return trimmed.slice(0, -2).replace(/\[\d+\](?=\.)/g, "[]");
  }
  return trimmed.replace(/\[\d+\](?=\.)/g, "[]");
}

export function normalizeConfigPatchReplacePaths(
  values: readonly unknown[] | undefined,
): Set<string> {
  if (!values) {
    return new Set();
  }
  return new Set(
    values
      .filter((value): value is string => typeof value === "string")
      .map(normalizeConfigPatchReplacePath)
      .filter((value) => value.length > 0),
  );
}
