import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasCompletedSourceReplyDeliveryEvidence,
  hasCompletedTerminalDeliveryEvidence,
  hasVisibleOutboundDeliveryEvidence,
} from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { hasDeliberateSilentTerminalReply } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import { deriveContextPromptTokens, hasNonzeroUsage } from "../../agents/usage.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import { resolveLiveContinuationRuntimeConfig } from "../continuation/config.js";
import { stagedPostCompactionDelegateCount } from "../continuation/delegate-store-post-compaction.js";
import { pendingDelegateCount } from "../continuation/delegate-store.js";
import { buildFallbackClearedNotice, buildFallbackNotice } from "../fallback-state.js";
import {
  isReplyPayloadStatusNotice,
  markReplyPayloadForSourceSuppressionDelivery,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  buildSilentFallbackFailurePayload,
  hasSuccessfulSourceReplyDelivery,
  hasSuccessfulTerminalSourceReplyDelivery,
  refreshSessionEntryFromStore,
  resolveSourceReplyPolicy,
} from "./agent-runner-core.js";
import { buildEmptyInteractiveReplyPayload } from "./agent-runner-failure-reply.js";
import { signalTypingIfNeeded } from "./agent-runner-helpers.js";
import { buildReplyPayloads, loadReplyPayloadsDedupeRuntime } from "./agent-runner-payloads.js";
import {
  appendUnscheduledReminderNote,
  hasSessionRelatedCronJobs,
  hasUnbackedReminderCommitment,
} from "./agent-runner-reminder-guard.js";
import type { accountAgentTurn } from "./agent-runner-result-accounting.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { resolveResponseUsageLine } from "./agent-runner-usage-line.js";
import { attachMcpAppChannelAction } from "./mcp-app-channel-action.js";
import { attachMcpConnectChannelAction } from "./mcp-connect-channel-action.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { resolveOriginMessageTo } from "./origin-routing.js";
import { createReplyToModeFilterForChannel } from "./reply-threading.js";
import { resolveStrandedReplyRecovery } from "./stranded-reply-recovery.js";
type ReplyAgentAccounting = Awaited<ReturnType<typeof accountAgentTurn>>;

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
    effectiveContinuationSignal,
    fallbackAttempts,
    fallbackExhausted,
    fallbackTransition,
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
  const deliberateSilentTerminalReply = hasDeliberateSilentTerminalReply(runResult);
  if (deliberateSilentTerminalReply) {
    opts?.onDeliberateSilentTerminalReply?.();
  }
  const pendingContinuation =
    runResult.meta?.yielded === true || (runResult.meta?.pendingToolCalls?.length ?? 0) > 0;
  if (pendingContinuation) {
    opts?.onPendingContinuation?.();
  }

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
  const hasAcceptedSessionSpawn = (runResult.acceptedSessionSpawns?.length ?? 0) > 0;
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
        hasPendingContinuation: pendingContinuation,
        // Upstream hoists the deliberate-silent classification; the fork's wider
        // commitment set stays authoritative so a side-effect-only or
        // session-spawn turn is never re-delivered as an empty interactive reply.
        hasExplicitSilentReply: deliberateSilentTerminalReply,
        hasCommittedDelivery:
          successfulTerminalDelivery ||
          (successfulSideEffectDelivery && (directlySentBlockKeys?.size ?? 0) === 0) ||
          hasAcceptedSessionSpawn,
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
    // The guard above limits this to a one-shot recovery turn. A second miss
    // always gets a diagnostic, even when the retry produced no final text.
    const recovery = resolveStrandedReplyRecovery({
      base: followupRun,
      finalText: "",
      sourceReplyDeliveryMode: sourceReplyPolicy.sourceReplyDeliveryMode,
      sendPolicyDenied: sourceReplyPolicy.sendPolicyDenied,
      successfulSourceReplyDelivery: completedSourceReplyDelivery,
      isHeartbeat,
      isRoomEvent: false,
    });
    return recovery.kind === "diagnostic" ? recovery.payload : undefined;
  };
  // Structured source-reply delivery evidence is the canonical owner for current
  // runtimes. The route matcher remains only for legacy results that recorded
  // successful target/text/media aggregates before structured receipts existed.
  // It still keeps unrelated-target tool sends from counting as the source reply.
  const sourceRoutedMessagingToolDelivery =
    completedSourceReplyDelivery ||
    ((runResult.messagingToolSentTargets?.length ?? 0) > 0 &&
      (await loadReplyPayloadsDedupeRuntime()).hasSourceRoutedMessagingToolDelivery({
        config: cfg,
        messageProvider: followupRun.run.messageProvider,
        messagingToolSentTargets: runResult.messagingToolSentTargets,
        messagingToolSentTexts: runResult.messagingToolSentTexts,
        messagingToolSentMediaUrls: runResult.messagingToolSentMediaUrls,
        originatingTo: resolveOriginMessageTo({
          originatingTo: sessionCtx.OriginatingTo,
          to: sessionCtx.To,
        }),
        originatingThreadId: replyRouteThreadId,
        accountId: sessionCtx.AccountId,
      }));
  if (sourceRoutedMessagingToolDelivery) {
    await opts?.onObservedReplyDelivery?.();
  }
  const currentMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
  // A terminal fallback is built separately after normal payload filtering.
  // Share this state across deliverable lanes so replyToMode=first still threads
  // at most one visible payload without hidden reasoning/commentary consuming it.
  const applyDeliveredReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const isPayloadLaneEnabled = (payload: ReplyPayload): boolean =>
    (payload.isReasoning !== true || opts?.reasoningPayloadsEnabled === true) &&
    (payload.isCommentary !== true || opts?.commentaryPayloadsEnabled === true);
  const applyFinalReplyToMode = (payload: ReplyPayload) => {
    const payloadLaneEnabled = isPayloadLaneEnabled(payload);
    const isFilteredPayload =
      normalizeReplyPayload(payload, { applyChannelTransforms: false }) === null;
    return !payloadLaneEnabled || isFilteredPayload ? payload : applyDeliveredReplyToMode(payload);
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
  const fallbackNoticeChanged =
    !fallbackExhausted &&
    !preserveUserFacingSessionState &&
    (fallbackTransition.fallbackTransitioned || fallbackTransition.fallbackCleared);
  const fallbackNoticeChatType = fallbackNoticeChanged
    ? normalizeChatType(sessionCtx.ChatType)
    : undefined;
  const shouldDeliverFallbackNotice =
    fallbackNoticeChatType !== "group" && fallbackNoticeChatType !== "channel";
  let fallbackNoticeText: string | null = null;
  if (fallbackNoticeChanged && fallbackTransition.fallbackTransitioned) {
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
    if (shouldDeliverFallbackNotice) {
      fallbackNoticeText = buildFallbackNotice({
        selectedProvider,
        selectedModel,
        activeProvider: providerUsed,
        activeModel: modelUsed,
        attempts: fallbackAttempts,
        cfg,
      });
    }
  }
  if (fallbackNoticeChanged && fallbackTransition.fallbackCleared) {
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
    if (shouldDeliverFallbackNotice) {
      fallbackNoticeText = buildFallbackClearedNotice({
        selectedProvider,
        selectedModel,
        previousActiveModel: fallbackTransition.previousState.activeModel,
      });
    }
  }
  const fallbackNoticePayloads: ReplyPayload[] = fallbackNoticeText
    ? [
        markReplyPayloadForSourceSuppressionDelivery({
          text: fallbackNoticeText,
          isFallbackNotice: true,
        }),
      ]
    : [];

  // Drain any late tool/block deliveries before deciding there's "nothing to send".
  // Otherwise, a late typing trigger (e.g. from a tool callback) can outlive the run and
  // keep the typing indicator stuck. A tool-only continuation turn may have no visible
  // text while still needing delegate consumption/persistence below. Terminal failures are
  // likewise delivered after normal payload filtering.
  const hasQueuedDelegateWork =
    resolveLiveContinuationRuntimeConfig(cfg).enabled &&
    sessionKey &&
    (pendingDelegateCount(sessionKey) > 0 || stagedPostCompactionDelegateCount(sessionKey) > 0);

  if (
    payloadArray.length === 0 &&
    fallbackNoticePayloads.length === 0 &&
    !hasQueuedDelegateWork &&
    !effectiveContinuationSignal &&
    !shouldDeliverTerminalFailure &&
    opts?.reasoningPayloadsEnabled !== true &&
    opts?.commentaryPayloadsEnabled !== true &&
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
  ).filter(isPayloadLaneEnabled);
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
  } else if (
    emptyInteractiveReplyPayload &&
    !hasTerminalReplyPayload &&
    !effectiveContinuationSignal &&
    !hasQueuedDelegateWork
  ) {
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
  replyPayloads = attachMcpConnectChannelAction({
    payloads: replyPayloads,
    action: runResult.latestMcpConnectAction,
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
  // Track whether the agent reply was purely a continuation signal (stripped to empty).
  // Used later to suppress verbose/usage augmentation that would break silent continuation.
  const wasSilentContinuation = replyPayloads.length === 0 && Boolean(effectiveContinuationSignal);

  if (!hasVisibleReplyPayload && !canDeliverStandaloneFallbackNotice) {
    const silentFallbackFailurePayload = await returnSilentFallbackFailureIfNeeded();
    if (silentFallbackFailurePayload) {
      return { kind: "return" as const, value: silentFallbackFailurePayload };
    }
    const emptyFallbackPayload =
      emptyInteractiveReplyPayload ??
      buildEmptyInteractiveReplyPayload({
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
        hasCommittedDelivery: false,
        sessionCtx,
        cfg,
      });
    if (emptyFallbackPayload && !effectiveContinuationSignal && !hasQueuedDelegateWork) {
      const emptyPayloadResult = await buildFinalPayloads([emptyFallbackPayload]);
      if (emptyPayloadResult.replyPayloads.length > 0) {
        replyOperation.retainFailureUntilComplete();
        replyOperation.fail(
          "run_failed",
          new Error("interactive agent run completed without a visible reply"),
        );
        return {
          kind: "return" as const,
          value: returnWithQueuedFollowupDrain(
            emptyPayloadResult.replyPayloads.length === 1
              ? emptyPayloadResult.replyPayloads[0]
              : emptyPayloadResult.replyPayloads,
          ),
        };
      }
    }
    // If the agent replied with only a continuation signal (e.g. bare CONTINUE_WORK),
    // the signal was stripped and all payloads became empty. We still need to process
    // the continuation below. Tool-only delegate turns also pass through here.
    if (!effectiveContinuationSignal && !hasQueuedDelegateWork) {
      const strandedRetryDiagnostic = buildStrandedRetryMissingDeliveryDiagnostic();
      if (strandedRetryDiagnostic) {
        return {
          kind: "return" as const,
          value: returnWithQueuedFollowupDrain(strandedRetryDiagnostic),
        };
      }
      return { kind: "return" as const, value: returnWithQueuedFollowupDrain(undefined) };
    }
  }
  if (
    replyPayloads.length === 0 &&
    (opts?.reasoningPayloadsEnabled === true || opts?.commentaryPayloadsEnabled === true) &&
    !effectiveContinuationSignal &&
    !hasQueuedDelegateWork
  ) {
    const emptyPayloadResult = await buildFinalPayloads(
      [
        buildEmptyInteractiveReplyPayload({
          isInteractive:
            followupRun.currentInboundEventKind !== "room_event" &&
            (followupRun.run.inputProvenance?.kind === undefined ||
              followupRun.run.inputProvenance.kind === "external_user"),
          isHeartbeat: false,
          silentExpected: followupRun.run.silentExpected,
          allowEmptyAssistantReplyAsSilent: followupRun.run.allowEmptyAssistantReplyAsSilent,
          isMessageToolOnly:
            (opts?.sourceReplyDeliveryMode ?? followupRun.run.sourceReplyDeliveryMode) ===
            "message_tool_only",
          hasPendingContinuation:
            runResult.meta?.yielded === true || (runResult.meta?.pendingToolCalls?.length ?? 0) > 0,
          hasExplicitSilentReply: hasDeliberateSilentTerminalReply(runResult),
          hasCommittedDelivery: false,
          sessionCtx,
          cfg,
        }),
      ].filter((payload): payload is ReplyPayload => payload !== undefined),
    );
    if (emptyPayloadResult.replyPayloads.length > 0) {
      replyOperation.retainFailureUntilComplete();
      replyOperation.fail(
        "run_failed",
        new Error("interactive agent run completed without a visible reply"),
      );
      return {
        kind: "return" as const,
        value: returnWithQueuedFollowupDrain(
          emptyPayloadResult.replyPayloads.length === 1
            ? emptyPayloadResult.replyPayloads[0]
            : emptyPayloadResult.replyPayloads,
        ),
      };
    }
  }
  if (
    replyPayloads.length === 0 &&
    successfulTerminalDelivery &&
    !hasDeliveredBlockStream &&
    (directlySentBlockKeys?.size ?? 0) === 0 &&
    (directlySentBlockPayloads?.length ?? 0) === 0 &&
    !effectiveContinuationSignal &&
    !hasQueuedDelegateWork
  ) {
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

  await signalTypingIfNeeded(guardedReplyPayloads, typingSignals);

  const diagnosticUsage = runResult.meta?.agentMeta?.diagnosticUsage ?? usage;
  if (isDiagnosticsEnabled(cfg) && hasNonzeroUsage(diagnosticUsage)) {
    const input = diagnosticUsage.input ?? 0;
    const output = diagnosticUsage.output ?? 0;
    const cacheRead = diagnosticUsage.cacheRead ?? 0;
    const cacheWrite = diagnosticUsage.cacheWrite ?? 0;
    const usagePromptTokens = input + cacheRead + cacheWrite;
    const totalTokens = diagnosticUsage.total ?? usagePromptTokens + output;
    const contextUsedTokens = deriveContextPromptTokens({
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      promptTokens,
      usage,
    });
    const costConfig = resolveModelCostConfig({
      provider: providerUsed,
      model: modelUsed,
      config: cfg,
      agentDir: followupRun.run.agentDir,
    });
    const hasDiagnosticBillableUsageBuckets =
      diagnosticUsage.input !== undefined ||
      diagnosticUsage.output !== undefined ||
      diagnosticUsage.cacheRead !== undefined ||
      diagnosticUsage.cacheWrite !== undefined;
    const costUsd = hasDiagnosticBillableUsageBuckets
      ? estimateUsageCost({ usage: diagnosticUsage, cost: costConfig })
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
    agentDir: followupRun.run.agentDir,
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
    wasSilentContinuation,
  };
}
