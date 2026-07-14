import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../../infra/backoff.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("session-init");

/**
 * Raised when reply-session initialization loses its revision compare-and-swap.
 * The message shape is load-bearing for channel retry classification.
 */
export class ReplySessionInitConflictError extends Error {
  constructor(sessionKey: string) {
    super(`reply session initialization conflicted for ${sessionKey}`);
    this.name = "ReplySessionInitConflictError";
  }
}

const SESSION_INIT_CONFLICT_MAX_ATTEMPTS = 5;
const SESSION_INIT_CONFLICT_BACKOFF_POLICY = {
  initialMs: 250,
  maxMs: 4_000,
  factor: 2,
  jitter: 0.05,
} satisfies BackoffPolicy;

/**
 * Retry only the unlocked outer attempt. Sleeping while holding the session-store
 * writer lane would prevent the competing commit from settling.
 */
export async function runWithSessionInitConflictRetry<T>(
  attempt: () => Promise<T>,
  options?: {
    maxAttempts?: number;
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? SESSION_INIT_CONFLICT_MAX_ATTEMPTS;
  const sleep = options?.sleep ?? sleepWithAbort;
  for (let attemptIndex = 0; ; attemptIndex += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (
        !(error instanceof ReplySessionInitConflictError) ||
        attemptIndex >= maxAttempts - 1 ||
        options?.signal?.aborted === true
      ) {
        throw error;
      }
      const backoffMs = computeBackoff(SESSION_INIT_CONFLICT_BACKOFF_POLICY, attemptIndex + 1);
      log.debug(
        `reply session initialization conflicted; retrying in ${backoffMs}ms (attempt ${attemptIndex + 2}/${maxAttempts})`,
      );
      // Cancellation must interrupt the wait itself; otherwise shutdown can
      // sleep through the backoff and start one more session-init attempt.
      await sleep(backoffMs, options?.signal);
    }
  }
}
