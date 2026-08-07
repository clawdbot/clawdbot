export class SessionTranscriptProjectionUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reason: "active-leaf-identity" | "rebuilding" = "rebuilding",
  ) {
    super(
      reason === "rebuilding"
        ? `Session transcript projection is rebuilding: ${sessionId}`
        : `Session transcript active leaf identity is unavailable: ${sessionId}`,
    );
    this.name = "SessionTranscriptProjectionUnavailableError";
  }
}

export function isSessionTranscriptProjectionUnavailableError(
  error: unknown,
): error is SessionTranscriptProjectionUnavailableError {
  return error instanceof SessionTranscriptProjectionUnavailableError;
}
