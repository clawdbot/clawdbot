import type { AgentMessage } from "./types.js";

export const TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE = "openclaw_transcript_not_continuable";

export class TranscriptNotContinuableError extends Error {
  public readonly code = TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE;
  public readonly role: AgentMessage["role"];

  constructor(role: AgentMessage["role"]) {
    super(`Cannot continue from message role: ${role}`);
    this.name = "TranscriptNotContinuableError";
    this.role = role;
  }
}
