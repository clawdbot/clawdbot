import { copyReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import type { AssistantMessage } from "../../../llm/types.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import type { NormalizedUsage, UsageLike } from "../../usage.js";
import { resolveEmbeddedRunFailureSignal } from "../failure-signal.js";
import type { EmbeddedAgentMeta, EmbeddedAgentRunResult } from "../types.js";
import type { UsageAccumulator } from "../usage-accumulator.js";
import type { EmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import {
  buildUsageAgentMetaFields,
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
  resolveReportedModelRef,
} from "./helpers.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { buildTraceToolSummary } from "./run-attempt-result.js";
import { mergeAttemptToolMediaPayloads } from "./tool-media-payloads.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export function prepareEmbeddedRunTerminal(input: {
  runParams: RunEmbeddedAgentParams;
  attempt: EmbeddedRunAttemptResult;
  attemptAssistant?: AssistantMessage;
  currentAttemptAssistant?: AssistantMessage;
  provider: string;
  model: string;
  activeErrorContext: { provider: string; model: string };
  authProfileStore: AuthProfileStore;
  authProfileId?: string;
  sessionIdUsed: string;
  sessionFileUsed?: string;
  outerContextTokenMeta: { contextTokens?: number };
  usageAccumulator: UsageAccumulator;
  lastRunPromptUsage?: NormalizedUsage;
  lastTurnTotal?: number;
  contextRecoveryState: EmbeddedRunContextRecoveryState;
  resolvedToolResultFormat: NonNullable<RunEmbeddedAgentParams["toolResultFormat"]>;
  terminalInterrupted: boolean;
  terminalTimedOut: boolean;
  timedOutDuringCompaction: boolean;
  timedOutDuringToolExecution: boolean;
}): {
  agentMeta: EmbeddedAgentMeta;
  reportedModelRef: { provider: string; model: string };
  finalAssistantVisibleText: string | undefined;
  finalAssistantRawText: string | undefined;
  payloads: ReturnType<typeof buildEmbeddedRunPayloads>;
  payloadsWithToolMedia: ReturnType<typeof mergeAttemptToolMediaPayloads>;
  timedOutDuringPrompt: boolean;
  recoveredFinalAssistantPayloadsAfterPromptTimeout: EmbeddedAgentRunResult["payloads"];
  hasSuccessfulFinalAssistantAfterPromptTimeout: boolean;
  hasPartialAssistantTextAfterPromptTimeout: boolean;
  attemptToolSummary: ReturnType<typeof buildTraceToolSummary>;
  failureSignal: ReturnType<typeof resolveEmbeddedRunFailureSignal>;
} {
  const { runParams, attempt, attemptAssistant } = input;
  const timedOutDuringPrompt =
    input.terminalTimedOut && !input.timedOutDuringCompaction && !input.timedOutDuringToolExecution;
  // A prior same-model assistant can remain in the session snapshot. Timeout
  // recovery must project only output owned by the prompt that just timed out.
  const terminalAssistant = timedOutDuringPrompt ? input.currentAttemptAssistant : attemptAssistant;
  const usageMeta = buildUsageAgentMetaFields({
    usageAccumulator: input.usageAccumulator,
    lastAssistantUsage: terminalAssistant?.usage as UsageLike | undefined,
    lastRunPromptUsage: input.lastRunPromptUsage,
    lastTurnTotal: input.lastTurnTotal,
  });
  const reportedModelRef = resolveReportedModelRef({
    provider: input.provider,
    model: input.model,
    assistant: terminalAssistant,
  });
  const agentMeta: EmbeddedAgentMeta = {
    sessionId: input.sessionIdUsed,
    sessionFile: input.sessionFileUsed,
    provider: reportedModelRef.provider,
    model: reportedModelRef.model,
    ...input.outerContextTokenMeta,
    agentHarnessId: attempt.agentHarnessId,
    usage: usageMeta.usage,
    lastCallUsage: usageMeta.lastCallUsage,
    promptTokens: usageMeta.promptTokens,
    ...(input.contextRecoveryState.lastContextBudgetStatus
      ? { contextBudgetStatus: input.contextRecoveryState.lastContextBudgetStatus }
      : {}),
    compactionCount:
      input.contextRecoveryState.autoCompactionCount > 0
        ? input.contextRecoveryState.autoCompactionCount
        : undefined,
    compactionTokensAfter: input.contextRecoveryState.lastCompactionTokensAfter,
  };
  const finalAssistantVisibleText = resolveFinalAssistantVisibleText(terminalAssistant);
  const finalAssistantRawText = resolveFinalAssistantRawText(terminalAssistant);
  const payloads = buildEmbeddedRunPayloads({
    assistantTexts: attempt.assistantTexts,
    assistantMessageIndex: attempt.lastAssistantTextMessageIndex,
    assistantTranscriptOwned: attempt.assistantTranscriptOwned,
    toolMetas: attempt.toolMetas,
    lastAssistant: timedOutDuringPrompt ? input.currentAttemptAssistant : attempt.lastAssistant,
    currentAssistant: input.currentAttemptAssistant ?? null,
    lastToolError: attempt.lastToolError,
    config: runParams.config,
    isCronTrigger: runParams.trigger === "cron",
    isHeartbeatTrigger: runParams.trigger === "heartbeat",
    sessionKey: runParams.sessionKey ?? runParams.sessionId,
    provider: input.activeErrorContext.provider,
    model: input.activeErrorContext.model,
    authMode: input.authProfileId
      ? input.authProfileStore.profiles?.[input.authProfileId]?.type
      : undefined,
    verboseLevel: runParams.verboseLevel,
    reasoningLevel: runParams.reasoningLevel,
    thinkingLevel: runParams.thinkLevel,
    toolResultFormat: input.resolvedToolResultFormat,
    suppressToolErrorWarnings: runParams.suppressToolErrorWarnings,
    inlineToolResultsAllowed: false,
    didSendViaMessagingTool: attempt.didSendViaMessagingTool,
    didDeliverSourceReplyViaMessageTool: attempt.didDeliverSourceReplyViaMessageTool === true,
    messagingToolSentTargets: attempt.messagingToolSentTargets,
    messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
    sourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,
    agentId: runParams.agentId,
    runId: runParams.runId,
    runAborted: input.terminalInterrupted,
    didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
    heartbeatToolResponse: attempt.heartbeatToolResponse,
  });
  const payloadsWithToolMedia = mergeAttemptToolMediaPayloads({
    payloads,
    toolMediaUrls: attempt.toolMediaUrls,
    toolAudioAsVoice: attempt.toolAudioAsVoice,
    toolTrustedLocalMedia: attempt.toolTrustedLocalMedia,
    sourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,
  });
  const finalAssistantStopReason = (terminalAssistant?.stopReason ?? "").trim().toLowerCase();
  const recoveredFinalAssistantTextAfterPromptTimeout =
    timedOutDuringPrompt && ["completed", "end_turn", "stop"].includes(finalAssistantStopReason)
      ? (finalAssistantVisibleText ?? finalAssistantRawText)?.trim()
      : undefined;
  const payloadAlreadyContainsRecoveredFinalAssistant =
    recoveredFinalAssistantTextAfterPromptTimeout
      ? (payloadsWithToolMedia ?? []).some(
          (payload) =>
            payload?.isError !== true &&
            payload?.isReasoning !== true &&
            typeof payload.text === "string" &&
            payload.text.trim() === recoveredFinalAssistantTextAfterPromptTimeout,
        )
      : false;
  const recoveredFinalAssistantPayloadsAfterPromptTimeout =
    recoveredFinalAssistantTextAfterPromptTimeout && !payloadAlreadyContainsRecoveredFinalAssistant
      ? replacePartialAssistantPayload({
          payloads: payloadsWithToolMedia,
          assistantTexts: attempt.assistantTexts,
          recoveredText: recoveredFinalAssistantTextAfterPromptTimeout,
        })
      : undefined;
  const hasSuccessfulFinalAssistantAfterPromptTimeout =
    timedOutDuringPrompt &&
    Boolean(
      payloadAlreadyContainsRecoveredFinalAssistant ||
      recoveredFinalAssistantPayloadsAfterPromptTimeout?.length,
    );
  const hasPartialAssistantTextAfterPromptTimeout =
    timedOutDuringPrompt &&
    (attempt.assistantTexts ?? []).some((text) => text.trim().length > 0) &&
    !attempt.clientToolCalls &&
    !attempt.yieldDetected &&
    !attempt.didSendViaMessagingTool &&
    !attempt.didSendDeterministicApprovalPrompt &&
    !attempt.lastToolError &&
    (attempt.toolMetas?.length ?? 0) === 0;
  const attemptToolSummary = buildTraceToolSummary({
    toolMetas: attempt.toolMetas,
    fallbackHadFailure: Boolean(attempt.lastToolError),
  });
  const failureSignal = resolveEmbeddedRunFailureSignal({
    trigger: runParams.trigger,
    lastToolError: attempt.lastToolError,
  });
  return {
    agentMeta,
    reportedModelRef,
    finalAssistantVisibleText,
    finalAssistantRawText,
    payloads,
    payloadsWithToolMedia,
    timedOutDuringPrompt,
    recoveredFinalAssistantPayloadsAfterPromptTimeout,
    hasSuccessfulFinalAssistantAfterPromptTimeout,
    hasPartialAssistantTextAfterPromptTimeout,
    attemptToolSummary,
    failureSignal,
  };
}

function replacePartialAssistantPayload(input: {
  payloads: EmbeddedAgentRunResult["payloads"];
  assistantTexts?: string[];
  recoveredText: string;
}): NonNullable<EmbeddedAgentRunResult["payloads"]> {
  const payloads = input.payloads ? [...input.payloads] : [];
  const assistantTextSignatures = new Set(
    (input.assistantTexts ?? []).map((text) => text.trim()).filter((text) => text.length > 0),
  );
  // The attempt can contain completed assistant blocks before its partial tail.
  // Recover the latest matching payload or we can overwrite already-delivered text.
  const partialPayloadIndex = payloads.findLastIndex(
    (payload) =>
      payload.isError !== true &&
      payload.isReasoning !== true &&
      typeof payload.text === "string" &&
      assistantTextSignatures.has(payload.text.trim()),
  );
  if (partialPayloadIndex < 0) {
    return [...payloads, { text: input.recoveredText }];
  }
  const partialPayload = payloads[partialPayloadIndex];
  if (!partialPayload) {
    return [...payloads, { text: input.recoveredText }];
  }
  payloads[partialPayloadIndex] = copyReplyPayloadMetadata(partialPayload, {
    ...partialPayload,
    text: input.recoveredText,
  });
  return payloads;
}
