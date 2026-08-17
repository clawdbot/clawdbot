import { recordSessionParticipant } from "../config/sessions/session-accessor.js";
import type { SessionCreatedActor } from "../config/sessions/session-entry-provenance.js";

/** Defers display-only participant persistence so it can never delay or abort an admitted turn. */
export function recordSessionParticipantBestEffort(params: {
  actor: SessionCreatedActor & { id: string };
  agentId: string;
  sessionKey: string;
  storePath: string;
  promptedAt?: number;
  onError?: (error: unknown) => void;
}): void {
  queueMicrotask(() => {
    try {
      recordSessionParticipant(
        {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        },
        {
          actor: params.actor,
          promptedAt: params.promptedAt,
          sessionAgentId: params.agentId,
        },
      );
    } catch (error) {
      params.onError?.(error);
    }
  });
}
