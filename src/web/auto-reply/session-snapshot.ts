import type { loadConfig } from "../../config/config.js";
import {
  DEFAULT_IDLE_MINUTES,
  loadSessionStore,
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
  const idleMinutes = Math.max(
    (isHeartbeat
      ? (sessionCfg?.heartbeatIdleMinutes ?? sessionCfg?.idleMinutes)
      : sessionCfg?.idleMinutes) ?? DEFAULT_IDLE_MINUTES,
    1,
  );
  const fresh = !!(
    entry && Date.now() - entry.updatedAt <= idleMinutes * 60_000
  );
  return { key, entry, fresh, idleMinutes };
}
