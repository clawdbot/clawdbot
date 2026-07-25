import { isSilentReplyText } from "../../auto-reply/tokens.js";
import { normalizeAgentRunAttemptTerminal } from "../agent-run-terminal-outcome.js";
import { resolveFinalAssistantVisibleText } from "../embedded-agent-runner/run/helpers.js";
import type {
  AgentHarnessAttemptResult,
  AgentHarnessSettledTurnFinalizationResult,
} from "./types.js";

const ALLOWED_SETTLED_FINALIZATION_RESULT_KEYS = new Set([
  "assistant",
  "usage",
  "assistantTranscriptOwned",
  "assistantTranscriptIdempotencyKey",
  "assistantMessageIndex",
  "diagnosticTrace",
]);

function assistantContainsToolCall(
  assistant: AgentHarnessSettledTurnFinalizationResult["assistant"],
): boolean {
  return assistant.content.some(
    (block) => block !== null && typeof block === "object" && block.type === "toolCall",
  );
}

/**
 * Validates the deliberately narrow finalizer result before core turns it into
 * a terminal reply. Capability and delivery fields cannot cross this contract.
 */
export function assertSettledTurnFinalizationResult(
  result: AgentHarnessSettledTurnFinalizationResult,
): AgentHarnessSettledTurnFinalizationResult {
  const unknownKey = Object.keys(result).find(
    (key) => !ALLOWED_SETTLED_FINALIZATION_RESULT_KEYS.has(key),
  );
  if (unknownKey) {
    throw new Error(`Settled-turn finalization returned unsupported result field: ${unknownKey}`);
  }
  if (!result.assistant || result.assistant.role !== "assistant") {
    throw new Error("Settled-turn finalization did not return an assistant message");
  }
  if (result.assistant.stopReason === "toolUse" || assistantContainsToolCall(result.assistant)) {
    throw new Error("Settled-turn finalization returned a tool call");
  }
  if (result.assistant.stopReason !== "stop") {
    throw new Error(
      `Settled-turn finalization returned unsuccessful stop reason: ${result.assistant.stopReason}`,
    );
  }
  if (
    result.assistantMessageIndex !== undefined &&
    (!Number.isSafeInteger(result.assistantMessageIndex) || result.assistantMessageIndex < 0)
  ) {
    throw new Error("Settled-turn finalization returned an invalid assistant message index");
  }
  resolveSettledTurnFinalizationText(result);
  return result;
}

export function resolveSettledTurnFinalizationText(
  result: AgentHarnessSettledTurnFinalizationResult,
): string {
  const text = resolveFinalAssistantVisibleText(result.assistant);
  if (!text || isSilentReplyText(text)) {
    throw new Error("Settled-turn finalization completed without a visible answer");
  }
  return text;
}

/**
 * Projects a harness-owned full attempt engine into the narrow finalization
 * contract, rejecting canonical failure or capability evidence first.
 */
export function projectSettledTurnFinalizationAttemptResult(
  result: AgentHarnessAttemptResult,
): AgentHarnessSettledTurnFinalizationResult {
  const terminal =
    "terminal" in result ? result.terminal : normalizeAgentRunAttemptTerminal(result);
  if (
    terminal.kind !== "ok" ||
    (result.compactionCount ?? 0) > 0 ||
    result.promptTimeoutOutcome ||
    result.preflightRecovery ||
    result.beforeAgentFinalizeRevisionReason ||
    result.codexAppServerFailure ||
    result.cloudCodeAssistFormatError
  ) {
    throw new Error("Settled-turn finalization attempt did not complete successfully");
  }
  if (
    result.toolMetas.length > 0 ||
    result.itemLifecycle.startedCount > 0 ||
    result.itemLifecycle.completedCount > 0 ||
    result.itemLifecycle.activeCount > 0 ||
    result.replayMetadata.hadPotentialSideEffects ||
    !result.replayMetadata.replaySafe ||
    result.currentAttemptReplayMetadata?.hadPotentialSideEffects ||
    (result.currentAttemptReplayMetadata && !result.currentAttemptReplayMetadata.replaySafe) ||
    (result.clientToolCalls?.length ?? 0) > 0 ||
    (result.acceptedSessionSpawns?.length ?? 0) > 0 ||
    result.didSendViaMessagingTool ||
    result.didDeliverSourceReplyViaMessageTool ||
    result.didSendDeterministicApprovalPrompt ||
    result.messagingToolSentTexts.length > 0 ||
    result.messagingToolSentMediaUrls.length > 0 ||
    result.messagingToolSentTargets.length > 0 ||
    (result.messagingToolSourceReplyPayloads?.length ?? 0) > 0 ||
    result.heartbeatToolResponse ||
    (result.toolMediaUrls?.length ?? 0) > 0 ||
    (result.hostOwnedToolMediaUrls?.length ?? 0) > 0 ||
    result.toolAudioAsVoice ||
    result.toolTrustedLocalMedia ||
    result.hasToolMediaBlockReply ||
    result.lastToolError ||
    (result.successfulCronAdds ?? 0) > 0 ||
    result.yieldDetected
  ) {
    throw new Error("Settled-turn finalization attempt reported capability activity");
  }
  const assistant = result.currentAttemptCompletedAssistant;
  if (!assistant) {
    throw new Error("Settled-turn finalization attempt returned no completed assistant message");
  }
  return assertSettledTurnFinalizationResult({
    assistant,
    ...(result.attemptUsage ? { usage: result.attemptUsage } : {}),
    ...(result.assistantTranscriptOwned
      ? {
          assistantTranscriptOwned: true,
          ...(result.assistantTranscriptIdempotencyKey
            ? { assistantTranscriptIdempotencyKey: result.assistantTranscriptIdempotencyKey }
            : {}),
        }
      : result.lastAssistantTextMessageIndex !== undefined
        ? { assistantMessageIndex: result.lastAssistantTextMessageIndex }
        : {}),
    ...(result.diagnosticTrace ? { diagnosticTrace: result.diagnosticTrace } : {}),
  });
}
