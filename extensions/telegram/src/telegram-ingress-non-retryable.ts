// Telegram plugin module classifies non-retryable spooled dispatch failures.
import {
  collectErrorGraphCandidates,
  formatErrorMessage,
  readErrorName,
} from "openclaw/plugin-sdk/error-runtime";
import { isTelegramMessageDispatchReplayForgetError } from "./message-dispatch-dedupe.js";

const MISSING_AGENT_HARNESS_ERROR_NAME = "MissingAgentHarnessError";
const MISSING_AGENT_HARNESS_MESSAGE_RE = /Requested agent harness "[^"]+" is not registered\./u;

type TelegramIngressNonRetryableFailure = {
  reason: "missing-agent-harness" | "dispatch-dedupe-rollback-failed";
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
