import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasCompletedSourceReplyDeliveryEvidence,
  hasCompletedTerminalDeliveryEvidence,
  hasVisibleOutboundDeliveryEvidence,
} from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { hasDeliberateSilentTerminalReply } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import { deriveContextPromptTokens, hasNonzeroUsage } from "../../agents/usage.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import { buildFallbackClearedNotice, buildFallbackNotice } from "../fallback-state.js";
import {
  isReplyPayloadStatusNotice,
  markReplyPayloadForSourceSuppressionDelivery,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  buildSilentFallbackFailurePayload,
  enqueueCommitmentExtractionForTurn,
  hasSuccessfulSourceReplyDelivery,
  hasSuccessfulTerminalSourceReplyDelivery,
  refreshSessionEntryFromStore,
  resolveSourceReplyPolicy,
} from "./agent-runner-core.js";
import { buildEmptyInteractiveReplyPayload } from "./agent-runner-failure-reply.js";
import { signalTypingIfNeeded } from "./agent-runner-helpers.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import {
  appendUnscheduledReminderNote,
  hasSessionRelatedCronJobs,
  hasUnbackedReminderCommitment,
} from "./agent-runner-reminder-guard.js";
import type { accountReplyAgentRun } from "./agent-runner-result-accounting.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { resolveResponseUsageLine } from "./agent-runner-usage-line.js";
import { attachMcpAppChannelAction } from "./mcp-app-channel-action.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { resolveOriginMessageTo } from "./origin-routing.js";
import { createReplyToModeFilterForChannel } from "./reply-threading.js";
import { buildStrandedReplyDeliveryFailurePayload } from "./stranded-reply-recovery.js";
type ReplyAgentAccounting = Awaited<ReturnType<typeof accountReplyAgentRun>>;

export async function prepareReplyAgentPayloads(state: {
  context: FinalizeReplyAgentRunInput;
  accounting: ReplyAgentAccounting;
}) {
  const { context, accounting } = state;
  const {
    activeSessionStore,
    blockReplyPipeline,
    blockStreamingEnabled,
    cfg,
    commandBody,
    followupRun,
    isHeartbeat,
    opts,
    replyMediaContext,
    replyOperation,
    replyRouteThreadId,
    replyThreadingOverride,
    replyToChannel,
    replyToMode,
    returnWithQueuedFollowupDrain,
    runStartedAt,
    runtimePolicySessionKey,
    sessionCtx,
    sessionKey,
    storePath,
    typingSignals,
  } = context;
  const {
    configuredFallbackModel,
    contextTokensUsed,
    directlySentBlockKeys,
    directlySentBlockPayloads,
    fallbackAttempts,
    fallbackExhausted,
    fallbackTransition,
    hasBillableUsageBuckets,
    modelUsed,
    payloadArray,
    preserveUserFacingSessionState,
    promptTokens,
    providerUsed,
    replyUsageState,
    runId,
    runResult,
    selectedModel,
    selectedProvider,
    terminalFailurePayload,
    usage,
    verboseEnabled,
  } = accounting;
  let { activeSessionEntry, didLogHeartbeatStrip } = accounting;

  const successfulSourceReplyDelivery = hasSuccessfulSourceReplyDelivery({
    blockReplyPipeline,
    directlySentBlockKeys,
    messagingToolSentTexts: runResult.messagingToolSentTexts,
    messagingToolSentMediaUrls: runResult.messagingToolSentMediaUrls,
    messagingToolSentTargets: runResult.messagingToolSentTargets,
  });
  const committedMessagingToolSourceReplyDelivery =
    hasCommittedSourceReplyDeliveryEvidence(runResult);
  const completedSourceReplyDelivery = hasCompletedSourceReplyDeliveryEvidence(runResult);
  const visibleOutboundDelivery = hasVisibleOutboundDeliveryEvidence(runResult);
  const successfulSideEffectDelivery =
    successfulSourceReplyDelivery ||
    committedMessagingToolSourceReplyDelivery ||
    visibleOutboundDelivery ||
    runResult.didSendDeterministicApprovalPrompt === true;
  const successfulTerminalDelivery =
    hasSuccessfulTerminalSourceReplyDelivery({
      blockReplyPipeline,
      directlySentBlockPayloads,
    }) || hasCompletedTerminalDeliveryEvidence(runResult);
  // Compaction notices are progress, not a terminal reply. Dispatcher-backed
  // delivery settles after this run returns, so it cannot prove turn completion here.
  const shouldDeliverTerminalFailure = Boolean(
    terminalFailurePayload && !successfulTerminalDelivery,
  );
  const fallbackFailureKnown =
    fallbackAttempts.length > 0 || configuredFallbackModel.persistedAutoFallback;
  const hasSpecificFallbackFailure = fallbackTransition.fallbackActive && fallbackFailureKnown;
  const emptyInteractiveReplyPayload = terminalFailurePayload
    ? undefined
    : buildEmptyInteractiveReplyPayload({
        isInteractive:
          followupRun.currentInboundEventKind !== "room_event" &&
          (followupRun.run.inputProvenance?.kind === undefined ||
            followupRun.run.inputProvenance.kind === "external_user"),
        isHeartbeat,
        silentExpected: followupRun.run.silentExpected,
        allowEmptyAssistantReplyAsSilent: followupRun.run.allowEmptyAssistantReplyAsSilent,
        isMessageToolOnly:
          (opts?.sourceReplyDeliveryMode ?? followupRun.run.sourceReplyDeliveryMode) ===
          "message_tool_only",
        hasPendingContinuation:
          runResult.meta?.yielded === true || (runResult.meta?.pendingToolCalls?.length ?? 0) > 0,
        hasExplicitSilentReply: hasDeliberateSilentTerminalReply(runResult),
        hasCommittedDelivery: successfulTerminalDelivery,
        sessionCtx,
        cfg,
      });
  const buildStrandedRetryMissingDeliveryDiagnostic = (): ReplyPayload | undefined => {
    if (!sessionKey || !storePath || followupRun.strandedReplyRetry !== true) {
      return undefined;
    }
    if (sessionCtx.InboundEventKind === "room_event" || completedSourceReplyDelivery) {
      return undefined;
    }
    const sourceReplyPolicy = resolveSourceReplyPolicy({
      cfg,
      sessionCtx,
      sessionEntry: activeSessionEntry,
      sessionKey,
      runtimePolicySessionKey,
      opts,
    });
    if (
      sourceReplyPolicy.sourceReplyDeliveryMode !== "message_tool_only" ||
      sourceReplyPolicy.sendPolicyDenied
    ) {
      return undefined;
    }
    return buildStrandedReplyDeliveryFailurePayload();
  };
  if (opts?.sourceReplyDeliveryMode === "message_tool_only" && completedSourceReplyDelivery) {
    await opts.onObservedReplyDelivery?.();
  }
  const currentMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
  // A terminal fallback is built separately after normal payload filtering.
  // Share this state across deliverable lanes so replyToMode=first still threads
  // at most one visible payload without hidden reasoning/commentary consuming it.
  const applyDeliveredReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const applyFinalReplyToMode = (payload: ReplyPayload) => {
    const isDisabledReasoningLane =
      payload.isReasoning === true && opts?.reasoningPayloadsEnabled !== true;
    const isDisabledCommentaryLane =
      payload.isCommentary === true && opts?.commentaryPayloadsEnabled !== true;
    const isFilteredPayload =
      normalizeReplyPayload(payload, { applyChannelTransforms: false }) === null;
    return isDisabledReasoningLane || isDisabledCommentaryLane || isFilteredPayload
      ? payload
      : applyDeliveredReplyToMode(payload);
  };
  const buildFinalPayloads = (payloads: ReplyPayload[]) =>
    buildReplyPayloads({
      config: cfg,
      payloads,
      isHeartbeat,
      didLogHeartbeatStrip,
      silentExpected: followupRun.run.silentExpected,
      blockStreamingEnabled,
      blockReplyPipeline,
      directlySentBlockKeys,
      directlySentBlockPayloads,
      replyToMode,
      replyToChannel,
      currentMessageId,
      replyThreading: replyThreadingOverride ?? sessionCtx.ReplyThreading,
      applyReplyToMode: applyFinalReplyToMode,
      messageProvider: followupRun.run.messageProvider,
      messagingToolSentTexts: runResult.messagingToolSentTexts,
      messagingToolSentMediaUrls: runResult.messagingToolSentMediaUrls,
      messagingToolSentTargets: runResult.messagingToolSentTargets,
      originatingChannel: sessionCtx.OriginatingChannel,
      originatingChatType: sessionCtx.ChatType,
      originatingTo: resolveOriginMessageTo({
        originatingTo: sessionCtx.OriginatingTo,
        to: sessionCtx.To,
      }),
      originatingThreadId: replyRouteThreadId,
      accountId: sessionCtx.AccountId,
      normalizeMediaPaths: replyMediaContext.normalizePayload,
    });
  const returnPreparedFallbackPayload = async (
    payload: ReplyPayload,
  ): Promise<ReplyPayload | undefined> => {
    const result = await buildFinalPayloads([payload]);
    didLogHeartbeatStrip = result.didLogHeartbeatStrip;
    const preparedPayload = result.replyPayloads[0];
    if (!preparedPayload) {
      return undefined;
    }
    await signalTypingIfNeeded([preparedPayload], typingSignals);
    return returnWithQueuedFollowupDrain(preparedPayload);
  };
  const returnSilentFallbackFailureIfNeeded = async (): Promise<ReplyPayload | undefined> => {
    const silentFallbackFailurePayload = buildSilentFallbackFailurePayload({
      fallbackTransition,
      fallbackFailureKnown,
      isHeartbeat,
      hasSuccessfulTerminalDelivery: successfulTerminalDelivery,
      allowEmptyAssistantReplyAsSilent: followupRun.run.allowEmptyAssistantReplyAsSilent,
      silentExpected: followupRun.run.silentExpected,
    });
    if (!silentFallbackFailurePayload) {
      return undefined;
    }
    replyOperation.fail(
      "run_failed",
      new Error(
        `configured model backend ${fallbackTransition.selectedModelRef} failed and fallback ${fallbackTransition.activeModelRef} produced no visible reply`,
      ),
    );
    return returnPreparedFallbackPayload(silentFallbackFailurePayload);
  };
  const fallbackNoticePayloads: ReplyPayload[] = [];
  if (
    !fallbackExhausted &&
    !preserveUserFacingSessionState &&
    fallbackTransition.fallbackTransitioned
  ) {
    emitAgentEvent({
      runId,
      sessionKey,
      stream: "lifecycle",
      data: {
        phase: "fallback",
        selectedProvider,
        selectedModel,
        activeProvider: providerUsed,
        activeModel: modelUsed,
        reasonSummary: fallbackTransition.reasonSummary,
        attemptSummaries: fallbackTransition.attemptSummaries,
        attempts: fallbackAttempts,
      },
    });
    const fallbackNotice = buildFallbackNotice({
      selectedProvider,
      selectedModel,
      activeProvider: providerUsed,
      activeModel: modelUsed,
      attempts: fallbackAttempts,
      cfg,
    });
    if (fallbackNotice) {
      fallbackNoticePayloads.push(
        markReplyPayloadForSourceSuppressionDelivery({
          text: fallbackNotice,
          isFallbackNotice: true,
        }),
      );
    }
  }
  if (!fallbackExhausted && !preserveUserFacingSessionState && fallbackTransition.fallbackCleared) {
    emitAgentEvent({
      runId,
      sessionKey,
      stream: "lifecycle",
      data: {
        phase: "fallback_cleared",
        selectedProvider,
        selectedModel,
        activeProvider: providerUsed,
        activeModel: modelUsed,
        previousActiveModel: fallbackTransition.previousState.activeModel,
      },
    });
    fallbackNoticePayloads.push(
      markReplyPayloadForSourceSuppressionDelivery({
        text: buildFallbackClearedNotice({
          selectedProvider,
          selectedModel,
          previousActiveModel: fallbackTransition.previousState.activeModel,
        }),
        isFallbackNotice: true,
      }),
    );
  }

  // Drain any late tool/block deliveries before deciding there's "nothing to send".
  // Otherwise, a late typing trigger (e.g. from a tool callback) can outlive the run and
  // keep the typing indicator stuck.
  if (
    payloadArray.length === 0 &&
    fallbackNoticePayloads.length === 0 &&
    !shouldDeliverTerminalFailure &&
    (!emptyInteractiveReplyPayload || hasSpecificFallbackFailure)
  ) {
    const silentFallbackFailurePayload = await returnSilentFallbackFailureIfNeeded();
    if (silentFallbackFailurePayload) {
      return { kind: "return" as const, value: silentFallbackFailurePayload };
    }
    const strandedRetryDiagnostic = buildStrandedRetryMissingDeliveryDiagnostic();
    if (strandedRetryDiagnostic) {
      return {
        kind: "return" as const,
        value: returnWithQueuedFollowupDrain(strandedRetryDiagnostic),
      };
    }
    return { kind: "return" as const, value: returnWithQueuedFollowupDrain(undefined) };
  }

  const payloadCandidates = (
    fallbackNoticePayloads.length > 0 ? [...fallbackNoticePayloads, ...payloadArray] : payloadArray
  ).filter(
    (payload) =>
      (payload.isReasoning !== true || opts?.reasoningPayloadsEnabled === true) &&
      (payload.isCommentary !== true || opts?.commentaryPayloadsEnabled === true),
  );
  const payloadResult = await buildFinalPayloads(payloadCandidates);
  let { replyPayloads } = payloadResult;
  didLogHeartbeatStrip = payloadResult.didLogHeartbeatStrip;
  const hasTerminalReplyPayload = replyPayloads.some(
    (payload) =>
      !payload.isReasoning &&
      !payload.isCommentary &&
      !isReplyPayloadStatusNotice(payload) &&
      normalizeReplyPayload(payload, { applyChannelTransforms: false }) !== null,
  );
  if (shouldDeliverTerminalFailure && !hasTerminalReplyPayload && terminalFailurePayload) {
    const terminalPayloadResult = await buildFinalPayloads([terminalFailurePayload]);
    replyPayloads = [...replyPayloads, ...terminalPayloadResult.replyPayloads];
    didLogHeartbeatStrip = terminalPayloadResult.didLogHeartbeatStrip;
  } else if (hasSpecificFallbackFailure && !hasTerminalReplyPayload) {
    const silentFallbackFailurePayload = await returnSilentFallbackFailureIfNeeded();
    if (silentFallbackFailurePayload) {
      return { kind: "return" as const, value: silentFallbackFailurePayload };
    }
  } else if (emptyInteractiveReplyPayload && !hasTerminalReplyPayload) {
    const emptyPayloadResult = await buildFinalPayloads([emptyInteractiveReplyPayload]);
    replyPayloads = [...replyPayloads, ...emptyPayloadResult.replyPayloads];
    didLogHeartbeatStrip = emptyPayloadResult.didLogHeartbeatStrip;
    if (emptyPayloadResult.replyPayloads.length > 0) {
      replyOperation.retainFailureUntilComplete();
      replyOperation.fail(
        "run_failed",
        new Error("interactive agent run completed without a visible reply"),
      );
    }
  }

  replyPayloads = attachMcpAppChannelAction({
    payloads: replyPayloads,
    channel: replyToChannel,
    sessionKey,
    view: runResult.latestMcpAppChannelView,
  });

  const hasVisibleReplyPayload = replyPayloads.some(
    (payload) =>
      !isReplyPayloadStatusNotice(payload) &&
      (payload.isReasoning !== true || opts?.reasoningPayloadsEnabled === true) &&
      (payload.isCommentary !== true || opts?.commentaryPayloadsEnabled === true) &&
      normalizeReplyPayload(payload, { applyChannelTransforms: false }) !== null,
  );
  const hasDeliveredBlockStream = Boolean(
    blockReplyPipeline?.didStream() && !blockReplyPipeline.isAborted(),
  );
  const canDeliverStandaloneFallbackNotice =
    hasDeliveredBlockStream || successfulSideEffectDelivery;
  if (
    replyPayloads.length === 0 ||
    (!hasVisibleReplyPayload && !canDeliverStandaloneFallbackNotice)
  ) {
    const silentFallbackFailurePayload = await returnSilentFallbackFailureIfNeeded();
    if (silentFallbackFailurePayload) {
      return { kind: "return" as const, value: silentFallbackFailurePayload };
    }
    const strandedRetryDiagnostic = buildStrandedRetryMissingDeliveryDiagnostic();
    if (strandedRetryDiagnostic) {
      return {
        kind: "return" as const,
        value: returnWithQueuedFollowupDrain(strandedRetryDiagnostic),
      };
    }
    return { kind: "return" as const, value: returnWithQueuedFollowupDrain(undefined) };
  }

  const successfulCronAdds = runResult.successfulCronAdds ?? 0;
  const hasReminderCommitment = replyPayloads.some(
    (payload) =>
      !payload.isError &&
      !isReplyPayloadStatusNotice(payload) &&
      typeof payload.text === "string" &&
      hasUnbackedReminderCommitment(payload.text),
  );
  // Suppress the guard note when an existing cron job (created in a prior
  // turn) already covers the commitment — avoids false positives (#32228).
  const coveredByExistingCron =
    hasReminderCommitment && successfulCronAdds === 0
      ? await hasSessionRelatedCronJobs({
          cronStorePath: undefined,
          sessionKey,
        })
      : false;
  const guardedReplyPayloads =
    hasReminderCommitment && successfulCronAdds === 0 && !coveredByExistingCron
      ? appendUnscheduledReminderNote(replyPayloads)
      : replyPayloads;

  enqueueCommitmentExtractionForTurn({
    cfg,
    commandBody,
    isHeartbeat,
    followupRun,
    sessionCtx,
    sessionKey,
    replyToChannel,
    payloads: replyPayloads,
    runId,
  });

  await signalTypingIfNeeded(guardedReplyPayloads, typingSignals);

  if (isDiagnosticsEnabled(cfg) && hasNonzeroUsage(usage)) {
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const usagePromptTokens = input + cacheRead + cacheWrite;
    const totalTokens = usage.total ?? usagePromptTokens + output;
    const contextUsedTokens = deriveContextPromptTokens({
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      promptTokens,
      usage,
    });
    const costConfig = resolveModelCostConfig({
      provider: providerUsed,
      model: modelUsed,
      config: cfg,
    });
    const costUsd = hasBillableUsageBuckets
      ? estimateUsageCost({ usage, cost: costConfig })
      : undefined;
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      ...(runResult.diagnosticTrace
        ? {
            trace: freezeDiagnosticTraceContext(
              createChildDiagnosticTraceContext(runResult.diagnosticTrace),
            ),
          }
        : {}),
      sessionKey,
      sessionId: followupRun.run.sessionId,
      channel: replyToChannel,
      agentId: followupRun.run.agentId,
      provider: providerUsed,
      model: modelUsed,
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        promptTokens: usagePromptTokens,
        total: totalTokens,
      },
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      context: {
        limit: contextTokensUsed,
        ...(contextUsedTokens !== undefined ? { used: contextUsedTokens } : {}),
      },
      costUsd,
      durationMs: Date.now() - runStartedAt,
    });
  }

  const responseUsageSessionRaw =
    activeSessionEntry?.responseUsage ??
    (sessionKey ? activeSessionStore?.[sessionKey]?.responseUsage : undefined);
  const responseUsageLine = resolveResponseUsageLine({
    config: cfg,
    sessionRaw: responseUsageSessionRaw,
    channel: replyToChannel,
    usage,
    provider: providerUsed,
    model: modelUsed,
    preserveUserFacingSessionState,
    replyUsageState,
  });

  if (verboseEnabled) {
    activeSessionEntry = refreshSessionEntryFromStore({
      storePath,
      sessionKey,
      fallbackEntry: activeSessionEntry,
      activeSessionStore,
    });
  }

  return {
    kind: "continue" as const,
    activeSessionEntry,
    completedSourceReplyDelivery,
    didLogHeartbeatStrip,
    guardedReplyPayloads,
    responseUsageLine,
  };
}
