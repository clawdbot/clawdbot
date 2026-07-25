import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";

export function resolveWorkerTurnTranscriptTarget(
  turn: Pick<SessionPlacementTurnParams, "agentId" | "sessionId" | "sessionKey" | "sessionTarget">,
): { agentId: string; sessionId: string; sessionKey: string; storePath: string } {
  if (
    !turn.sessionTarget?.agentId ||
    !turn.sessionTarget.sessionKey ||
    !turn.sessionTarget.storePath
  ) {
    throw new Error("Cloud worker turn is missing its transcript identity");
  }
  if (turn.sessionTarget.sessionId && turn.sessionTarget.sessionId !== turn.sessionId) {
    throw new Error("Cloud worker transcript identity does not match the active turn");
  }
  if (
    (turn.agentId && turn.sessionTarget.agentId !== turn.agentId) ||
    (turn.sessionKey && turn.sessionTarget.sessionKey !== turn.sessionKey)
  ) {
    throw new Error("Cloud worker transcript identity does not match the active turn");
  }
  return {
    agentId: turn.sessionTarget.agentId,
    sessionId: turn.sessionId,
    sessionKey: turn.sessionTarget.sessionKey,
    storePath: turn.sessionTarget.storePath,
  };
}
