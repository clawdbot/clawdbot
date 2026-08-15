/**
 * Session-to-agent binding resolver.
 *
 * Derives the trusted active agent from explicit agent ids, agent session keys, or configured main-session aliases.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionAgentId } from "./agent-scope.js";

/**
 * Resolve the trusted active agent bound to a host-owned session reference.
 */
export function resolveBoundAgentIdForSession(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  if (!normalizeOptionalString(params.agentId) && !normalizeOptionalString(params.sessionKey)) {
    return undefined;
  }
  return resolveSessionAgentId({
    config: params.config,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
}
