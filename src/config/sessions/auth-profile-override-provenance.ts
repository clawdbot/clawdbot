import type { SessionEntry } from "./types.js";
type AuthProfileOverrideProvenance = Pick<
  SessionEntry,
  "authProfileOverride" | "authProfileOverrideSource" | "authProfileOverrideCompactionCount"
>;

export function resolveSessionAuthProfileOverrideSource(
  entry: AuthProfileOverrideProvenance | undefined,
): "auto" | "user" | undefined {
  if (!entry?.authProfileOverride?.trim()) {
    return undefined;
  }
  const isAutomatic = typeof entry.authProfileOverrideCompactionCount === "number";
  return entry.authProfileOverrideSource || (isAutomatic ? "auto" : "user");
}
