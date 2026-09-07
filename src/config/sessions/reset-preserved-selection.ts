// Reset preservation keeps user-selected model/auth overrides while dropping automatic fallbacks.
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
>;

type ResetPreservedDisplayState = Pick<
  SessionEntry,
  "label" | "displayName" | "icon" | "color" | "category" | "boardFace" | "visibility"
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

/**
 * Preserve operator-owned session presentation across reset boundaries.
 *
 * `/new` and `/reset` replace run/transcript state, but they should not erase
 * Control UI choices that describe how an operator recognizes and organizes
 * the same durable session.
 */
export function resolveResetPreservedDisplayState(params: {
  entry?: SessionEntry;
}): Partial<ResetPreservedDisplayState> {
  const { entry } = params;
  if (!entry) {
    return {};
  }

  return {
    label: entry.label,
    displayName: entry.displayName,
    icon: entry.icon,
    color: entry.color,
    category: entry.category,
    boardFace: entry.boardFace,
    visibility: entry.visibility,
  };
}
