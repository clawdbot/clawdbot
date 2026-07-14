/**
 * Projects stream state into the stable embedded-attempt result contract.
 */
import { freezeDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type { createCacheTrace } from "../../cache-trace.js";
import { isCloudCodeAssistFormatError } from "../../embedded-agent-helpers.js";
import type { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { log } from "../logger.js";
import type { PromptCacheBreak, PromptCacheChange } from "../prompt-cache-observability.js";
import { observeReplayMetadata, replayMetadataFromState } from "../replay-state.js";
import { finalizeEmbeddedAttempt } from "./attempt-finalize.js";
import { shouldRunLlmOutputHooksForAttempt } from "./attempt.run-decisions.js";
import {
  buildAttemptReplayMetadata,
  hasAttemptTerminalState,
  resolveSilentToolResultReplyPayload,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./incomplete-turn.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
  EmbeddedRunAttemptTrajectoryRecorder,
} from "./types.js";

type EmbeddedAttemptSubscription = ReturnType<typeof subscribeEmbeddedAgentSession>;
type CacheTrace = ReturnType<typeof createCacheTrace>;
type HookRunner = ReturnType<typeof getGlobalHookRunner>;

export type EmbeddedAttemptClientToolCallSlot = {
  toolCallId: string;
  name: string;
  params?: Record<string, unknown>;
  completed: boolean;
};

type EmbeddedAttemptResultState = Pick<
  EmbeddedRunAttemptResult,
  | "aborted"
  | "externalAbort"
  | "timedOut"
  | "idleTimedOut"
  | "timedOutDuringCompaction"
  | "timedOutDuringToolExecution"
  | "timedOutByRunBudget"
  | "promptError"
  | "promptErrorSource"
  | "preflightRecovery"
  | "sessionIdUsed"
  | "sessionFileUsed"
  | "systemPromptReport"
  | "finalPromptText"
  | "messagesSnapshot"
  | "beforeAgentFinalizeRevisionReason"
  | "lastAssistant"
  | "currentAttemptAssistant"
  | "attemptUsage"
  | "promptCache"
  | "contextBudgetStatus"
  | "yieldDetected"
  | "didDeliverSourceReplyViaMessageTool"
> & {
  diagnosticTrace: DiagnosticTraceContext;
};

type CompleteEmbeddedAttemptResultInput = {
  attempt: EmbeddedRunAttemptParams;
  subscription: EmbeddedAttemptSubscription;
  state: EmbeddedAttemptResultState;
  clientToolCallSlots: readonly EmbeddedAttemptClientToolCallSlot[];
  hookRunner: HookRunner;
  hookAgentId: string;
  bootstrapPromptWarning: {
    warningSignaturesSeen?: string[];
    signature?: string;
  };
  cache: {
    observabilityEnabled: boolean;
    trace: CacheTrace;
    break: PromptCacheBreak | null;
    changesForTurn: PromptCacheChange[] | null;
    streamStrategy: string;
  };
  trajectoryRecorder?: EmbeddedRunAttemptTrajectoryRecorder | null;
};

function normalizeEmbeddedAttemptToolMetas(
  entries: EmbeddedAttemptSubscription["toolMetas"],
): EmbeddedRunAttemptResult["toolMetas"] {
  return entries
    .filter(
      (
        entry,
      ): entry is {
        toolName: string;
        meta?: string;
        replaySafe?: boolean;
        isError?: true;
        asyncStarted?: boolean;
        asyncTaskRunId?: string;
        asyncTaskId?: string;
      } => typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
    )
    .map((entry) => {
      const normalized: EmbeddedRunAttemptResult["toolMetas"][number] = {
        toolName: entry.toolName,
        meta: entry.meta,
        replaySafe: entry.replaySafe === true,
      };
      if (entry.isError === true) {
        normalized.isError = true;
      }
      if (entry.asyncStarted === true) {
        normalized.asyncStarted = true;
      }
      if (entry.asyncTaskRunId) {
        normalized.asyncTaskRunId = entry.asyncTaskRunId;
      }
      if (entry.asyncTaskId) {
        normalized.asyncTaskId = entry.asyncTaskId;
      }
      return normalized;
    });
}

function collectCompletedClientToolCalls(
  slots: readonly EmbeddedAttemptClientToolCallSlot[],
): NonNullable<EmbeddedRunAttemptResult["clientToolCalls"]> {
  return slots.flatMap((slot) =>
    slot.completed && slot.params ? [{ name: slot.name, params: slot.params }] : [],
  );
}

function hasVisiblePendingToolMediaReply(
  reply: { mediaUrls?: string[]; audioAsVoice?: boolean } | null | undefined,
): boolean {
  return Boolean(
    reply &&
    ((reply.mediaUrls ?? []).some((url) => url.trim().length > 0) || reply.audioAsVoice === true),
  );
}

/** Runs output hooks, classifies terminal effects, and returns the finalized attempt result. */
export function completeEmbeddedAttemptResult(
  input: CompleteEmbeddedAttemptResultInput,
): EmbeddedRunAttemptResult {
  const { attempt, state, subscription } = input;
  const {
    assistantTexts,
    didSendDeterministicApprovalPrompt,
    didSendViaMessagingTool,
    getAcceptedSessionSpawns,
    getCompactionCount,
    getHeartbeatToolResponse,
    getItemLifecycle,
    getLastAssistantTextMessageIndex,
    getLastCompactionTokensAfter,
    getLastToolError,
    getMessagingToolSentMediaUrls,
    getMessagingToolSentTargets,
    getMessagingToolSentTexts,
    getMessagingToolSourceReplyPayloads,
    getPendingToolMediaReply,
    getReplayState,
    getSuccessfulCronAdds,
    getVisibleBlockReplyCount,
    hasToolMediaBlockReply,
    setTerminalLifecycleMeta,
    toolMetas,
  } = subscription;
  const toolMetasNormalized = normalizeEmbeddedAttemptToolMetas(toolMetas);

  if (input.cache.observabilityEnabled) {
    const cacheBreak = input.cache.break;
    if (cacheBreak) {
      const changeSummary =
        cacheBreak.changes?.map((change) => `${change.code}(${change.detail})`).join(", ") ??
        "no tracked cache input change";
      log.warn(
        `[prompt-cache] cache read dropped ${cacheBreak.previousCacheRead} -> ${cacheBreak.cacheRead} ` +
          `for ${attempt.provider}/${attempt.modelId} via ${input.cache.streamStrategy}; ${changeSummary}`,
      );
      input.cache.trace?.recordStage("cache:result", {
        options: {
          previousCacheRead: cacheBreak.previousCacheRead,
          cacheRead: cacheBreak.cacheRead,
          changes: cacheBreak.changes?.map((change) => ({
            code: change.code,
            detail: change.detail,
          })),
        },
      });
    } else if (input.cache.trace && input.cache.changesForTurn) {
      input.cache.trace.recordStage("cache:result", {
        note: "state changed without a cache-read break",
        options: {
          cacheRead: state.attemptUsage?.cacheRead ?? 0,
          changes: input.cache.changesForTurn.map((change) => ({
            code: change.code,
            detail: change.detail,
          })),
        },
      });
    } else if (input.cache.trace) {
      input.cache.trace.recordStage("cache:result", {
        note: "stable cache inputs",
        options: { cacheRead: state.attemptUsage?.cacheRead ?? 0 },
      });
    }
  }

  if (
    input.hookRunner?.hasHooks("llm_output") &&
    shouldRunLlmOutputHooksForAttempt({ promptErrorSource: state.promptErrorSource })
  ) {
    input.hookRunner
      .runLlmOutput(
        {
          runId: attempt.runId,
          sessionId: attempt.sessionId,
          provider: attempt.provider,
          model: attempt.modelId,
          ...(attempt.contextWindowInfo?.tokens
            ? { contextTokenBudget: attempt.contextWindowInfo.tokens }
            : {}),
          ...(attempt.contextWindowInfo?.source
            ? { contextWindowSource: attempt.contextWindowInfo.source }
            : {}),
          ...(attempt.contextWindowInfo?.referenceTokens
            ? { contextWindowReferenceTokens: attempt.contextWindowInfo.referenceTokens }
            : {}),
          resolvedRef:
            attempt.runtimePlan?.observability.resolvedRef ??
            `${attempt.provider}/${attempt.modelId}`,
          ...(attempt.runtimePlan?.observability.harnessId
            ? { harnessId: attempt.runtimePlan.observability.harnessId }
            : {}),
          assistantTexts,
          lastAssistant: state.lastAssistant,
          usage: state.attemptUsage,
        },
        {
          runId: attempt.runId,
          trace: freezeDiagnosticTraceContext(state.diagnosticTrace),
          agentId: input.hookAgentId,
          sessionKey: attempt.sessionKey,
          sessionId: attempt.sessionId,
          workspaceDir: attempt.workspaceDir,
          trigger: attempt.trigger,
          ...(attempt.contextWindowInfo?.tokens
            ? { contextTokenBudget: attempt.contextWindowInfo.tokens }
            : {}),
          ...(attempt.contextWindowInfo?.source
            ? { contextWindowSource: attempt.contextWindowInfo.source }
            : {}),
          ...(attempt.contextWindowInfo?.referenceTokens
            ? { contextWindowReferenceTokens: attempt.contextWindowInfo.referenceTokens }
            : {}),
          ...buildAgentHookContextChannelFields(attempt),
          ...buildAgentHookContextIdentityFields({
            trigger: attempt.trigger,
            senderId: attempt.senderId,
            chatId: attempt.chatId,
            channelContext: attempt.channelContext,
          }),
        },
      )
      .catch((err: unknown) => {
        log.warn(`llm_output hook failed: ${String(err)}`);
      });
  }

  const acceptedSessionSpawns = getAcceptedSessionSpawns();
  const observedReplayMetadata = buildAttemptReplayMetadata({
    // Structured start arguments already updated replayState for mutations and async work.
    // Reclassifying by tool name would incorrectly mark read-only cron actions as unsafe.
    toolMetas: [],
    didSendViaMessagingTool: didSendViaMessagingTool(),
    messagingToolSentTexts: getMessagingToolSentTexts(),
    messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
    acceptedSessionSpawns,
    successfulCronAdds: getSuccessfulCronAdds(),
  });
  const pendingToolMediaReply = getPendingToolMediaReply();
  const replayMetadata = replayMetadataFromState(
    observeReplayMetadata(getReplayState(), observedReplayMetadata),
  );
  const currentAttemptReplayMetadata = buildAttemptReplayMetadata({
    toolMetas: toolMetasNormalized,
    didSendViaMessagingTool: didSendViaMessagingTool(),
    messagingToolSentTexts: getMessagingToolSentTexts(),
    messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
    acceptedSessionSpawns,
    successfulCronAdds: getSuccessfulCronAdds(),
  });
  const completedClientToolCalls = collectCompletedClientToolCalls(input.clientToolCallSlots);
  const clientToolCalls =
    completedClientToolCalls.length > 0 ? completedClientToolCalls : undefined;
  const didSendDeterministicApprovalPromptNow = didSendDeterministicApprovalPrompt();
  const lastToolError = getLastToolError();
  const heartbeatToolResponse = getHeartbeatToolResponse();
  const messagingToolSourceReplyPayloads = getMessagingToolSourceReplyPayloads();
  const hasToolMediaBlockReplyNow = hasToolMediaBlockReply();
  const hasTerminalOutput = hasAttemptTerminalState({
    clientToolCalls,
    yieldDetected: state.yieldDetected,
    didSendDeterministicApprovalPrompt: didSendDeterministicApprovalPromptNow,
    heartbeatToolResponse,
    lastToolError,
    toolMediaUrls: pendingToolMediaReply?.mediaUrls,
    toolAudioAsVoice: pendingToolMediaReply?.audioAsVoice,
    toolTrustedLocalMedia: pendingToolMediaReply?.trustedLocalMedia,
    hasToolMediaBlockReply: hasToolMediaBlockReplyNow,
    didDeliverSourceReplyViaMessageTool: state.didDeliverSourceReplyViaMessageTool,
    messagingToolSourceReplyPayloads,
    messagingToolSentTexts: getMessagingToolSentTexts(),
    messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
    messagingToolSentTargets: getMessagingToolSentTargets(),
    acceptedSessionSpawns,
    successfulCronAdds: getSuccessfulCronAdds(),
    toolMetas: toolMetasNormalized,
  });
  const pendingToolMediaPayloadCount = hasVisiblePendingToolMediaReply(pendingToolMediaReply)
    ? 1
    : 0;
  const visibleBlockReplyCount = getVisibleBlockReplyCount();
  const silentToolResultReplyPayload = resolveSilentToolResultReplyPayload({
    isCronTrigger: attempt.trigger === "cron",
    payloadCount: pendingToolMediaPayloadCount,
    aborted: state.aborted,
    timedOut: state.timedOut,
    attempt: {
      clientToolCalls,
      yieldDetected: state.yieldDetected,
      didSendDeterministicApprovalPrompt: didSendDeterministicApprovalPromptNow,
      lastToolError,
      messagesSnapshot: state.messagesSnapshot,
      toolMetas: toolMetasNormalized,
    },
  });
  const synthesizedPayloadCount =
    visibleBlockReplyCount +
    pendingToolMediaPayloadCount +
    messagingToolSourceReplyPayloads.length +
    (silentToolResultReplyPayload ? 1 : 0);
  const emptyAssistantReplyIsSilent = shouldTreatEmptyAssistantReplyAsSilent({
    allowEmptyAssistantReplyAsSilent: attempt.allowEmptyAssistantReplyAsSilent,
    payloadCount: 0,
    aborted: state.aborted,
    timedOut: state.timedOut,
    attempt: {
      assistantTexts,
      clientToolCalls,
      currentAttemptAssistant: state.currentAttemptAssistant,
      yieldDetected: state.yieldDetected,
      didSendDeterministicApprovalPrompt: didSendDeterministicApprovalPromptNow,
      didSendViaMessagingTool: didSendViaMessagingTool(),
      messagingToolSentTexts: getMessagingToolSentTexts(),
      messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
      messagingToolSentTargets: getMessagingToolSentTargets(),
      acceptedSessionSpawns,
      lastToolError,
      lastAssistant: state.lastAssistant,
      itemLifecycle: getItemLifecycle(),
      toolMetas: toolMetasNormalized,
      replayMetadata,
      promptErrorSource: state.promptErrorSource,
      timedOutDuringCompaction: state.timedOutDuringCompaction,
    },
  });
  const result: EmbeddedRunAttemptResult = {
    ...state,
    replayMetadata,
    currentAttemptReplayMetadata,
    itemLifecycle: getItemLifecycle(),
    setTerminalLifecycleMeta,
    bootstrapPromptWarningSignaturesSeen: input.bootstrapPromptWarning.warningSignaturesSeen,
    bootstrapPromptWarningSignature: input.bootstrapPromptWarning.signature,
    assistantTexts,
    lastAssistantTextMessageIndex: getLastAssistantTextMessageIndex(),
    toolMetas: toolMetasNormalized,
    acceptedSessionSpawns,
    lastToolError,
    didSendViaMessagingTool: didSendViaMessagingTool(),
    didSendDeterministicApprovalPrompt: didSendDeterministicApprovalPromptNow,
    messagingToolSentTexts: getMessagingToolSentTexts(),
    messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
    messagingToolSentTargets: getMessagingToolSentTargets(),
    messagingToolSourceReplyPayloads,
    heartbeatToolResponse,
    toolMediaUrls: pendingToolMediaReply?.mediaUrls,
    toolAudioAsVoice: pendingToolMediaReply?.audioAsVoice,
    toolTrustedLocalMedia: pendingToolMediaReply?.trustedLocalMedia,
    hasToolMediaBlockReply: hasToolMediaBlockReplyNow,
    successfulCronAdds: getSuccessfulCronAdds(),
    cloudCodeAssistFormatError: Boolean(
      state.lastAssistant?.errorMessage &&
      isCloudCodeAssistFormatError(state.lastAssistant.errorMessage),
    ),
    compactionCount: getCompactionCount(),
    compactionTokensAfter: getLastCompactionTokensAfter(),
    clientToolCalls,
    yieldDetected: state.yieldDetected || undefined,
  };
  return finalizeEmbeddedAttempt({
    result,
    trajectoryRecorder: input.trajectoryRecorder,
    synthesizedPayloadCount,
    emptyAssistantReplyIsSilent,
    hasTerminalOutput,
    silentExpected: attempt.silentExpected,
  });
}
