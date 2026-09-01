/**
 * Subagent requester store-key normalization.
 *
 * Converts raw requester session keys into the canonical registry key shape.
 */
import { resolveAgentMainSessionKey } from "../../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeMainKey } from "../../../routing/session-key.js";
import { resolveSessionAgentId } from "../../agent-scope.js";

/** Resolve the canonical store key for a subagent requester session. */
export function resolveRequesterStoreKey(
  cfg: OpenClawConfig,
  requesterSessionKey: string,
  explicitAgentId?: string,
): string {
  const raw = (requesterSessionKey ?? "").trim();
  if (!raw) {
    return raw;
  }
  if (raw === "global" || raw === "unknown") {
    return raw;
  }
  if (raw.startsWith("agent:")) {
    return raw;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: raw,
    config: cfg,
    agentId: explicitAgentId,
  });
  const mainKey = normalizeMainKey(cfg?.session?.mainKey);
  if (raw === "main" || raw === mainKey) {
    return cfg.session?.scope === "global"
      ? "global"
      : resolveAgentMainSessionKey({ cfg, agentId });
  }
  return `agent:${agentId}:${raw}`;
}
