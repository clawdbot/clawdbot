import { recordSessionParticipant } from "../config/sessions/session-accessor.js";
import type {
  SessionCreatedActor,
  SessionParticipantSource,
} from "../config/sessions/session-entry-provenance.js";

/** Defers participant history persistence so it can never delay or abort an admitted turn. */
export function recordSessionParticipantBestEffort(params: {
  actor: SessionCreatedActor & { id: string };
  agentId: string;
  sessionKey: string;
  storePath: string;
  source: SessionParticipantSource;
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
          source: params.source,
        },
      );
    } catch (error) {
      params.onError?.(error);
    }
  });
}
