import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";

/** A failed start whose provider or transport still needs caller-owned cleanup. */
export class MeetingRealtimeStartupCleanupError extends Error {
  readonly cleanup: { stop: () => Promise<void> };
  readonly cleanupError: unknown;

  constructor(params: {
    meetingSessionId: string;
    cause: unknown;
    cleanupError: unknown;
    stop: () => Promise<void>;
  }) {
    super(
      `${coerceErrorMessage(params.cause)}. Meeting cleanup remains pending for session ${params.meetingSessionId}. Use the meeting plugin's status and leave commands, or retry error.cleanup.stop() from the SDK.`,
      { cause: params.cause },
    );
    this.name = "MeetingRealtimeStartupCleanupError";
    this.cleanupError = params.cleanupError;
    this.cleanup = { stop: params.stop };
  }
}
