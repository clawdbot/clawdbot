import type { loadConfig } from "../../config/config.js";
import {
  evaluateSessionFreshness,
  loadSessionStore,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveSessionKey,
  resolveStorePath,
} from "../../config/sessions.js";
import { normalizeMainKey } from "../../routing/session-key.js";

export function getSessionSnapshot(
  cfg: ReturnType<typeof loadConfig>,
  from: string,
  isHeartbeat = false,
) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const key = resolveSessionKey(
    scope,
    { From: from, To: "", Body: "" },
    normalizeMainKey(sessionCfg?.mainKey),
  );
  const store = loadSessionStore(resolveStorePath(sessionCfg?.store));
  const entry = store[key];
  const resetType = resolveSessionResetType({ sessionKey: key });
  const idleMinutesOverride = isHeartbeat ? sessionCfg?.heartbeatIdleMinutes : undefined;
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType,
    idleMinutesOverride,
  });
  const now = Date.now();
  const freshness = entry
    ? evaluateSessionFreshness({ updatedAt: entry.updatedAt, now, policy: resetPolicy })
    : { fresh: false };
  return {
    key,
    entry,
    fresh: freshness.fresh,
    resetPolicy,
    resetType,
    dailyResetAt: freshness.dailyResetAt,
    idleExpiresAt: freshness.idleExpiresAt,
  };
}
