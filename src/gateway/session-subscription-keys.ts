import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId } from "../routing/session-key.js";

export function resolveSessionSubscriptionKey(sessionKey: string, agentId: string): string {
  return normalizeLowercaseStringOrEmpty(sessionKey) === "global"
    ? `agent:${normalizeAgentId(agentId)}:global`
    : sessionKey;
}

export function resolveSessionSubscriptionKeys(
  sessionKey: string,
  agentId: string,
  defaultAgentId?: string,
): string[] {
  const canonicalKey = resolveSessionSubscriptionKey(sessionKey, agentId);
  // Raw global is a legacy default-agent stream. Non-default agents must stay
  // on their qualified key even when callers supplied the global alias.
  return defaultAgentId &&
    normalizeLowercaseStringOrEmpty(sessionKey) === "global" &&
    normalizeAgentId(agentId) === normalizeAgentId(defaultAgentId)
    ? [canonicalKey, "global"]
    : [canonicalKey];
}
