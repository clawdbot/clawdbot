import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export const DEFAULT_MAIN_KEY = "main";

export type ParsedAgentSessionKey = {
  agentId: string;
  rest: string;
};

/** Split the ownership head without changing opaque tail bytes or empty tail segments. */
export function parseAgentSessionKeyParts(sessionKey: string): ParsedAgentSessionKey | null {
  if (sessionKey.slice(0, 6).toLowerCase() !== "agent:") {
    return null;
  }
  const agentIdEnd = sessionKey.indexOf(":", 6);
  if (agentIdEnd === -1) {
    return null;
  }
  const agentId = sessionKey.slice(6, agentIdEnd).trim();
  const rest = sessionKey.slice(agentIdEnd + 1);
  return agentId && rest && !rest.startsWith(":") ? { agentId, rest } : null;
}

export function normalizeMainKey(value: string | undefined | null): string {
  return normalizeLowercaseStringOrEmpty(value) || DEFAULT_MAIN_KEY;
}

export function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
}): string {
  return `agent:${normalizeAgentId(params.agentId)}:${normalizeMainKey(params.mainKey)}`;
}
