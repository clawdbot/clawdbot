import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../../infra/backoff.js";
import { collectErrorGraphCandidates } from "../../infra/errors.js";
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

const SESSION_INIT_CONFLICT_MESSAGE_RE = /^reply session initialization conflicted for \S+$/u;

function isReplySessionInitConflictError(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) => [current.cause, current.error]).some(
    (candidate) =>
      candidate instanceof ReplySessionInitConflictError ||
      SESSION_INIT_CONFLICT_MESSAGE_RE.test(
        candidate instanceof Error ? candidate.message : String(candidate),
      ),
  );
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
    retryDelaysMs?: readonly number[];
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<T> {
  const retryDelaysMs = options?.retryDelaysMs;
  const maxRetries = Math.min(
    (options?.maxAttempts ??
      (retryDelaysMs ? retryDelaysMs.length + 1 : SESSION_INIT_CONFLICT_MAX_ATTEMPTS)) - 1,
    retryDelaysMs?.length ?? Number.POSITIVE_INFINITY,
  );
  const sleep = options?.sleep ?? sleepWithAbort;
  const signal = options?.signal;
  const isAborted = () => signal?.aborted === true;
  for (let attemptIndex = 0; ; attemptIndex += 1) {
    if (isAborted()) {
      throw signal?.reason;
    }
    try {
      return await attempt();
    } catch (error) {
      if (!isReplySessionInitConflictError(error) || attemptIndex >= maxRetries || isAborted()) {
        throw error;
      }
      const backoffMs =
        retryDelaysMs?.[attemptIndex] ??
        computeBackoff(SESSION_INIT_CONFLICT_BACKOFF_POLICY, attemptIndex + 1);
      log.debug(
        `reply session initialization conflicted; retrying in ${backoffMs}ms (attempt ${attemptIndex + 2}/${maxRetries + 1})`,
      );
      await sleep(backoffMs, signal);
    }
  }
}
