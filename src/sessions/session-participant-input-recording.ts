import {
  sessionParticipantInput,
  type SessionParticipantInputContext,
} from "./session-participant-input.js";
import { recordSessionParticipantBestEffort } from "./session-participant-recording.js";

/** Call only after admission and final target selection; never creates a session to count input. */
export function recordAcceptedSessionParticipantInput(
  ctx: SessionParticipantInputContext,
  target: Omit<Parameters<typeof recordSessionParticipantBestEffort>[0], "identity" | "promptedAt">,
): void {
  for (const input of ctx[sessionParticipantInput] ?? []) {
    if (!input.recorded) {
      input.recorded = true;
      recordSessionParticipantBestEffort({
        ...target,
        identity: input.identity,
        promptedAt: input.promptedAt,
      });
    }
  }
}
