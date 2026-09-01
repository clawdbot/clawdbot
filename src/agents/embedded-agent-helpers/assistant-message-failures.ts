import type { AssistantMessage } from "../../llm/types.js";
import { isReplayUnsafeAssistantError } from "../../llm/utils/retry.js";
import { extractLeadingHttpStatus } from "../../shared/assistant-error-format.js";
import {
  classifyFailoverSignal,
  isAuthErrorMessage,
  isBillingErrorMessage,
  isRateLimitErrorMessage,
} from "../failover/classify.js";
import type { PreparedProviderFailoverOwner } from "../failover/provider-patterns.js";
import { extractFailoverSignalDetails } from "../failover/signal-details.js";
import type { FailoverReason, FailoverSignal } from "../failover/signal.js";
export function buildAssistantFailoverSignal(
  msg: AssistantMessage,
  opts?: { provider?: string },
): FailoverSignal {
  return {
    status: extractLeadingHttpStatus(msg.errorMessage?.trim() ?? "")?.code,
    code: msg.errorCode,
    errorType: msg.errorType,
    message: msg.errorMessage?.trim() || undefined,
    provider: opts?.provider ?? msg.provider,
    details: extractFailoverSignalDetails(msg.errorBody),
  };
}
export function classifyAssistantFailoverReason(
  msg: AssistantMessage | undefined,
  opts?: { provider?: string; providerOwner?: PreparedProviderFailoverOwner | null },
): FailoverReason | null {
  if (!msg || msg.stopReason !== "error" || isReplayUnsafeAssistantError(msg)) {
    return null;
  }
  // Runtime preparation carries the resolved owner here so packaged runs do
  // not rediscover provider policy through a source-relative loader.
  const providerOwner = opts?.providerOwner;
  const classification = classifyFailoverSignal(
    buildAssistantFailoverSignal(msg, { provider: providerOwner?.id ?? opts?.provider }),
    { providerPlugin: providerOwner },
  );
  return classification?.kind === "reason"
    ? classification.reason
    : classification
      ? "context_overflow"
      : null;
}
export function isRateLimitAssistantError(msg: AssistantMessage | undefined): boolean {
  return msg?.stopReason === "error" && isRateLimitErrorMessage(msg.errorMessage ?? "");
}
export function isBillingAssistantError(msg: AssistantMessage | undefined): boolean {
  return msg?.stopReason === "error" && isBillingErrorMessage(msg.errorMessage ?? "");
}
export function isAuthAssistantError(msg: AssistantMessage | undefined): boolean {
  return msg?.stopReason === "error" && isAuthErrorMessage(msg.errorMessage ?? "");
}
export function isFailoverAssistantError(msg: AssistantMessage | undefined): boolean {
  return classifyAssistantFailoverReason(msg) !== null;
}
