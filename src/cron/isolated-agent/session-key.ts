import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import type { SessionScope } from "../../config/sessions/types.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";

/** Resolves a cron session key into the canonical agent-scoped session-store key. */
export function resolveCronAgentSessionKey(params: {
  sessionKey: string;
  agentId: string;
  mainKey?: string | undefined;
  cfg?: { session?: { scope?: SessionScope; mainKey?: string } };
}): string {
  const raw = toAgentStoreSessionKey({
    agentId: params.agentId,
    requestKey: params.sessionKey.trim(),
    mainKey: params.mainKey,
  });
  // Canonicalize so "agent:<id>:main" → "agent:<id>:<configuredMainKey>"
  // when cfg.session.mainKey differs from "main". Without this, cron sessions
  // are orphaned when read paths use the configured mainKey alias (#29683).
  return canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: raw,
  });
}
