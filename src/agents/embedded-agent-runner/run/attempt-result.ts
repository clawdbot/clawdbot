/**
 * Projects stream state into the stable embedded-attempt result contract.
 */
import { freezeDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { isTransientNetworkError } from "../../../infra/retryable-network-errors.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { createCacheTrace } from "../../cache-trace.js";
import { isCloudCodeAssistFormatError } from "../../embedded-agent-helpers.js";
import type { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { log } from "../logger.js";
import type { PromptCacheBreak, PromptCacheChange } from "../prompt-cache-observability.js";
import { observeReplayMetadata, replayMetadataFromState } from "../replay-state.js";
import { finalizeEmbeddedAttempt } from "./attempt-finalize.js";
import { shouldRunLlmOutputHooksForAttempt } from "./attempt-run-decisions.js";
import {
  buildAttemptReplayMetadata,
  hasAttemptTerminalState,
} from "./attempt-terminal-evidence.js";
import type { EmbeddedAttemptDeferredLifecycleOwner } from "./deferred-lifecycle-owner.js";
import { shouldTreatEmptyAssistantReplyAsSilent } from "./incomplete-turn-recovery.js";
import { resolveSilentToolResultReplyPayload } from "./incomplete-turn-resolution.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
  EmbeddedRunAttemptTrajectoryRecorder,
} from "./types.js";

type EmbeddedAttemptSubscription = ReturnType<typeof subscribeEmbeddedAgentSession>;
type CacheTrace = ReturnType<typeof createCacheTrace>;
type HookRunner = ReturnType<typeof getGlobalHookRunner>;

/** Keeps presentation state sticky while retry attempts replace their result object. */
export function createMcpAttemptCarryover() {
  let latestMcpAppChannelView: EmbeddedRunAttemptResult["latestMcpAppChannelView"];
  let latestMcpConnectAction: EmbeddedRunAttemptResult["latestMcpConnectAction"];
  return {
    apply(
      attempt: Pick<EmbeddedRunAttemptResult, "latestMcpAppChannelView" | "latestMcpConnectAction">,
    ): void {
      latestMcpAppChannelView = attempt.latestMcpAppChannelView ?? latestMcpAppChannelView;
      attempt.latestMcpAppChannelView = latestMcpAppChannelView;
      latestMcpConnectAction = attempt.latestMcpConnectAction ?? latestMcpConnectAction;
      attempt.latestMcpConnectAction = latestMcpConnectAction;
    },
  };
}

export type EmbeddedRunAttemptWithReceiptEvidence = EmbeddedRunAttemptResult & {
  successfulNestedToolNames?: string[];
};

export type EmbeddedAttemptClientToolCallSlot = {
  toolCallId: string;
  name: string;
  params?: Record<string, unknown>;
  completed: boolean;
};

type EmbeddedAttemptResultState = Pick<
  EmbeddedRunAttemptWithReceiptEvidence,
  | "terminal"
  | "preflightRecovery"
  | "sessionIdUsed"
  | "sessionFileUsed"
  | "systemPromptReport"
  | "finalPromptText"
  | "messagesSnapshot"
  | "beforeAgentFinalizeRevisionReason"
  | "lastAssistant"
  | "currentAttemptAssistant"
  | "currentAttemptCompletedAssistant"
  | "codeModeReconciliationCandidate"
  | "successfulNestedToolNames"
  | "attemptUsage"
  | "promptCache"
  | "contextBudgetStatus"
  | "yieldDetected"
  | "yieldAcknowledgment"
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
  deferredLifecycleOwner?: EmbeddedAttemptDeferredLifecycleOwner;
};

/**
 * Captures the settled transcript the tool-free finalizer needs when a settled
 * post-tool turn dies on its final provider call. The consumer fails closed
 * without this context, so the attempt-result owner has to supply it; the codex
 * app-server harness already does the same for its own attempts.
 */
function resolveSettledTurnFinalizationContext(params: {
  assistantTexts: readonly string[];
  messagesSnapshot: EmbeddedRunAttemptResult["messagesSnapshot"];
  terminal: EmbeddedRunAttemptResult["terminal"];
}): EmbeddedRunAttemptResult["settledTurnFinalizationContext"] {
  // Only a transient final provider call can safely recover an already settled tool turn.
  if (
    params.terminal.kind !== "failed" ||
    params.terminal.source !== "prompt" ||
    params.terminal.timeoutObservation ||
    !isTransientNetworkError(params.terminal.error)
  ) {
    return undefined;
  }
  // A turn that already produced visible text has nothing to finalize, and a
  // turn without a tool result never settled one.
  if (!params.assistantTexts.every((text) => !text.trim())) {
    return undefined;
  }
  if (!params.messagesSnapshot.some((message) => message.role === "toolResult")) {
    return undefined;
  }
  return {
    source: "openclaw-transcript",
    messages: Object.freeze([...params.messagesSnapshot]),
  };
}

function normalizeEmbeddedAttemptToolMetas(
  entries: EmbeddedAttemptSubscription["toolMetas"],
): EmbeddedRunAttemptResult["toolMetas"] {
  return entries
    .filter(
      (entry): entry is EmbeddedAttemptSubscription["toolMetas"][number] & { toolName: string } =>
        typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
    )
    .map((entry) => {
      const normalized: EmbeddedRunAttemptResult["toolMetas"][number] = {
        toolName: entry.toolName,
        meta: entry.meta,
        replaySafe: entry.replaySafe === true,
      };
      if (entry.toolCallId) {
        normalized.toolCallId = entry.toolCallId;
      }
      if (typeof entry.isError === "boolean") {
        normalized.isError = entry.isError;
      }
      if (entry.terminate === true) {
        normalized.terminate = true;
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
      if (entry.codeModeSuspended === true) {
        normalized.codeModeSuspended = true;
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
): EmbeddedRunAttemptWithReceiptEvidence {
  const { attempt, state, subscription } = input;
  const terminal = projectAgentRunAttemptTerminal(state.terminal);
  const {
    assistantTexts,
    didSendDeterministicApprovalPrompt,
    didSendViaMessagingTool,
    getAcceptedSessionSpawns,
    getAssistantTurnCount,
    getCompactionCount,
    getHeartbeatToolResponse,
    getItemLifecycle,
    getLastAssistantTextMessageIndex,
    getLastCompactionTokensAfter,
    getLastToolError,
    getLatestMcpAppChannelView,
    getLatestMcpConnectAction,
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
    attempt.operation !== "settled-tool-finalization" &&
    input.hookRunner?.hasHooks("llm_output") &&
    shouldRunLlmOutputHooksForAttempt({ promptErrorSource: terminal.promptErrorSource })
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
    aborted: terminal.aborted,
    timedOut: terminal.timedOut,
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
    terminalReplyExpectation: attempt.terminalReplyExpectation,
    payloadCount: 0,
    aborted: terminal.aborted,
    timedOut: terminal.timedOut,
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
      messagesSnapshot: state.messagesSnapshot,
      toolMetas: toolMetasNormalized,
      replayMetadata,
      terminal: state.terminal,
    },
  });
  const settledTurnFinalizationContext = resolveSettledTurnFinalizationContext({
    assistantTexts,
    messagesSnapshot: state.messagesSnapshot,
    terminal: state.terminal,
  });
  const result: EmbeddedRunAttemptWithReceiptEvidence = {
    ...state,
    ...(settledTurnFinalizationContext ? { settledTurnFinalizationContext } : {}),
    replayMetadata,
    currentAttemptReplayMetadata,
    codeModeReconciliationCandidate: state.codeModeReconciliationCandidate,
    itemLifecycle: getItemLifecycle(),
    assistantTurns: getAssistantTurnCount(),
    setTerminalLifecycleMeta,
    bootstrapPromptWarningSignaturesSeen: input.bootstrapPromptWarning.warningSignaturesSeen,
    bootstrapPromptWarningSignature: input.bootstrapPromptWarning.signature,
    assistantTexts,
    latestMcpAppChannelView: getLatestMcpAppChannelView(),
    latestMcpConnectAction: getLatestMcpConnectAction(),
    lastAssistantTextMessageIndex: getLastAssistantTextMessageIndex(),
    toolMetas: toolMetasNormalized,
    successfulNestedToolNames: state.successfulNestedToolNames,
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
    yieldAcknowledgment: state.yieldAcknowledgment,
  };
  return finalizeEmbeddedAttempt({
    result,
    trajectoryRecorder: input.trajectoryRecorder,
    deferredLifecycleOwner: input.deferredLifecycleOwner,
    synthesizedPayloadCount,
    emptyAssistantReplyIsSilent,
    hasTerminalOutput,
    silentExpected: attempt.silentExpected,
  });
}
