export class SessionTranscriptProjectionUnavailableError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session transcript projection is rebuilding: ${sessionId}`);
    this.name = "SessionTranscriptProjectionUnavailableError";
  }
}

export function isSessionTranscriptProjectionUnavailableError(
  error: unknown,
): error is SessionTranscriptProjectionUnavailableError {
  return error instanceof SessionTranscriptProjectionUnavailableError;
}
