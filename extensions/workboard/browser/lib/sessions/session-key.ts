import { workboardHost } from "../../host.ts";

export { normalizeAgentId } from "@openclaw/normalization-core/agent-id";

export function parseAgentSessionKey(sessionKey: string): { agentId: string; rest: string } | null {
  const match = /^agent:([^:]+):(.+)$/i.exec(sessionKey.trim());
  return match ? { agentId: match[1]!.toLowerCase(), rest: match[2]! } : null;
}

export function normalizeSessionKeyForUiComparison(sessionKey: string): string {
  return workboardHost().sessions.normalizeKey(sessionKey);
}
