// Normalizes plugin scope identifiers and scope lists.
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";

/** Normalizes plugin id scope input into a sorted unique string list. */
export function normalizePluginIdScope(ids?: readonly unknown[]): string[] | undefined {
  if (ids === undefined) {
    return undefined;
  }
  return Array.from(
    new Set(normalizeStringEntries(ids.filter((id): id is string => typeof id === "string"))),
  ).toSorted();
}

/** True when plugin scope was explicitly provided, including an empty scope. */
export function hasExplicitPluginIdScope(ids?: readonly string[]): boolean {
  return ids !== undefined;
}

/** True when plugin scope was explicitly provided with at least one id. */
export function hasNonEmptyPluginIdScope(ids?: readonly string[]): boolean {
  return ids !== undefined && ids.length > 0;
}

/** Creates a lookup set for explicit plugin scope, or null when unscoped. */
export function createPluginIdScopeSet(ids?: readonly string[]): ReadonlySet<string> | null {
  if (ids === undefined) {
    return null;
  }
  return new Set(ids);
}

/** Serializes plugin scope for cache keys. */
export function serializePluginIdScope(ids?: readonly string[]): string {
  return ids === undefined ? "__unscoped__" : JSON.stringify(ids);
}
