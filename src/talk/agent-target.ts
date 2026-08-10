import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";

/** Resolves the configured owner for Talk work that has no agent-scoped session key. */
export function resolveTalkTargetAgentId(config: OpenClawConfig): string {
  return normalizeAgentId(
    normalizeOptionalString(config.talk?.agentId) ?? resolveDefaultAgentId(config),
  );
}

/** Agent-scoped keys own their Talk session; legacy/unscoped aliases use the Talk target. */
export function resolveTalkSessionAgentId(
  config: OpenClawConfig,
  sessionKey?: string | null,
): string {
  return resolveAgentIdFromSessionKey(sessionKey, resolveTalkTargetAgentId(config));
}
