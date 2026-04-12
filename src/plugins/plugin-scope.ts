export type PluginIdScope = readonly string[] | undefined;

export function normalizePluginIdScope(ids?: readonly unknown[]): string[] | undefined {
  if (ids === undefined) {
    return undefined;
  }
  return Array.from(
    new Set(
      ids
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ).toSorted();
}

export function hasExplicitPluginIdScope(ids?: readonly string[]): boolean {
  return ids !== undefined;
}

export function hasNonEmptyPluginIdScope(ids?: readonly string[]): boolean {
  return ids !== undefined && ids.length > 0;
}

export function createPluginIdScopeSet(ids?: readonly string[]): ReadonlySet<string> | null {
  if (ids === undefined) {
    return null;
  }
  return new Set(ids);
}

export function serializePluginIdScope(ids?: readonly string[]): string {
  return ids === undefined ? "__unscoped__" : JSON.stringify(ids);
}
