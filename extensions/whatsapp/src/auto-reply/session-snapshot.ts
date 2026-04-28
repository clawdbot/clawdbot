import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { normalizeMainKey } from "openclaw/plugin-sdk/routing";
import {
  evaluateSessionFreshness,
  loadSessionStore,
  resolveChannelResetConfig,
  resolveThreadFlag,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveSessionKey,
  resolveStorePath,
} from "./config.runtime.js";

export function getSessionSnapshot(
  cfg: OpenClawConfig,
  from: string,
  _isHeartbeat = false,
  ctx?: {
    sessionKey?: string | null;
    isGroup?: boolean;
    messageThreadId?: string | number | null;
    threadLabel?: string | null;
    threadStarterBody?: string | null;
    parentSessionKey?: string | null;
  },
) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const key =
    ctx?.sessionKey?.trim() ??
    resolveSessionKey(
      scope,
      { From: from, To: "", Body: "" },
      normalizeMainKey(sessionCfg?.mainKey),
    );
  const store = loadSessionStore(resolveStorePath(sessionCfg?.store));
  const entry = store[key];

  const isThread = resolveThreadFlag({
    sessionKey: key,
    messageThreadId: ctx?.messageThreadId ?? null,
    threadLabel: ctx?.threadLabel ?? null,
    threadStarterBody: ctx?.threadStarterBody ?? null,
    parentSessionKey: ctx?.parentSessionKey ?? null,
  });
  const resetType = resolveSessionResetType({ sessionKey: key, isGroup: ctx?.isGroup, isThread });
  const channelReset = resolveChannelResetConfig({
    sessionCfg,
    channel: entry?.lastChannel ?? entry?.channel,
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType,
    resetOverride: channelReset,
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
