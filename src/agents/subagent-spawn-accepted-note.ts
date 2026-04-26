import { isCronSessionKey } from "../routing/session-key.js";

export const SUBAGENT_SPAWN_ACCEPTED_NOTE =
  "Auto-announce is push-based. After spawning children, do NOT call sessions_list, sessions_history, exec sleep, or any polling tool. Track expected child session keys. If any required child completion has not arrived yet, call sessions_yield to end the turn and wait for completion events as user messages. Only send your final answer after ALL expected completions arrive. If a child completion event arrives AFTER your final answer, reply ONLY with NO_REPLY.";
export const SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound session stays active after this task; continue in-thread for follow-ups.";

export function resolveSubagentSpawnAcceptedNote(params: {
  spawnMode: "run" | "session";
  agentSessionKey?: string;
}): string | undefined {
  if (params.spawnMode === "session") {
    return SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE;
  }
  return isCronSessionKey(params.agentSessionKey) ? undefined : SUBAGENT_SPAWN_ACCEPTED_NOTE;
}
