// Reset preservation keeps user-selected model/auth overrides and operator-owned
// session appearance while dropping automatic fallbacks.
import { resolveSessionAuthProfileOverrideSource } from "./auth-profile-override-provenance.js";
import { resolveSessionModelOverrideSource } from "./model-override-provenance.js";
import type { SessionEntry } from "./types.js";

type ResetPreservedSelectionState = Pick<
  SessionEntry,
  | "providerOverride"
  | "modelOverride"
  | "modelOverrideSource"
  | "modelOverrideRouteResolution"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
  | "icon"
  | "color"
  | "category"
  | "boardFace"
  | "visibility"
>;

/**
 * Decide which model/provider/auth overrides and operator-owned appearance
 * fields survive a `/new` or `/reset`.
 *
 * Only user-driven overrides (explicit `/model`, `sessions.patch`, etc.) are
 * preserved. Auto-created overrides (runtime fallbacks, rate-limit rotations)
 * are cleared so resets actually return the session to the configured default.
 * Control UI appearance (`icon`, `color`, `category`, `boardFace`, `visibility`)
 * is operator-owned presentation, not conversation state, so it is copied when
 * present. Callers that rotate the session id still rely on the SQLite writer
 * to drop `visibility` when identity changes.
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
  if (entry.icon !== undefined) {
    preserved.icon = entry.icon;
  }
  if (entry.color !== undefined) {
    preserved.color = entry.color;
  }
  if (entry.category !== undefined) {
    preserved.category = entry.category;
  }
  if (entry.boardFace !== undefined) {
    preserved.boardFace = entry.boardFace;
  }
  if (entry.visibility !== undefined) {
    preserved.visibility = entry.visibility;
  }
  if (resolveSessionModelOverrideSource(entry) === "user" && entry.modelOverride) {
    preserved.providerOverride = entry.providerOverride;
    preserved.modelOverride = entry.modelOverride;
    preserved.modelOverrideSource = "user";
    if (entry.modelOverrideRouteResolution) {
      preserved.modelOverrideRouteResolution = entry.modelOverrideRouteResolution;
    }
  }

  const authProfileOverrideSource = resolveSessionAuthProfileOverrideSource(entry);
  if (authProfileOverrideSource === "user" && entry.authProfileOverride) {
    preserved.authProfileOverride = entry.authProfileOverride;
    preserved.authProfileOverrideSource = authProfileOverrideSource;
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      preserved.authProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
    }
  }

  return preserved;
}
