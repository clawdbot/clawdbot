import { isProviderRefusalAssistantError } from "@openclaw/llm-core/diagnostics";
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

/**
 * Preserve structured terminal outcomes before text classification.
 * Replay could duplicate unknown output or override the provider's refusal.
 */
export function isTerminalAssistantError(
  message: Pick<AssistantMessage, "diagnostics" | "errorCode"> | null | undefined,
): boolean {
  return (
    Boolean(message?.errorCode && REPLAY_UNSAFE_ASSISTANT_ERROR_CODES.has(message.errorCode)) ||
    isProviderRefusalAssistantError(message)
  );
}

/** Classify transient provider/transport failures for outer retry policy. */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
  if (
    message.stopReason !== "error" ||
    !message.errorMessage ||
    isTerminalAssistantError(message)
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
