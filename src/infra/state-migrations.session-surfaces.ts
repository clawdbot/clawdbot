import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { listBundledChannelLegacySessionSurfaces } from "../channels/plugins/bundled.js";

type LegacySessionSurface = {
  isLegacyGroupSessionKey?: (key: string) => boolean;
  canonicalizeLegacySessionKey?: (params: {
    key: string;
    agentId: string;
  }) => string | null | undefined;
};

let cachedLegacySessionSurfaces: LegacySessionSurface[] | null = null;

export function getLegacySessionSurfaces(): LegacySessionSurface[] {
  // Legacy migrations run on cold doctor/startup paths. Prefer the narrower
  // setup plugin surface here so session-key cleanup does not materialize full
  // bundled channel runtimes.
  cachedLegacySessionSurfaces ??= [...listBundledChannelLegacySessionSurfaces()];
  return cachedLegacySessionSurfaces;
}

export function isSurfaceGroupKey(key: string): boolean {
  return key.includes(":group:") || key.includes(":channel:");
}

export function isLegacyGroupKey(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("group:") || lower.startsWith("channel:")) {
    return true;
  }
  for (const surface of getLegacySessionSurfaces()) {
    if (surface.isLegacyGroupSessionKey?.(trimmed)) {
      return true;
    }
  }
  return false;
}

export function resetLegacySessionSurfacesForTest(): void {
  cachedLegacySessionSurfaces = null;
}
