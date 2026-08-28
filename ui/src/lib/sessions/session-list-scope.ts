import { normalizeAgentId } from "./session-key.ts";

export function sessionListAgentMatches(
  queryAgentId: string | undefined,
  agentId: string | null | undefined,
): boolean {
  return (
    !agentId?.trim() ||
    !queryAgentId ||
    normalizeAgentId(queryAgentId) === normalizeAgentId(agentId)
  );
}
