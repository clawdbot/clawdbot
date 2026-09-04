import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

/** Agent-scoped keys own their Talk session; legacy/unscoped aliases use the Talk target. */
export function resolveTalkSessionAgentId(
  config: OpenClawConfig,
  sessionKey?: string | null,
): string {
  const normalizedSessionKey = sessionKey ?? undefined;
  const scopedAgentId = parseAgentSessionKey(normalizedSessionKey)?.agentId;
  if (scopedAgentId) {
    return normalizeAgentId(scopedAgentId);
  }
  return resolvePersistedSessionStoreOwnerForKey(config, normalizedSessionKey).kind === "none"
    ? resolveAmbientOwnerAgentId(config, config.talk?.agentId, {
        surface: "Talk session ownership",
        hint: "Set talk.agentId to the agent that owns unscoped Talk sessions.",
      })
    : resolveSessionAgentId({ config, sessionKey: normalizedSessionKey });
}
