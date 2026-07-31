import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { isSilentReplyPayloadText } from "../../auto-reply/tokens.js";
import type { CronAssistantCompletion } from "../types.js";

const NON_FINAL_ASSISTANT_STOP_REASONS = new Set([
  "aborted",
  "error",
  "length",
  "restart",
  "timeout",
  "tool_calls",
  "tooluse",
]);

/** Builds the content-free public proof consumed by cron observers. */
export function buildCronAssistantCompletion(
  result: Pick<EmbeddedAgentRunResult, "meta" | "payloads">,
): CronAssistantCompletion {
  const calls = result.meta.toolSummary?.calls;
  const failures = result.meta.toolSummary?.failures;
  const observedToolCallCount =
    Number.isSafeInteger(calls) && (calls ?? -1) >= 0 ? (calls ?? 0) : 0;
  const toolFailureCount =
    Number.isSafeInteger(failures) && (failures ?? -1) >= 0 ? (failures ?? 0) : 0;
  const pendingToolCallCount = Array.isArray(result.meta.pendingToolCalls)
    ? result.meta.pendingToolCalls.length
    : 0;
  const toolCallCount = Math.max(observedToolCallCount, pendingToolCallCount);
  const stopReason = normalizeOptionalString(
    result.meta.stopReason ?? result.meta.completion?.stopReason,
  )?.toLowerCase();
  const finalAssistantText = normalizeOptionalString(result.meta.finalAssistantVisibleText);
  const finalAssistantVisible =
    finalAssistantText !== undefined && !isSilentReplyPayloadText(finalAssistantText);
  const hasStructuredError = (result.payloads ?? []).some((payload) => payload.isError === true);
  const stoppedBeforeFinal = stopReason ? NON_FINAL_ASSISTANT_STOP_REASONS.has(stopReason) : false;
  const toolCallDetected = toolCallCount > 0 || pendingToolCallCount > 0;
  const toolResultAccepted =
    toolCallDetected &&
    toolCallCount > 0 &&
    toolFailureCount === 0 &&
    pendingToolCallCount === 0 &&
    !hasStructuredError &&
    !stoppedBeforeFinal &&
    finalAssistantVisible;
  const finalUserVisibleResult =
    finalAssistantVisible &&
    !hasStructuredError &&
    !stoppedBeforeFinal &&
    pendingToolCallCount === 0 &&
    toolFailureCount === 0 &&
    (!toolCallDetected || toolResultAccepted);

  return {
    contractVersion: "openclaw.cron-assistant-completion.v1",
    toolCallDetected,
    toolResultAccepted,
    finalAssistantVisible,
    finalUserVisibleResult,
    toolCallCount,
    toolFailureCount,
  };
}
