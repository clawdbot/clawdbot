import { classifyFailoverSignal } from "../../agents/failover/classify.js";
import {
  extractFailoverHttpStatus,
  hasTransientRetryEvidence,
  shouldRetryFailoverSignal,
} from "../../agents/failover/retry-evidence.js";
import {
  PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
  PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
  type AssistantMessage,
} from "../types.js";

const REPLAY_UNSAFE_ASSISTANT_ERROR_CODES = new Set([
  PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
  PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
]);

/** True when replaying the failed assistant request could duplicate unknown provider output. */
export function isReplayUnsafeAssistantError(
  message: Pick<AssistantMessage, "errorCode"> | null | undefined,
): boolean {
  return Boolean(message?.errorCode && REPLAY_UNSAFE_ASSISTANT_ERROR_CODES.has(message.errorCode));
}

/** Classify transient provider/transport failures for outer retry policy. */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
  if (
    message.stopReason !== "error" ||
    !message.errorMessage ||
    isReplayUnsafeAssistantError(message)
  ) {
    return false;
  }
  const errorMessage = message.errorMessage.trim();
  const status = extractFailoverHttpStatus(errorMessage);
  const signal = {
    message: errorMessage,
    provider: message.provider,
    code: message.errorCode,
    errorType: message.errorType,
    ...(status === undefined ? {} : { status }),
  };
  const classification = classifyFailoverSignal(signal);
  const hasTransientEvidence = hasTransientRetryEvidence(signal);
  return shouldRetryFailoverSignal({ classification, hasTransientEvidence, signal });
}
