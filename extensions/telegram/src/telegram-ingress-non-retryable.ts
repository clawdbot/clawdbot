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
// Only rejected recipients are permanent: other Telegram 403s can recover
// after chat permissions change and must remain eligible for retry.
const TELEGRAM_UNREACHABLE_RECIPIENT_RE =
  /\b403\b[\s\S]*\b(?:bot was blocked by the user|bot was kicked|user is deactivated)\b/iu;

type TelegramIngressNonRetryableFailure = {
  reason:
    | "invalid-event"
    | "missing-agent-harness"
    | "dispatch-dedupe-rollback-failed"
    | "recipient-unreachable";
  message: string;
};

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
    if (TELEGRAM_UNREACHABLE_RECIPIENT_RE.test(message)) {
      return { reason: "recipient-unreachable", message };
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
