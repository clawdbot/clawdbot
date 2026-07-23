// Telegram plugin module classifies non-retryable spooled dispatch failures.
import {
  collectErrorGraphCandidates,
  formatErrorMessage,
  readErrorName,
} from "openclaw/plugin-sdk/error-runtime";
import { isTelegramMessageDispatchReplayForgetError } from "./message-dispatch-dedupe.js";
import { TelegramIngressPayloadError } from "./telegram-ingress-spool.payload.js";

const MISSING_AGENT_HARNESS_ERROR_NAME = "MissingAgentHarnessError";
const MISSING_AGENT_HARNESS_MESSAGE_RE = /Requested agent harness "[^"]+" is not registered\./u;

type TelegramIngressNonRetryableFailure = {
  reason:
    | "invalid-event"
    | "missing-agent-harness"
    | "dispatch-dedupe-rollback-failed"
    | "recipient-unreachable";
  message: string;
};

/**
 * Patterns shared with outbound delivery-queue-recovery PERMANENT_ERROR_PATTERNS.
 * Keep the two lists aligned so ingress and outbound treat the same permanent
 * errors consistently.
 */
const PERMANENT_INGRESS_ERROR_PATTERNS: readonly RegExp[] = [
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
];

/** Channel-owned non-retryable predicate for the core ingress drain. */
export function resolveTelegramIngressNonRetryableFailure(
  err: unknown,
): TelegramIngressNonRetryableFailure | null {
  for (const candidate of collectErrorGraphCandidates(err, (current) => [
    current.cause,
    current.error,
  ])) {
    const message = formatErrorMessage(candidate);
    if (candidate instanceof TelegramIngressPayloadError) {
      return { reason: "invalid-event", message };
    }
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
    if (PERMANENT_INGRESS_ERROR_PATTERNS.some((re) => re.test(message))) {
      return { reason: "recipient-unreachable", message };
    }
  }
  return null;
}
