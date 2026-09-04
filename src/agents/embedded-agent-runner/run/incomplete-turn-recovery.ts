/** Owns side-effect-sensitive retry and silent-reply recovery policy. */
import { isTerminalAssistantError } from "../../../llm/utils/retry.js";
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
  resolveCurrentAttemptAssistant,
} from "./attempt-terminal-evidence.js";
import {
  classifyAssistantTurn,
  hasOnlySilentAssistantReply,
  hasPositiveOutputTokenUsage,
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
  if (!assistant || assistant.stopReason !== "error" || isTerminalAssistantError(assistant)) {
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
  /** Silent classification can tolerate completed effects, never unfinished work or replay. */
  tolerateSideEffects?: boolean;
}): boolean {
  return Boolean(
    params.aborted ||
    params.timedOut ||
    params.attempt.terminal.kind === "failed" ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError ||
    hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns) ||
    hasAsyncActivity(params.attempt.toolMetas) ||
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
  // NO_REPLY is an authored outcome, not missing output: a successful reaction
  // can be the entire reply. Agents: classify it before the side-effect retry
  // guard, or it becomes a false missing-summary warning (or a repeated tool).
  // Actual failures, aborts and pending work still pass through the guards below.
  const terminalReplyOptional = params.terminalReplyExpectation === "optional";
  const assistant = resolveCurrentAttemptAssistant(params.attempt);
  const explicitSilentReply =
    params.payloadCount === 0 &&
    assistant?.stopReason !== "error" &&
    hasOnlySilentAssistantReply(params.attempt.assistantTexts);
  const tolerateSideEffects = terminalReplyOptional || explicitSilentReply;
  if (
    !params.allowEmptyAssistantReplyAsSilent ||
    shouldSkipNonVisibleTurnRetry({ ...params, tolerateSideEffects })
  ) {
    return false;
  }
  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) {
    return false;
  }
  if (explicitSilentReply) {
    return true;
  }
  // A visible turn owes a reply unless the model explicitly chose NO_REPLY.
  // Bare empty and reasoning-only stops are provider failures, even when the
  // conversation policy permits deliberate silence.
  if (params.onlyExplicitSilentReply || !terminalReplyOptional) {
    return false;
  }
  return classifyAssistantTurn(params).nonVisibleEligibleForSilentReply;
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

  const assistant = resolveCurrentAttemptAssistant(params.attempt);
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
type SettledToolResult = { toolCallId?: unknown; toolName?: unknown; isError?: unknown };

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

/** Proves settlement and intentional termination for the exact current-turn tool-call batch. */
export function resolveSettledToolBatchEvidence(attempt: IncompleteTurnAttempt) {
  const snapshot = attempt.messagesSnapshot ?? [];
  const latestUserIndex = snapshot.findLastIndex((message) => message.role === "user");
  let assistant = attempt.currentAttemptAssistant;
  let assistantIndex = assistant ? snapshot.indexOf(assistant) : -1;
  if (assistantIndex <= latestUserIndex || readSettledToolCalls(assistant).length === 0) {
    assistantIndex = snapshot.findLastIndex(
      (message, index) =>
        index > latestUserIndex &&
        message.role === "assistant" &&
        readSettledToolCalls(message).length > 0,
    );
    const candidate = assistantIndex >= 0 ? snapshot[assistantIndex] : undefined;
    assistant = candidate?.role === "assistant" ? candidate : undefined;
  }
  const requestedToolCalls = readSettledToolCalls(assistant);
  // Results must follow their owning assistant; session-wide reused ids cannot settle a new turn.
  const settledToolResults = new Map(
    (assistantIndex >= 0 ? snapshot.slice(assistantIndex + 1) : []).flatMap((message) => {
      const { toolCallId, toolName, isError } = message as SettledToolResult;
      return message.role === "toolResult" &&
        typeof toolCallId === "string" &&
        typeof toolName === "string"
        ? [[toolCallId, { toolName, isError: isError === true }] as const]
        : [];
    }),
  );
  // Transcript proof: every call in the batch has its result persisted. Nested
  // code-mode work (exec status "waiting") keeps lifecycle items active while
  // the outer result is already recorded, so this is the weaker of the two.
  const allToolCallsRecorded =
    requestedToolCalls.length > 0 &&
    requestedToolCalls.every(
      ({ id, name }) =>
        id !== null && name !== null && settledToolResults.get(id)?.toolName === name,
    );
  const allToolsProvenSettled =
    allToolCallsRecorded &&
    attempt.itemLifecycle.startedCount > 0 &&
    attempt.itemLifecycle.completedCount === attempt.itemLifecycle.startedCount &&
    attempt.itemLifecycle.activeCount === 0;
  // Producer-recorded fact from the tool completion handler: one of this batch's
  // exec results parked a Code Mode run, which is the only legitimate reason a
  // fully recorded batch still shows active lifecycle items.
  const parkedCodeModeRun =
    allToolCallsRecorded &&
    requestedToolCalls.some(({ id }) =>
      attempt.toolMetas.some(
        (entry) => entry.toolCallId === id && entry.codeModeSuspended === true,
      ),
    );
  const failedToolNames = new Set(
    requestedToolCalls.flatMap(({ id, name }) =>
      id !== null && name !== null && settledToolResults.get(id)?.isError === true ? [name] : [],
    ),
  );
  // ToolErrorSummary has no call id: its owner must match a failed result in the
  // proven terminal batch, or a stale/unrelated error could authorize continuation.
  const hasUnsettledToolError = Boolean(
    attempt.lastToolError &&
    (assistant?.stopReason !== "toolUse" ||
      !allToolsProvenSettled ||
      !failedToolNames.has(attempt.lastToolError.toolName)),
  );
  const intentionalTermination =
    allToolsProvenSettled &&
    assistant?.stopReason === "toolUse" &&
    failedToolNames.size === 0 &&
    !attempt.lastToolError &&
    !hasAsyncActivity(attempt.toolMetas) &&
    requestedToolCalls.every(({ id, name }) => {
      const metadata = attempt.toolMetas.findLast(
        (entry) => entry.toolCallId === id && entry.toolName === name,
      );
      return metadata?.terminate === true && metadata.isError !== true;
    });
  return {
    assistant,
    allToolCallsRecorded,
    allToolsProvenSettled,
    parkedCodeModeRun,
    failedToolNames,
    hasUnsettledToolError,
    intentionalTermination,
  };
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
  const { attempt } = params;
  const {
    assistant,
    allToolsProvenSettled,
    failedToolNames,
    hasUnsettledToolError,
    intentionalTermination,
  } = resolveSettledToolBatchEvidence(attempt);
  const terminal = attempt.terminal;
  const idlePromptTimeout =
    terminal.kind === "timeout" &&
    terminal.phase === "prompt" &&
    terminal.source === "idle" &&
    attempt.currentAttemptReplayMetadata?.hadPotentialSideEffects === true;
  const emptyStopAfterSettledTools = Boolean(
    params.allowEmptyStopContinuation &&
    attempt.currentAttemptAssistant?.stopReason === "stop" &&
    attempt.toolMetas.length > 0 &&
    attempt.toolMetas.every((tool) => tool.isError !== true && tool.asyncStarted !== true) &&
    attempt.itemLifecycle.startedCount > 0 &&
    attempt.itemLifecycle.completedCount === attempt.itemLifecycle.startedCount &&
    attempt.itemLifecycle.activeCount === 0 &&
    !hasAcceptedSessionSpawn(attempt.acceptedSessionSpawns) &&
    classifyAssistantTurn(params).emptyResponse,
  );
  if (
    params.payloadCount !== 0 ||
    (!params.allowEmptyStopContinuation && hasOnlySilentAssistantReply(attempt.assistantTexts)) ||
    params.hasTerminalToolPresentation ||
    params.aborted ||
    ((params.timedOut || terminal.kind === "timeout") && !idlePromptTimeout) ||
    (terminal.kind === "failed" && !attempt.settledTurnFinalizationContext) ||
    (assistant?.stopReason === "toolUse" ? !allToolsProvenSettled : !emptyStopAfterSettledTools) ||
    intentionalTermination ||
    hasUnsettledToolError ||
    hasAsyncActivity(attempt.toolMetas) ||
    hasAcceptedSessionSpawn(attempt.acceptedSessionSpawns) ||
    attempt.clientToolCalls ||
    attempt.yieldDetected ||
    attempt.didSendDeterministicApprovalPrompt
  ) {
    return null;
  }
  if (attempt.hasToolMediaBlockReply || hasCompletedMessagingToolDeliveryEvidence(attempt)) {
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
  return allToolsProvenSettled && failedToolNames.size > 0
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

  const assistantState = classifyAssistantTurn(params);
  if (!assistantState.emptyResponse) {
    return null;
  }

  const assistant = assistantState.assistant ?? null;
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
