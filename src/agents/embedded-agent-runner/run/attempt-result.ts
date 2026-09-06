/**
 * Projects stream state into the stable embedded-attempt result contract.
 */
import { freezeDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { isTransientNetworkError } from "../../../infra/retryable-network-errors.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { isCloudCodeAssistFormatError } from "../../embedded-agent-helpers.js";
import type { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import type { AgentRuntimeModelAttempt } from "../../runtime-plan/types.js";
import { markCoreTtsAttemptResult } from "../../tools/tts-tool-result-provenance.js";
import { log } from "../logger.js";
import { observeReplayMetadata, replayMetadataFromState } from "../replay-state.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import { finalizeEmbeddedAttempt } from "./attempt-finalize.js";
import type { EmbeddedAttemptPromptState } from "./attempt-prompt-phase.js";
import { shouldRunLlmOutputHooksForAttempt } from "./attempt-run-decisions.js";
import type { PreparedStreamRuntime } from "./attempt-stream-runtime.types.js";
import type { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";
import {
  buildAttemptReplayMetadata,
  hasAttemptTerminalState,
} from "./attempt-terminal-evidence.js";
import { shouldTreatEmptyAssistantReplyAsSilent } from "./incomplete-turn-recovery.js";
import { resolveSilentToolResultReplyPayload } from "./incomplete-turn-resolution.js";
import type { EmbeddedAttemptClientToolCallSlot, EmbeddedRunAttemptResult } from "./types.js";

type EmbeddedAttemptSubscription = ReturnType<typeof subscribeEmbeddedAgentSession>;

/** Keeps attempt-owned state available while retry attempts replace their result object. */
export function createAttemptCarryover() {
  let latestMcpAppChannelView: EmbeddedRunAttemptResult["latestMcpAppChannelView"];
  let latestMcpConnectAction: EmbeddedRunAttemptResult["latestMcpConnectAction"];
  let modelAttempt: AgentRuntimeModelAttempt | undefined;
  return {
    apply(
      attempt: Pick<
        EmbeddedRunAttemptResult,
        "latestMcpAppChannelView" | "latestMcpConnectAction" | "modelAttempt"
      >,
    ): void {
      modelAttempt = attempt.modelAttempt;
      latestMcpAppChannelView = attempt.latestMcpAppChannelView ?? latestMcpAppChannelView;
      attempt.latestMcpAppChannelView = latestMcpAppChannelView;
      latestMcpConnectAction = attempt.latestMcpConnectAction ?? latestMcpConnectAction;
      attempt.latestMcpConnectAction = latestMcpConnectAction;
    },
    get modelAttempt() {
      return modelAttempt;
    },
  };
}

export type EmbeddedRunAttemptWithReceiptEvidence = EmbeddedRunAttemptResult & {
  successfulNestedToolNames?: string[];
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
  input: EmbeddedAttemptExecutionPhaseInput & { preparedStreamRuntime: PreparedStreamRuntime },
  settled: Awaited<ReturnType<typeof settleEmbeddedAttemptStream>>,
  prompt: EmbeddedAttemptPromptState &
    Pick<
      EmbeddedRunAttemptResult,
      "messagesSnapshot" | "sessionIdUsed" | "sessionFileUsed" | "beforeAgentFinalizeRevisionReason"
    >,
): EmbeddedRunAttemptWithReceiptEvidence {
  const { attempt } = input;
  const { sessionRuntime, bootstrap, systemPrompt } = input.prepared;
  const {
    agentSession: { clientToolCallSlots, hasDeliveredSourceReply, hookRunner },
    cacheTrace,
    trajectoryRecorder,
    transport: { streamStrategy },
  } = sessionRuntime;
  const { subscription, deferredLifecycleOwner } = input.preparedStreamRuntime.stream;
  const { bootstrapPromptWarning } = bootstrap;
  const promptCacheChangesForTurn = prompt.promptCacheChangesForTurn;
  const hookAgentId = input.setup.sessionAgentId;
  // Output hooks can reenter the runtime; project only the state settled before they run.
  const state = {
    terminal: input.state.terminal,
    preflightRecovery: prompt.preflightRecovery,
    sessionIdUsed: prompt.sessionIdUsed,
    sessionFileUsed: prompt.sessionFileUsed,
    diagnosticTrace: input.diagnostics.diagnosticTrace,
    systemPromptReport: systemPrompt.systemPromptReport,
    finalPromptText: prompt.finalPromptText,
    messagesSnapshot: prompt.messagesSnapshot,
    ...(prompt.beforeAgentFinalizeRevisionReason
      ? { beforeAgentFinalizeRevisionReason: prompt.beforeAgentFinalizeRevisionReason }
      : {}),
    lastAssistant: settled.lastAssistant,
    currentAttemptAssistant: settled.currentAttemptAssistant,
    currentAttemptCompletedAssistant: settled.currentAttemptCompletedAssistant,
    successfulNestedToolNames: settled.successfulNestedToolNames,
    attemptUsage: settled.attemptUsage,
    promptCache: sessionRuntime.state.promptCache,
    contextBudgetStatus: prompt.contextBudgetStatus,
    yieldDetected: input.lifecycle.readYieldState().yieldDetected,
    yieldAcknowledgment: input.lifecycle.readYieldState().yieldAcknowledgment,
    didDeliverSourceReplyViaMessageTool: hasDeliveredSourceReply(),
  };
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
    getToolAutoDeliveryMediaUrls,
    getReplayState,
    getSuccessfulCronAdds,
    getVisibleBlockReplyCount,
    hasToolMediaBlockReply,
    setTerminalLifecycleMeta,
    toolMetas,
  } = subscription;
  const toolMetasNormalized = normalizeEmbeddedAttemptToolMetas(toolMetas);

  if (input.preparedStreamRuntime.cache.observabilityEnabled) {
    const cacheBreak = settled.cacheBreak;
    if (cacheBreak) {
      const changeSummary =
        cacheBreak.changes?.map((change) => `${change.code}(${change.detail})`).join(", ") ??
        "no tracked cache input change";
      log.warn(
        `[prompt-cache] cache read dropped ${cacheBreak.previousCacheRead} -> ${cacheBreak.cacheRead} ` +
          `for ${attempt.provider}/${attempt.modelId} via ${streamStrategy}; ${changeSummary}`,
      );
      cacheTrace?.recordStage("cache:result", {
        options: {
          previousCacheRead: cacheBreak.previousCacheRead,
          cacheRead: cacheBreak.cacheRead,
          changes: cacheBreak.changes?.map((change) => ({
            code: change.code,
            detail: change.detail,
          })),
        },
      });
    } else if (cacheTrace && promptCacheChangesForTurn) {
      cacheTrace.recordStage("cache:result", {
        note: "state changed without a cache-read break",
        options: {
          cacheRead: state.attemptUsage?.cacheRead ?? 0,
          changes: promptCacheChangesForTurn.map((change) => ({
            code: change.code,
            detail: change.detail,
          })),
        },
      });
    } else if (cacheTrace) {
      cacheTrace.recordStage("cache:result", {
        note: "stable cache inputs",
        options: { cacheRead: state.attemptUsage?.cacheRead ?? 0 },
      });
    }
  }

  if (
    attempt.operation !== "settled-tool-finalization" &&
    hookRunner?.hasHooks("llm_output") &&
    shouldRunLlmOutputHooksForAttempt({ promptErrorSource: terminal.promptErrorSource })
  ) {
    const contextWindow = {
      ...(attempt.contextWindowInfo?.tokens
        ? { contextTokenBudget: attempt.contextWindowInfo.tokens }
        : {}),
      ...(attempt.contextWindowInfo?.source
        ? { contextWindowSource: attempt.contextWindowInfo.source }
        : {}),
      ...(attempt.contextWindowInfo?.referenceTokens
        ? { contextWindowReferenceTokens: attempt.contextWindowInfo.referenceTokens }
        : {}),
    };
    hookRunner
      .runLlmOutput(
        {
          runId: attempt.runId,
          sessionId: attempt.sessionId,
          provider: attempt.provider,
          model: attempt.modelId,
          ...contextWindow,
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
          agentId: hookAgentId,
          sessionKey: attempt.sessionKey,
          sessionId: attempt.sessionId,
          workspaceDir: attempt.workspaceDir,
          trigger: attempt.trigger,
          ...contextWindow,
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
  const messagingToolSentMediaUrls = getMessagingToolSentMediaUrls();
  const sentMediaUrls = new Set(messagingToolSentMediaUrls.map((url) => url.trim()));
  const toolAutoDeliveryMediaUrls = getToolAutoDeliveryMediaUrls().filter(
    (url) => !sentMediaUrls.has(url.trim()),
  );
  const replayEvidence = {
    toolMetas: toolMetasNormalized,
    didSendViaMessagingTool: didSendViaMessagingTool(),
    messagingToolSentTexts: getMessagingToolSentTexts(),
    messagingToolSentMediaUrls,
    acceptedSessionSpawns,
    successfulCronAdds: getSuccessfulCronAdds(),
  };
  // Structured start arguments already updated replayState for mutations and async work.
  // Reclassifying by tool name would incorrectly mark read-only cron actions as unsafe.
  const observedReplayMetadata = buildAttemptReplayMetadata({ ...replayEvidence, toolMetas: [] });
  const pendingToolMediaReply = getPendingToolMediaReply();
  const replayMetadata = replayMetadataFromState(
    observeReplayMetadata(getReplayState(), observedReplayMetadata),
  );
  const currentAttemptReplayMetadata = buildAttemptReplayMetadata(replayEvidence);
  const completedClientToolCalls = collectCompletedClientToolCalls(clientToolCallSlots);
  const clientToolCalls =
    completedClientToolCalls.length > 0 ? completedClientToolCalls : undefined;
  const didSendDeterministicApprovalPromptNow = didSendDeterministicApprovalPrompt();
  const lastToolError = getLastToolError();
  const heartbeatToolResponse = getHeartbeatToolResponse();
  const messagingToolSourceReplyPayloads = getMessagingToolSourceReplyPayloads();
  const hasToolMediaBlockReplyNow = hasToolMediaBlockReply();
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
    itemLifecycle: getItemLifecycle(),
    assistantTurns: getAssistantTurnCount(),
    setTerminalLifecycleMeta,
    bootstrapPromptWarningSignaturesSeen: bootstrapPromptWarning.warningSignaturesSeen,
    bootstrapPromptWarningSignature: bootstrapPromptWarning.signature,
    assistantTexts,
    latestMcpAppChannelView: getLatestMcpAppChannelView(),
    latestMcpConnectAction: getLatestMcpConnectAction(),
    lastAssistantTextMessageIndex: getLastAssistantTextMessageIndex(),
    toolMetas: toolMetasNormalized,
    acceptedSessionSpawns,
    lastToolError,
    didSendViaMessagingTool: replayEvidence.didSendViaMessagingTool,
    didSendDeterministicApprovalPrompt: didSendDeterministicApprovalPromptNow,
    messagingToolSentTexts: replayEvidence.messagingToolSentTexts,
    messagingToolSentMediaUrls,
    messagingToolSentTargets: getMessagingToolSentTargets(),
    messagingToolSourceReplyPayloads,
    heartbeatToolResponse,
    sourceReplyDelivered: subscription.getSourceReplyDelivered(),
    toolMediaUrls: pendingToolMediaReply?.mediaUrls,
    toolAudioAsVoice: pendingToolMediaReply?.audioAsVoice,
    toolTrustedLocalMedia: pendingToolMediaReply?.trustedLocalMedia,
    hasToolMediaBlockReply: hasToolMediaBlockReplyNow,
    successfulCronAdds: replayEvidence.successfulCronAdds,
    cloudCodeAssistFormatError: Boolean(
      state.lastAssistant?.errorMessage &&
      isCloudCodeAssistFormatError(state.lastAssistant.errorMessage),
    ),
    compactionCount: getCompactionCount(),
    compactionTokensAfter: getLastCompactionTokensAfter(),
    clientToolCalls,
    yieldDetected: state.yieldDetected || undefined,
  };
  const resultEvidence = { ...result, yieldDetected: state.yieldDetected };
  // The coarse messaging flag was never terminal evidence at this boundary.
  const { didSendViaMessagingTool: _coarseDelivery, ...terminalEvidence } = resultEvidence;
  const hasTerminalOutput = hasAttemptTerminalState(terminalEvidence);
  const pendingToolMediaPayloadCount = hasVisiblePendingToolMediaReply(pendingToolMediaReply)
    ? 1
    : 0;
  const visibleBlockReplyCount = getVisibleBlockReplyCount();
  const silentToolResultReplyPayload = resolveSilentToolResultReplyPayload({
    isCronTrigger: attempt.trigger === "cron",
    payloadCount: pendingToolMediaPayloadCount,
    aborted: terminal.aborted,
    timedOut: terminal.timedOut,
    attempt: resultEvidence,
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
    attempt: resultEvidence,
  });
  const resultWithAutoDeliveryMedia =
    toolAutoDeliveryMediaUrls.length > 0
      ? markCoreTtsAttemptResult(
          result,
          toolAutoDeliveryMediaUrls,
          attempt.admittedRunContext.operationalRunInstance,
        )
      : result;
  return finalizeEmbeddedAttempt({
    result: resultWithAutoDeliveryMedia,
    trajectoryRecorder,
    deferredLifecycleOwner,
    synthesizedPayloadCount,
    emptyAssistantReplyIsSilent,
    hasTerminalOutput,
    silentExpected: attempt.silentExpected,
  });
}
