import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveConfiguredAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveTalkSessionAgentId } from "../talk/agent-target.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "./session-store-key.js";
import { resolveGatewaySessionStoreTargetWithStore } from "./session-utils-store-lookup.js";

export type PreparedTalkSessionTarget = Readonly<{
  agentId: string;
  /** Voice records and close/resume retain the client's exact key, not its storage alias. */
  sessionKey: string;
  canonicalKey: string;
  storePath: string;
}>;

export function requirePreparedTalkSessionTarget(
  target: PreparedTalkSessionTarget | undefined,
): PreparedTalkSessionTarget {
  if (!target) {
    throw new Error("Talk session target was not prepared by the Gateway");
  }
  return target;
}

/** Resolve Talk ownership before aliases collapse, then retain the exact storage target. */
export function prepareTalkSessionTarget(
  cfg: OpenClawConfig,
  requestedSessionKey?: string,
): PreparedTalkSessionTarget {
  const requestedKey = normalizeOptionalString(requestedSessionKey);
  const owner = resolveConfiguredAgentId(
    cfg,
    resolveTalkSessionAgentId(cfg, requestedKey ?? "main"),
  );
  const sessionKey = requestedKey ?? resolveAgentMainSessionKey({ cfg, agentId: owner });
  const requestedAgentId = resolveSessionStoreAgentId(cfg, sessionKey, owner);
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey, storeAgentId: requestedAgentId });
  // A scoped main alias may become global. Validate the fixed-store owner again,
  // rather than dropping the explicit owner when the canonical key loses its prefix.
  const agentId = resolveSessionStoreAgentId(cfg, canonicalKey, requestedAgentId);
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg,
    key: canonicalKey,
    agentId,
    readOnly: true,
    exactRead: true,
  });
  return Object.freeze({ agentId, sessionKey, canonicalKey, storePath: target.storePath });
}
