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

/**
 * Confirms the candidate carries a Telegram Bot API error_code. Ingress
 * terminal classification must only fire for explicit API rejections, not for
 * unrelated dispatch errors that happen to contain the same message text.
 */
function isConfirmedTelegramApiClientError(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  const code = (candidate as { error_code?: unknown }).error_code;
  return typeof code === "number" && (code === 400 || code === 403);
}

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
    if (
      isConfirmedTelegramApiClientError(candidate) &&
      PERMANENT_INGRESS_ERROR_PATTERNS.some((re) => re.test(message))
    ) {
      return { reason: "recipient-unreachable", message };
    }
  }
  return null;
}
