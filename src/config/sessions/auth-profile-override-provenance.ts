import type { SessionEntry } from "./types.js";
type AuthProfileOverrideProvenance = Pick<
  SessionEntry,
  "authProfileOverride" | "authProfileOverrideSource" | "authProfileOverrideCompactionCount"
>;

export function resolveSessionAuthProfileOverrideSource(
  entry: AuthProfileOverrideProvenance | undefined,
): "auto" | "user" | "user-link" | undefined {
  if (!entry?.authProfileOverride?.trim()) {
    return undefined;
  }
  const isAutomatic = typeof entry.authProfileOverrideCompactionCount === "number";
  return entry.authProfileOverrideSource || (isAutomatic ? "auto" : "user");
}

/** Keep person-linked session provenance at user-pin strength in runtime consumers. */
export function resolveCollapsedSessionAuthPinSource(
  entry: AuthProfileOverrideProvenance | undefined,
): "auto" | "user" | undefined {
  const source = resolveSessionAuthProfileOverrideSource(entry);
  return source === "user-link" ? "user" : source;
}
