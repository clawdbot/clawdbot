/** Owns side-effect-sensitive retry and silent-reply recovery policy. */
import { isReplayUnsafeAssistantError } from "../../../llm/utils/retry.js";
import { hasAcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import { hasOnlyAssistantReasoningContent } from "../../replay-turn-classification.js";
import { TOOL_FAILURE_INSTRUCTION } from "../../tool-outcome-instructions.js";
import {
  hasCommittedMessagingToolDeliveryEvidence,
  hasCompletedMessagingToolDeliveryEvidence,
} from "../delivery-evidence.js";
import { isZeroUsageEmptyStopAssistantTurn } from "../empty-assistant-turn.js";
import {
  hasAsyncActivity,
  hasAttemptTerminalState,
  isCurrentAttemptReplaySafe,
} from "./attempt-terminal-evidence.js";
import {
  hasOnlySilentAssistantReply,
  hasPositiveOutputTokenUsage,
  isEmptyResponseAssistantTurn,
  isNonVisibleAssistantTurnEligibleForSilentReply,
  isOllamaIncompleteTurnProvider,
  isReasoningOnlyAssistantTurn,
  isUnsignedThinkingOnlyAssistantTurn,
  joinAssistantTexts,
  shouldApplyNonVisibleTurnRetryGuard,
  type IncompleteTurnAttempt,
} from "./incomplete-turn-classification.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

// Allow one immediate continuation plus one follow-up continuation before
// surfacing the existing incomplete-turn error path.
export const DEFAULT_REASONING_ONLY_RETRY_LIMIT = 2;
export const DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT = 1;
const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
const SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch.";

export function shouldRetrySilentErrorAssistantTurn(params: {
  attempt: Pick<
    EmbeddedRunAttemptResult,
    | "assistantTexts"
    | "clientToolCalls"
    | "yieldDetected"
    | "didSendDeterministicApprovalPrompt"
    | "heartbeatToolResponse"
    | "lastToolError"
    | "toolMediaUrls"
    | "toolAudioAsVoice"
    | "toolTrustedLocalMedia"
    | "didDeliverSourceReplyViaMessageTool"
    | "messagingToolSourceReplyPayloads"
    | "replayMetadata"
    | "currentAttemptReplayMetadata"
  >;
  assistant: EmbeddedRunAttemptResult["lastAssistant"] | null | undefined;
}): boolean {
  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) {
    return false;
  }
  if (hasAttemptTerminalState(params.attempt)) {
    return false;
  }
  // Current-attempt evidence avoids blocking on prior committed effects; older
  // harnesses retain the cumulative, fail-closed behavior.
  if (!isCurrentAttemptReplaySafe(params.attempt)) {
    return false;
  }

  const assistant = params.assistant;
  if (!assistant || assistant.stopReason !== "error" || isReplayUnsafeAssistantError(assistant)) {
    return false;
  }

  const content = (assistant as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  if (content.length === 0) {
    return !hasPositiveOutputTokenUsage(assistant);
  }

  return hasOnlyAssistantReasoningContent(assistant);
}

function shouldSkipNonVisibleTurnRetry(params: {
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
  /** Reply-optional silent classification tolerates committed side effects; retries never can. */
  tolerateSideEffects?: boolean;
}): boolean {
  return Boolean(
    params.aborted ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError ||
    hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns) ||
    (params.tolerateSideEffects !== true && params.attempt.replayMetadata.hadPotentialSideEffects),
  );
}

/** Allows configured silent handling for replay-safe empty, reasoning-only, or explicit silent turns. */
export function shouldTreatEmptyAssistantReplyAsSilent(params: {
  allowEmptyAssistantReplyAsSilent?: boolean;
  onlyExplicitSilentReply?: boolean;
  terminalReplyExpectation?: "required" | "optional";
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): boolean {
  // "optional" is the run consumer's declaration that no user-facing reply is
  // owed (e.g. cron without a delivery route). Silence after side-effecting
  // tools is intentional there; retry is replay-unsafe, so erroring would mark
  // successful tool-only runs as failures.
  const terminalReplyOptional = params.terminalReplyExpectation === "optional";
  if (
    !params.allowEmptyAssistantReplyAsSilent ||
    shouldSkipNonVisibleTurnRetry({ ...params, tolerateSideEffects: terminalReplyOptional })
  ) {
    return false;
  }
  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) {
    return false;
  }
  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (
    params.payloadCount === 0 &&
    assistant?.stopReason !== "error" &&
    hasOnlySilentAssistantReply(params.attempt.assistantTexts)
  ) {
    return true;
  }
  // A visible turn owes a reply unless the model explicitly chose NO_REPLY.
  // Bare empty and reasoning-only stops are provider failures, even when the
  // conversation policy permits deliberate silence.
  if (params.onlyExplicitSilentReply || !terminalReplyOptional) {
    return false;
  }
  return isNonVisibleAssistantTurnEligibleForSilentReply({
    payloadCount: params.payloadCount,
    attempt: params.attempt,
  });
}

/**
 * Builds the retry instruction for reasoning-only turns that consumed provider
 * output budget but produced no visible assistant text.
 */
export function resolveReasoningOnlyRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  executionContract?: string;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  if (shouldSkipNonVisibleTurnRetry(params)) {
    return null;
  }

  if (
    !shouldApplyNonVisibleTurnRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      executionContract: params.executionContract,
    })
  ) {
    return null;
  }

  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) {
    return null;
  }
  if (assistant?.stopReason === "error") {
    return null;
  }
  if (!isReasoningOnlyAssistantTurn(assistant) && !isUnsignedThinkingOnlyAssistantTurn(assistant)) {
    return null;
  }

  return REASONING_ONLY_RETRY_INSTRUCTION;
}

type SettledToolCall = { id: string | null; name: string | null };

function readSettledToolCalls(
  message: EmbeddedRunAttemptResult["currentAttemptAssistant"] | null | undefined,
): SettledToolCall[] {
  if (!Array.isArray(message?.content)) {
    return [];
  }
  return message.content.flatMap((item) => {
    const block = item as { type?: unknown; id?: unknown; name?: unknown } | null;
    return block?.type === "toolCall"
      ? [
          {
            id: typeof block.id === "string" ? block.id : null,
            name: typeof block.name === "string" ? block.name : null,
          },
        ]
      : [];
  });
}

/** Builds one fresh continuation after settled tools ended without a visible final answer. */
export function resolveSettledToolTerminalContinuationInstruction(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  executionContract?: string;
  allowEmptyStopContinuation?: boolean;
  payloadCount: number;
  hasTerminalToolPresentation?: boolean;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  const currentAttemptAssistant = params.attempt.currentAttemptAssistant;
  const snapshot = params.attempt.messagesSnapshot ?? [];
  const latestUserIndex = snapshot.findLastIndex((message) => message.role === "user");
  let assistant: EmbeddedRunAttemptResult["currentAttemptAssistant"] = currentAttemptAssistant;
  let assistantIndex = assistant ? snapshot.indexOf(assistant) : -1;
  if (assistantIndex <= latestUserIndex || readSettledToolCalls(assistant).length === 0) {
    assistantIndex = snapshot.findLastIndex(
      (message, index) =>
        index > latestUserIndex &&
        message.role === "assistant" &&
        readSettledToolCalls(message).length > 0,
    );
    const assistantCandidate = assistantIndex >= 0 ? snapshot[assistantIndex] : undefined;
    assistant = assistantCandidate?.role === "assistant" ? assistantCandidate : undefined;
  }
  const terminal = params.attempt.terminal;
  const idlePromptTimeout =
    terminal.kind === "timeout" &&
    terminal.phase === "prompt" &&
    terminal.source === "idle" &&
    params.attempt.currentAttemptReplayMetadata?.hadPotentialSideEffects === true;
  const emptyStopAfterSettledTools = Boolean(
    params.allowEmptyStopContinuation &&
    currentAttemptAssistant?.stopReason === "stop" &&
    params.attempt.toolMetas.length > 0 &&
    params.attempt.toolMetas.every((tool) => tool.isError !== true && tool.asyncStarted !== true) &&
    params.attempt.itemLifecycle.startedCount > 0 &&
    params.attempt.itemLifecycle.completedCount === params.attempt.itemLifecycle.startedCount &&
    params.attempt.itemLifecycle.activeCount === 0 &&
    !hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns) &&
    isEmptyResponseAssistantTurn({
      payloadCount: params.payloadCount,
      attempt: params.attempt,
    }),
  );
  // Idle is not proof of settlement: skipped or partially dispatched tools must
  // never be described as completed. Match each terminal call's id and owner to
  // its own current-batch result; a reported failure is settled, not successful.
  const requestedToolCalls = readSettledToolCalls(assistant);
  // Scan only results AFTER the terminal assistant: the snapshot spans the whole
  // session, and a prior turn's toolResult with a model-reused id would otherwise
  // prove "completion" for a batch that never dispatched. Assistant not found in
  // the snapshot fails closed to the existing incomplete-turn error.
  const settledToolResults = new Map(
    (assistantIndex >= 0 ? snapshot.slice(assistantIndex + 1) : []).flatMap((message) => {
      const result = message as {
        role?: unknown;
        toolCallId?: unknown;
        toolName?: unknown;
        isError?: unknown;
      };
      return result.role === "toolResult" &&
        typeof result.toolCallId === "string" &&
        typeof result.toolName === "string"
        ? [
            [
              result.toolCallId,
              { toolName: result.toolName, isError: result.isError === true },
            ] as const,
          ]
        : [];
    }),
  );
  const allToolsProvenSettled =
    params.attempt.itemLifecycle.startedCount > 0 &&
    params.attempt.itemLifecycle.completedCount === params.attempt.itemLifecycle.startedCount &&
    params.attempt.itemLifecycle.activeCount === 0 &&
    requestedToolCalls.length > 0 &&
    requestedToolCalls.every(
      ({ id, name }) =>
        id !== null && name !== null && settledToolResults.get(id)?.toolName === name,
    );
  const failedTerminalToolNames = new Set(
    requestedToolCalls.flatMap(({ id, name }) =>
      id !== null && name !== null && settledToolResults.get(id)?.isError === true ? [name] : [],
    ),
  );
  const hasSettledTerminalToolFailure = allToolsProvenSettled && failedTerminalToolNames.size > 0;
  const hasIntentionalTerminalToolBatch =
    allToolsProvenSettled &&
    requestedToolCalls.every(({ id, name }) =>
      params.attempt.toolMetas.some(
        (meta) => meta.toolCallId === id && meta.toolName === name && meta.terminate === true,
      ),
    );
  // ToolErrorSummary has no call id: its owner must match a failed result in the
  // proven terminal batch, or a stale/unrelated error could authorize finalization.
  const hasUnsettledToolError = Boolean(
    params.attempt.lastToolError &&
    (assistant?.stopReason !== "toolUse" ||
      !hasSettledTerminalToolFailure ||
      !failedTerminalToolNames.has(params.attempt.lastToolError.toolName)),
  );
  if (
    params.payloadCount !== 0 ||
    params.hasTerminalToolPresentation ||
    params.aborted ||
    ((params.timedOut || params.attempt.terminal.kind === "timeout") && !idlePromptTimeout) ||
    (terminal.kind === "failed" && !params.attempt.settledTurnFinalizationContext) ||
    (assistant?.stopReason === "toolUse" ? !allToolsProvenSettled : !emptyStopAfterSettledTools) ||
    hasIntentionalTerminalToolBatch ||
    hasUnsettledToolError ||
    hasAsyncActivity(params.attempt.toolMetas) ||
    hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns) ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt
  ) {
    return null;
  }
  if (hasCompletedMessagingToolDeliveryEvidence(params.attempt)) {
    return null;
  }
  if (
    !shouldApplyNonVisibleTurnRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      executionContract: params.executionContract,
    })
  ) {
    return null;
  }
  return hasSettledTerminalToolFailure
    ? `${SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION} ${TOOL_FAILURE_INSTRUCTION}`
    : SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION;
}

/**
 * Builds the retry instruction for empty assistant turns when the provider/model
 * is eligible for non-visible turn recovery.
 */
export function resolveEmptyResponseRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  executionContract?: string;
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  if (shouldSkipNonVisibleTurnRetry(params)) {
    return null;
  }

  if (
    !isEmptyResponseAssistantTurn({
      payloadCount: params.payloadCount,
      attempt: params.attempt,
    })
  ) {
    return null;
  }

  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;
  if (
    assistant?.stopReason === "stop" &&
    isOllamaIncompleteTurnProvider(params.provider) &&
    !hasPositiveOutputTokenUsage(assistant)
  ) {
    return null;
  }

  if (
    shouldApplyNonVisibleTurnRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      executionContract: params.executionContract,
    }) ||
    // Keep the generic zero-usage stop retry for providers that expose a
    // provider-neutral "nothing was generated" signal, even outside the
    // provider allowlist above.
    isZeroUsageEmptyStopAssistantTurn(assistant)
  ) {
    return EMPTY_RESPONSE_RETRY_INSTRUCTION;
  }

  return null;
}
