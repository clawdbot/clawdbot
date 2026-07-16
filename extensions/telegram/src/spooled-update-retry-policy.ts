// Telegram plugin module shares spooled update retry policy.
import {
  collectErrorGraphCandidates,
  formatErrorMessage,
  readErrorName,
} from "openclaw/plugin-sdk/error-runtime";
import type { BackoffPolicy } from "openclaw/plugin-sdk/runtime-env";
import { computeBackoff } from "openclaw/plugin-sdk/runtime-env";
import { isTelegramMessageDispatchReplayForgetError } from "./message-dispatch-dedupe.js";
import type { TelegramSpooledUpdate } from "./telegram-ingress-spool.types.js";

export const TELEGRAM_SPOOLED_RETRY_MAX_ATTEMPTS = 8;
const TELEGRAM_SPOOLED_RETRY_DEAD_LETTER_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_SPOOLED_RETRY_BASE_MS = 1_000;
const TELEGRAM_SPOOLED_RETRY_MAX_MS = 3 * 60_000;
const TELEGRAM_SPOOLED_COMPLETION_RETRY_POLICY: BackoffPolicy = {
  initialMs: 250,
  maxMs: 5_000,
  factor: 2,
  jitter: 0.2,
};

const MISSING_AGENT_HARNESS_ERROR_NAME = "MissingAgentHarnessError";
const MISSING_AGENT_HARNESS_MESSAGE_RE = /Requested agent harness "[^"]+" is not registered\./u;

type NonRetryableSpooledUpdateFailure = {
  reason: "missing-agent-harness" | "dispatch-dedupe-rollback-failed";
  message: string;
};

export function resolveNonRetryableSpooledUpdateFailure(
  err: unknown,
): NonRetryableSpooledUpdateFailure | null {
  for (const candidate of collectErrorGraphCandidates(err, (current) => [
    current.cause,
    current.error,
  ])) {
    const message = formatErrorMessage(candidate);
    if (isTelegramMessageDispatchReplayForgetError(candidate)) {
      // A committed dispatch key that cannot be rolled back makes retry unsafe:
      // the next replay can be duplicate-suppressed and then deleted.
      return { reason: "dispatch-dedupe-rollback-failed", message };
    }
    if (
      readErrorName(candidate) === MISSING_AGENT_HARNESS_ERROR_NAME ||
      MISSING_AGENT_HARNESS_MESSAGE_RE.test(message)
    ) {
      return { reason: "missing-agent-harness", message };
    }
  }
  return null;
}

export function resolveSpooledUpdateRetryDelayMs(
  update: TelegramSpooledUpdate,
  now = Date.now(),
): number {
  const attempts = update.attempts ?? 0;
  if (!update.lastError || update.lastAttemptAt === undefined || attempts <= 0) {
    return 0;
  }
  const exponent = Math.min(attempts - 1, 8);
  const delayMs = Math.min(
    TELEGRAM_SPOOLED_RETRY_MAX_MS,
    TELEGRAM_SPOOLED_RETRY_BASE_MS * 2 ** exponent,
  );
  return Math.max(0, update.lastAttemptAt + delayMs - now);
}

export function resolveSpooledUpdateAttemptNumber(update: TelegramSpooledUpdate): number {
  return (update.attempts ?? 0) + 1;
}

export function resolveSpooledUpdatePersistenceRetryDelayMs(attempt: number): number {
  return computeBackoff(TELEGRAM_SPOOLED_COMPLETION_RETRY_POLICY, attempt);
}

export function shouldDeadLetterRetryableSpooledUpdate(
  update: TelegramSpooledUpdate,
  attempt: number,
  now = Date.now(),
): boolean {
  return (
    attempt >= TELEGRAM_SPOOLED_RETRY_MAX_ATTEMPTS &&
    now - update.receivedAt >= TELEGRAM_SPOOLED_RETRY_DEAD_LETTER_MIN_AGE_MS
  );
}
