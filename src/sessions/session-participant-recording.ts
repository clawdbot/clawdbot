import { recordSessionParticipant } from "../config/sessions/session-accessor.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";

/** Defers participant history persistence so it can never delay or abort an admitted turn. */
export function recordSessionParticipantBestEffort(params: {
  identity: SessionParticipantIdentity;
  agentId: string;
  sessionKey: string;
  storePath: string;
  promptedAt?: number;
  onError?: (error: unknown) => void;
}): void {
  const promptedAt = params.promptedAt ?? Date.now();
  queueMicrotask(() => {
    try {
      recordSessionParticipant(
        {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        },
        {
          identity: params.identity,
          promptedAt,
          sessionAgentId: params.agentId,
        },
      );
    } catch (error) {
      params.onError?.(error);
    }
  });
}
