import { resolveDebugProxySettings } from "./env.js";
import { getDebugProxyCaptureStore } from "./store.sqlite.js";
import type { CaptureQueryPreset } from "./types.js";

export function listDebugProxySessions(limit?: number) {
  const settings = resolveDebugProxySettings();
  return getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).listSessions(limit);
}

export function queryDebugProxyPreset(preset: CaptureQueryPreset, sessionId?: string) {
  const settings = resolveDebugProxySettings();
  return getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).queryPreset(
    preset,
    sessionId,
  );
}
