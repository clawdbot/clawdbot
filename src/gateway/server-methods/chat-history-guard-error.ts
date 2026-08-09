import { SessionTranscriptProjectionUnavailableError as ProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";

export class SessionTranscriptActiveLeafIdentityUnavailableError extends ProjectionUnavailableError {
  constructor(sessionId: string) {
    super(sessionId);
    this.message = `Session transcript active leaf identity is unavailable: ${sessionId}`;
    this.name = "SessionTranscriptActiveLeafIdentityUnavailableError";
  }
}
