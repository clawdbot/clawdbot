import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";

export function resolveWorkerTurnTranscriptTarget(
  turn: Pick<SessionPlacementTurnParams, "agentId" | "sessionId" | "sessionKey" | "sessionTarget">,
): { agentId: string; sessionId: string; sessionKey: string; storePath: string } {
  if (
    !turn.sessionTarget?.agentId ||
    !turn.sessionTarget.sessionId ||
    !turn.sessionTarget.sessionKey ||
    !turn.sessionTarget.storePath
  ) {
    throw new Error("Cloud worker turn is missing its transcript identity");
  }
  if (turn.sessionTarget.sessionId !== turn.sessionId) {
    throw new Error("Cloud worker transcript identity does not match the active turn");
  }
  const targetKeyAgentId = parseAgentSessionKey(turn.sessionTarget.sessionKey)?.agentId;
  if (
    (turn.agentId && turn.sessionTarget.agentId !== turn.agentId) ||
    (turn.sessionKey && turn.sessionTarget.sessionKey !== turn.sessionKey) ||
    (targetKeyAgentId && targetKeyAgentId !== turn.sessionTarget.agentId)
  ) {
    throw new Error("Cloud worker transcript identity does not match the active turn");
  }
  const currentEntry = loadSessionEntry({
    agentId: turn.sessionTarget.agentId,
    sessionKey: turn.sessionTarget.sessionKey,
    storePath: turn.sessionTarget.storePath,
  });
  if (currentEntry?.sessionId !== turn.sessionId) {
    throw new Error("Cloud worker transcript identity is no longer current");
  }
  return {
    agentId: turn.sessionTarget.agentId,
    sessionId: turn.sessionId,
    sessionKey: turn.sessionTarget.sessionKey,
    storePath: turn.sessionTarget.storePath,
  };
}
