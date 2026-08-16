import { normalizeAgentId } from "../routing/session-key.js";

export const SYSTEM_AGENT_ID = "openclaw";

export const SYSTEM_AGENT_ROSTER_ENTRIES = [
  { id: SYSTEM_AGENT_ID, kind: "system" },
  { id: "crestodian", kind: "system" },
] as const;

const RESERVED_SYSTEM_AGENT_IDS = new Set(
  SYSTEM_AGENT_ROSTER_ENTRIES.map((entry) => normalizeAgentId(entry.id)),
);

export function isReservedSystemAgentId(agentId: string): boolean {
  return RESERVED_SYSTEM_AGENT_IDS.has(normalizeAgentId(agentId));
}
