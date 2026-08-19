import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

/** Resolves the configured owner for Talk work that has no agent-scoped session key. */
export function resolveTalkTargetAgentId(config: OpenClawConfig): string {
  return normalizeAgentId(
    normalizeOptionalString(config.talk?.agentId) ??
      resolveAmbientOwnerAgentId(config, {
        surface: "Talk relay ownership",
        hint: "Set talk.agentId to the agent that owns unscoped Talk sessions.",
      }),
  );
}

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
    ? resolveTalkTargetAgentId(config)
    : resolveSessionAgentId({ config, sessionKey: normalizedSessionKey });
}
