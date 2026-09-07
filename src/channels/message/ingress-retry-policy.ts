/**
 * Generic ingress retry backoff and dead-letter decisions.
 *
 * Channel-specific non-retryable classification stays out of core; pass it in.
 */
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import {
  SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE,
  SESSION_WORK_START_CHANGED_ERROR_CODE,
} from "../../config/sessions/work-start-error.js";
import { computeBackoff } from "../../infra/backoff.js";

export const DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS = 8;
export const DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_INGRESS_RETRY_BASE_MS = 1_000;
export const DEFAULT_INGRESS_RETRY_MAX_MS = 3 * 60_000;

export type IngressRetryPolicyConfig = {
  maxAttempts?: number;
  deadLetterMinAgeMs?: number;
  baseMs?: number;
  maxMs?: number;
};

type IngressRetryEventFacts = {
  receivedAt: number;
  attempts?: number;
  lastAttemptAt?: number;
  lastError?: string;
};

export type IngressNonRetryableFailure = {
  reason: string;
  message: string;
};

type IngressFailureDisposition =
  | {
      kind: "fail";
      reason: string;
      message: string;
      attempt: number;
    }
  | {
      kind: "release";
      attempt: number;
      message: string;
    };

function resolveConfig(config?: IngressRetryPolicyConfig) {
  return {
    maxAttempts: config?.maxAttempts ?? DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
    deadLetterMinAgeMs: config?.deadLetterMinAgeMs ?? DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
    baseMs: config?.baseMs ?? DEFAULT_INGRESS_RETRY_BASE_MS,
    maxMs: config?.maxMs ?? DEFAULT_INGRESS_RETRY_MAX_MS,
  };
}

/** Next attempt number after a failed dispatch (1-based for the attempt just finished). */
function resolveIngressAttemptNumber(event: IngressRetryEventFacts): number {
  return (event.attempts ?? 0) + 1;
}

/** Remaining backoff delay before a released event may be claimed again. */
export function resolveIngressRetryDelayMs(
  event: IngressRetryEventFacts,
  config?: IngressRetryPolicyConfig,
  now = Date.now(),
): number {
  const { baseMs, maxMs } = resolveConfig(config);
  const attempts = event.attempts ?? 0;
  if (!event.lastError || event.lastAttemptAt === undefined || attempts <= 0) {
    return 0;
  }
  const delayMs = computeBackoff(
    { initialMs: baseMs, maxMs, factor: 2, jitter: 0 },
    Math.min(attempts, 9),
  );
  return Math.max(0, event.lastAttemptAt + delayMs - now);
}

/**
 * Dead-letter requires BOTH attempt floor and minimum age.
 * Over-limit events keep retrying at the capped delay until age is met.
 */
export function shouldDeadLetterRetryableIngressEvent(
  event: IngressRetryEventFacts,
  attempt: number,
  config?: IngressRetryPolicyConfig,
  now = Date.now(),
): boolean {
  const { maxAttempts, deadLetterMinAgeMs } = resolveConfig(config);
  return attempt >= maxAttempts && now - event.receivedAt >= deadLetterMinAgeMs;
}

/** Resolve release vs fail for a dispatch error using optional non-retryable hook. */
export function resolveIngressFailureDisposition(params: {
  err: unknown;
  event: IngressRetryEventFacts;
  formatError: (err: unknown) => string;
  resolveNonRetryableFailure?: (err: unknown) => IngressNonRetryableFailure | null;
  config?: IngressRetryPolicyConfig;
  now?: number;
}): IngressFailureDisposition {
  const now = params.now ?? Date.now();
  const { maxAttempts } = resolveConfig(params.config);
  const attempt = resolveIngressAttemptNumber(params.event);
  const message = params.formatError(params.err);
  const nonRetryable = params.resolveNonRetryableFailure?.(params.err) ?? null;
  if (nonRetryable) {
    return {
      kind: "fail",
      reason: nonRetryable.reason,
      message: nonRetryable.message,
      attempt,
    };
  }
  const errorCodes = new Set(collectNestedErrorCandidates(params.err).map(extractErrorCode));
  // Retrying this terminal generation blocks the authorized reset behind it.
  if (errorCodes.has(SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE)) {
    return {
      kind: "fail",
      reason: "restart-recovery-tombstone",
      message,
      attempt,
    };
  }
  if (attempt >= maxAttempts && errorCodes.has(SESSION_WORK_START_CHANGED_ERROR_CODE)) {
    return {
      kind: "fail",
      reason: "session-start-conflict-retry-limit",
      message,
      attempt,
    };
  }
  if (shouldDeadLetterRetryableIngressEvent(params.event, attempt, params.config, now)) {
    return {
      kind: "fail",
      reason: "retry-limit-exceeded",
      message,
      attempt,
    };
  }
  return { kind: "release", attempt, message };
}
