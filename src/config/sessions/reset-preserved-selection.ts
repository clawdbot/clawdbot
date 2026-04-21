import type { SessionEntry } from "./types.js";

export type ResetPreservedSelectionState = Pick<
  SessionEntry,
  | "providerOverride"
  | "modelOverride"
  | "modelOverrideSource"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
>;

/**
 * Decide which model/provider/auth overrides survive a `/new` or `/reset`.
 *
 * Only user-driven overrides (explicit `/model`, `sessions.patch`, etc.) are
 * preserved. Auto-created overrides (runtime fallbacks, rate-limit rotations)
 * are cleared so resets actually return the session to the configured default.
 *
 * Legacy entries persisted before `modelOverrideSource` was tracked are
 * treated as user-driven, matching the prior reset behavior so explicit
 * selections made before the source field existed are not silently dropped.
 */
export function resolveResetPreservedSelection(params: {
  entry?: SessionEntry;
}): Partial<ResetPreservedSelectionState> {
  const { entry } = params;
  if (!entry) {
    return {};
  }

  const preserved: Partial<ResetPreservedSelectionState> = {};
  const preserveLegacyUserModelOverride =
    entry.modelOverrideSource === "user" ||
    (entry.modelOverrideSource === undefined && Boolean(entry.modelOverride));
  if (preserveLegacyUserModelOverride && entry.modelOverride) {
    preserved.providerOverride = entry.providerOverride;
    preserved.modelOverride = entry.modelOverride;
    preserved.modelOverrideSource = "user";
  }

  if (entry.authProfileOverrideSource === "user" && entry.authProfileOverride) {
    preserved.authProfileOverride = entry.authProfileOverride;
    preserved.authProfileOverrideSource = entry.authProfileOverrideSource;
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      preserved.authProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
    }
  }

  return preserved;
}
