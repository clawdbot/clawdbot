import type { TranscriptEntryAnchor } from "../config/sessions/session-accessor.js";
import type { UserTurnTranscriptAdmissionReceipt } from "./user-turn-transcript.types.js";

export function resolveUserTurnTranscriptAdmission(params: {
  logicalTurnId: string;
  receipt: TranscriptEntryAnchor | UserTurnTranscriptAdmissionReceipt;
}): UserTurnTranscriptAdmissionReceipt {
  return "logicalTurnId" in params.receipt
    ? params.receipt
    : {
        ...params.receipt,
        logicalTurnId: params.logicalTurnId,
        role: "user",
      };
}
