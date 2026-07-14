import type { ClawdbotConfig } from "./bot-runtime-api.js";

export function resolveBroadcastAgents(cfg: ClawdbotConfig, peerId: string): string[] | null {
  const broadcast = (cfg as Record<string, unknown>).broadcast;
  if (!broadcast || typeof broadcast !== "object") {
    return null;
  }
  const agents = (broadcast as Record<string, unknown>)[peerId];
  return Array.isArray(agents) && agents.length > 0 ? (agents as string[]) : null;
}

export function buildBroadcastSessionKey(
  baseSessionKey: string,
  originalAgentId: string,
  targetAgentId: string,
): string {
  const prefix = `agent:${originalAgentId}:`;
  return baseSessionKey.startsWith(prefix)
    ? `agent:${targetAgentId}:${baseSessionKey.slice(prefix.length)}`
    : baseSessionKey;
}
