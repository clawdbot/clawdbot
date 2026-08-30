import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

type LegacySessionSurface = {
  isLegacyGroupSessionKey?: (key: string) => boolean;
  canonicalizeLegacySessionKey?: (params: {
    key: string;
    agentId: string;
  }) => string | null | undefined;
};

export type { PreparedLegacySessionSurfaces } from "../plugins/legacy-session-surfaces.types.js";

export function isSurfaceGroupKey(key: string): boolean {
  return key.includes(":group:") || key.includes(":channel:");
}

export function isLegacyGroupKey(
  key: string,
  surfaces: readonly LegacySessionSurface[] = [],
): boolean {
  const trimmed = key.trim();
  if (!trimmed) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("group:") || lower.startsWith("channel:")) {
    return true;
  }
  for (const surface of surfaces) {
    if (surface.isLegacyGroupSessionKey?.(trimmed)) {
      return true;
    }
  }
  return false;
}
