import { normalizeAgentId } from "../routing/session-key.js";

export const SYSTEM_AGENT_ID = "openclaw";

const RESERVED_SYSTEM_AGENT_IDS = new Set([
  normalizeAgentId(SYSTEM_AGENT_ID),
  normalizeAgentId("crestodian"), // reserved retired id
]);

export function isReservedSystemAgentId(agentId: string): boolean {
  return RESERVED_SYSTEM_AGENT_IDS.has(normalizeAgentId(agentId));
}
