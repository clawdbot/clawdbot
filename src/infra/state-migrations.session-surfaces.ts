import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { listBundledChannelLegacySessionSurfaces } from "../channels/plugins/bundled.js";
import type { PluginRuntimeMode } from "../plugins/plugin-runtime-mode.js";

type LegacySessionSurface = {
  isLegacyGroupSessionKey?: (key: string) => boolean;
  canonicalizeLegacySessionKey?: (params: {
    key: string;
    agentId: string;
  }) => string | null | undefined;
};

let cachedLegacySessionSurfaces: LegacySessionSurface[] | null = null;

export function getLegacySessionSurfaces(
  pluginRuntime: PluginRuntimeMode = "full",
): LegacySessionSurface[] {
  if (pluginRuntime === "none") {
    // Session cleanup evaluates channel setup modules; plugin-free preflight
    // leaves channel-owned key shapes for the later full migration pass.
    return [];
  }
  // Legacy migrations run on cold doctor/startup paths. Prefer the narrower
  // setup plugin surface here so session-key cleanup does not materialize full
  // bundled channel runtimes.
  cachedLegacySessionSurfaces ??= [...listBundledChannelLegacySessionSurfaces()];
  return cachedLegacySessionSurfaces;
}

export function isSurfaceGroupKey(key: string): boolean {
  return key.includes(":group:") || key.includes(":channel:");
}

export function isLegacyGroupKey(key: string, pluginRuntime: PluginRuntimeMode = "full"): boolean {
  const trimmed = key.trim();
  if (!trimmed) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("group:") || lower.startsWith("channel:")) {
    return true;
  }
  for (const surface of getLegacySessionSurfaces(pluginRuntime)) {
    if (surface.isLegacyGroupSessionKey?.(trimmed)) {
      return true;
    }
  }
  return false;
}

export function resetLegacySessionSurfacesForTest(): void {
  cachedLegacySessionSurfaces = null;
}
