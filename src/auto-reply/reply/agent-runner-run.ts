import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  formatEmbeddedAgentQueueFailureSummary,
  queueEmbeddedAgentMessageWithOutcomeAsync,
} from "../../agents/embedded-agent-runner/runs.js";
import { isIngressAdoptionLostError } from "../../channels/message/ingress-drain.js";
import { hasRestartRecoverySourceClaim } from "../../config/sessions/restart-recovery-state.js";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { logVerbose } from "../../globals.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
  withBeforeAgentReplyObserver,
} from "../../plugins/before-agent-reply.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../plugins/hook-agent-context.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import {
  BLOCK_REPLY_SEND_TIMEOUT_MS,
  cleanupReplyAgentRun,
  handleReplyAgentRunError,
  refreshSessionEntryFromStore,
  resolveAdmittedRunSessionFile,
  type RunReplyAgentParams,
  scheduleFollowupDrainAfterReplyOperationClear,
} from "./agent-runner-core.js";
import {
  createReplyAgentRestartRecoveryController,
  executePreparedReplyAgentRun,
} from "./agent-runner-execute.js";
import {
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  isAudioPayload,
} from "./agent-runner-helpers.js";
import { resetReplyRunSession } from "./agent-runner-session-reset.js";
import { resolveQueuedReplyExecutionConfig } from "./agent-runner-utils.js";
import { createAudioAsVoiceBuffer, createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveEffectiveBlockStreamingConfig } from "./block-streaming.js";
import {
  type CompactionNoticePhase,
  createCompactionNoticePayload,
  shouldNotifyUserAboutCompaction,
} from "./compaction-notice.js";
import { createFollowupRunner } from "./followup-runner.js";
import { REPLY_RUN_STILL_SHUTTING_DOWN_TEXT } from "./get-reply-run-queue.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import { enqueueFollowupRun, type FollowupRun, scheduleFollowupDrain } from "./queue.js";
import { createReplyMediaContext } from "./reply-media-paths.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { type ReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { createReplyToModeFilterForChannel, resolveReplyToMode } from "./reply-threading.js";
import { admitReplyTurn, resolveReplyTurnKind } from "./reply-turn-admission.js";
import {
  isDuplicateRestartRecoverySource,
  retireTerminalRestartRecoverySourceClaim,
} from "./restart-recovery-claim.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import { buildChannelSourceTurnId, readChannelSourceTurnId } from "./source-turn-id.js";
import { createTypingSignaler } from "./typing-mode.js";
export async function runReplyAgent(
  params: RunReplyAgentParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    commandBody,
    transcriptCommandBody,
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
    isRunActive,
    opts,
    typing,
    sessionEntry,
    sessionStore,
    sessionKey,
    runtimePolicySessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    toolProgressDetail,
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionCtx,
    shouldInjectGroupIntro,
    typingMode,
    resetTriggered,
    replyThreadingOverride,
    replyOperation: providedReplyOperation,
  } = params;
  // One lifecycle for all adoption sites in this run.
  const turnAdoptionLifecycle = opts?.turnAdoptionLifecycle;
  let activeSessionEntry = sessionEntry;
  const activeSessionStore = sessionStore;
  let activeIsNewSession = isNewSession;
  const effectiveResetTriggered = resetTriggered === true;
  const activeRunQueueMode = effectiveResetTriggered ? "interrupt" : resolvedQueue.mode;

  const isHeartbeat = opts?.isHeartbeat === true;
  const replyOperationRunState = resolveReplyOperationRunState(opts);
  const traceAttributes = {
    provider: followupRun.run.provider,
    hasSessionKey: Boolean(sessionKey ?? followupRun.run.sessionKey),
    isHeartbeat,
    queueMode: resolvedQueue.mode,
    isActive,
    blockStreamingEnabled,
  };
  const traceAgentPhase = <T>(name: string, run: () => Promise<T> | T): Promise<T> =>
    measureDiagnosticsTimelineSpan(name, run, {
      phase: "agent-turn",
      config: followupRun.run.config,
      attributes: traceAttributes,
    });
  const effectiveShouldSteer = !isHeartbeat && !effectiveResetTriggered && shouldSteer;
  const effectiveShouldFollowup = !effectiveResetTriggered && shouldFollowup;
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat,
  });
  const restartRecoverySourceTurnId = readChannelSourceTurnId(sessionCtx);
  const restartRecoveryEntry =
    sessionKey && storePath
      ? (loadSessionEntry({
          storePath,
          sessionKey,
          clone: false,
          hydrateSkillPromptRefs: false,
        }) ?? activeSessionEntry)
      : activeSessionEntry;
  if (
    restartRecoverySourceTurnId &&
    isDuplicateRestartRecoverySource(restartRecoveryEntry, restartRecoverySourceTurnId)
  ) {
    // Durable source ownership identifies provider redelivery even if the run
    // became terminal before its claim cleanup committed.
    if (
      restartRecoveryEntry?.status !== "running" &&
      sessionKey &&
      storePath &&
      hasRestartRecoverySourceClaim(restartRecoveryEntry, restartRecoverySourceTurnId)
    ) {
      const retired = await retireTerminalRestartRecoverySourceClaim({
        sessionId: restartRecoveryEntry.sessionId,
        sessionKey,
        sourceTurnId: restartRecoverySourceTurnId,
        storePath,
      });
      if (retired) {
        activeSessionEntry = retired;
        if (activeSessionStore) {
          activeSessionStore[sessionKey] = retired;
        }
      }
    }
    typing.cleanup();
    return undefined;
  }

  const baseShouldEmitToolResult = createShouldEmitToolResult({
    sessionKey,
    storePath,
    resolvedVerboseLevel,
  });
  const channelProgressCanConsumeToolResults =
    Boolean(opts?.forceToolResultProgress) && Boolean(opts?.onToolResult);
  const shouldEmitToolResult = () =>
    channelProgressCanConsumeToolResults || baseShouldEmitToolResult();
  const shouldEmitToolOutput = createShouldEmitToolOutput({
    sessionKey,
    storePath,
    resolvedVerboseLevel,
  });

  const pendingToolTasks = new Set<Promise<void>>();
  const blockReplyTimeoutMs = opts?.blockReplyTimeoutMs ?? BLOCK_REPLY_SEND_TIMEOUT_MS;
  const touchActiveSessionEntry = async () => {
    if (!activeSessionEntry || !activeSessionStore || !sessionKey) {
      return;
    }
    const updatedAt = Date.now();
    activeSessionEntry.updatedAt = updatedAt;
    activeSessionStore[sessionKey] = activeSessionEntry;
    if (storePath) {
      await updateSessionEntry({ storePath, sessionKey }, () => ({ updatedAt }), {
        skipMaintenance: true,
        takeCacheOwnership: true,
      });
    }
  };

  let shouldQueueAfterSteerRejection = false;
  let beforeAgentReplyDispatchedForSteer = false;
  if (effectiveShouldSteer && isActive) {
    // Steer against the operation that owns THIS session's run slot. A native
    // command continuation whose slot adoption was skipped (#104844) still
    // carries a source-keyed reservation; steering by its stale sessionId
    // would miss the live target run.
    const registeredReplyOperation = sessionKey ? replyRunRegistry.get(sessionKey) : undefined;
    const activeReplyOperation =
      providedReplyOperation?.key === sessionKey
        ? providedReplyOperation
        : (registeredReplyOperation ?? providedReplyOperation);
    const steerSessionId = activeReplyOperation?.sessionId ?? followupRun.run.sessionId;
    // Channel dispatch normally stamps the route-scoped source id. Internal
    // callers can derive the same per-message identity from the prepared turn.
    const steerRunId = expectDefined(
      restartRecoverySourceTurnId ??
        buildChannelSourceTurnId({
          provider:
            followupRun.originatingChannel ??
            followupRun.run.messageProvider ??
            sessionCtx.Provider,
          accountId:
            followupRun.originatingAccountId ??
            followupRun.run.agentAccountId ??
            sessionCtx.AccountId,
          conversationId:
            followupRun.originatingTo ??
            followupRun.originatingChatId ??
            sessionKey ??
            followupRun.run.sessionKey,
          messageId: followupRun.messageId ?? sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
        }) ??
        normalizeOptionalString(opts?.runId),
      "steered turn id",
    );
    const trigger = "user";
    const hookResult = await runBeforeAgentReplyForTurn({
      runId: steerRunId,
      trigger,
      event: { cleanedBody: followupRun.prompt },
      context: {
        runId: steerRunId,
        agentId: followupRun.run.agentId,
        sessionKey: sessionKey ?? followupRun.run.sessionKey,
        sessionId: steerSessionId,
        workspaceDir: followupRun.run.workspaceDir,
        modelProviderId: followupRun.run.provider,
        modelId: followupRun.run.model,
        trigger,
        ...buildAgentHookContextChannelFields({
          sessionKey: sessionKey ?? followupRun.run.sessionKey,
          messageChannel: followupRun.originatingChannel,
          messageProvider: followupRun.run.messageProvider,
          currentChannelId: followupRun.originatingChatId,
          messageTo: followupRun.originatingTo,
          senderId: followupRun.run.senderId,
        }),
        ...buildAgentHookContextIdentityFields({
          trigger,
          senderId: followupRun.run.senderId,
          chatId: followupRun.originatingChatId,
          channelContext: followupRun.run.channelContext,
        }),
      },
    });
    beforeAgentReplyDispatchedForSteer = true;
    if (hookResult?.handled) {
      typing.cleanup();
      return buildHandledBeforeAgentReplyPayloads(hookResult.reply);
    }
    const steerOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
      steerSessionId,
      followupRun.prompt,
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        ...(followupRun.images?.length ? { images: followupRun.images } : {}),
        ...(followupRun.imageOrder?.length ? { imageOrder: followupRun.imageOrder } : {}),
        ...(followupRun.media?.length ? { media: followupRun.media } : {}),
        ...(turnAdoptionLifecycle ? { waitForTranscriptCommit: true } : {}),
        ...(resolvedQueue.debounceMs !== undefined ? { debounceMs: resolvedQueue.debounceMs } : {}),
        ...(followupRun.run.sourceReplyDeliveryMode
          ? { sourceReplyDeliveryMode: followupRun.run.sourceReplyDeliveryMode }
          : {}),
        taskSuggestionDeliveryMode: followupRun.run.taskSuggestionDeliveryMode,
        ...(followupRun.userTurnTranscriptRecorder
          ? { userTurnTranscriptRecorder: followupRun.userTurnTranscriptRecorder }
          : {}),
      },
    );
    if (steerOutcome.queued) {
      activeReplyOperation?.recordActivity();
      try {
        await turnAdoptionLifecycle?.onAdopted();
      } catch (error) {
        if (isIngressAdoptionLostError(error)) {
          // Claim was tombstoned/superseded/guillotined after transcript commit.
          // Cancel the active run so steered tools do not keep executing; do not
          // rethrow — replaying ingress would duplicate the injected user turn.
          const abortKey = sessionKey ?? queueKey;
          if (abortKey) {
            replyRunRegistry.abort(abortKey);
          }
          logVerbose(
            `queue: active session ${steerSessionId} adoption lost after transcript commit (${error.code}); aborting steered turn without ingress replay`,
          );
          typing.cleanup();
          return undefined;
        }
        // Ordinary callback failures: transcript-backed steering is irrevocable.
        logVerbose(
          `queue: active session ${steerSessionId} adoption finalizer failed after transcript commit: ${String(
            error,
          )}`,
        );
      }
      if (followupRun.currentInboundAudio === true) {
        activeReplyOperation?.markAcceptedSteeredInboundAudio();
      }
      await touchActiveSessionEntry();
      typing.cleanup();
      return undefined;
    }
    // The active runtime still owns the turn but cannot prove transcript adoption.
    // Keep the inbound message queued so ingress can finalize after a later run.
    shouldQueueAfterSteerRejection = steerOutcome.reason === "transcript_commit_wait_unsupported";
    const summary = formatEmbeddedAgentQueueFailureSummary(steerOutcome);
    logVerbose(`queue: active session ${steerSessionId} rejected steering injection: ${summary}`);
  }

  const activeRunQueueAction = resolveActiveRunQueueAction({
    isActive,
    isHeartbeat,
    shouldFollowup: effectiveShouldFollowup || shouldQueueAfterSteerRejection,
    queueMode: activeRunQueueMode,
    resetTriggered: effectiveResetTriggered,
  });

  const baseQueuedRunFollowupTurn = createFollowupRunner({
    opts,
    typing,
    typingMode,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
    toolProgressDetail,
  });
  // A transcript-rejected steer can become this exact queued turn. Preserve its
  // earlier hook decision without suppressing hooks for other queued messages.
  const queuedRunFollowupTurn = (queued: FollowupRun) =>
    beforeAgentReplyDispatchedForSteer && queued === followupRun
      ? withBeforeAgentReplyObserver(
          {
            beforeDispatch: async () => false,
            afterDispatch: async (result) => result,
          },
          () => baseQueuedRunFollowupTurn(queued),
        )
      : baseQueuedRunFollowupTurn(queued);

  if (activeRunQueueAction === "drop") {
    if (replyOperationRunState) {
      replyOperationRunState.admission = { status: "skipped", reason: "active-run" };
    }
    typing.cleanup();
    return undefined;
  }

  if (activeRunQueueAction === "enqueue-followup") {
    const enqueued = enqueueFollowupRun(
      queueKey,
      followupRun,
      resolvedQueue,
      "message-id",
      queuedRunFollowupTurn,
      false,
    );
    if (!enqueued) {
      typing.cleanup();
      return undefined;
    }
    // The queue must stay dormant while the active owner can still collect
    // messages. Registering after enqueue closes the owner-clear race.
    const activeReplyOperation = replyRunRegistry.get(queueKey);
    if (activeReplyOperation) {
      scheduleFollowupDrainAfterReplyOperationClear({
        operation: activeReplyOperation,
        queueKey,
        runFollowup: queuedRunFollowupTurn,
      });
    } else {
      scheduleFollowupDrain(queueKey, queuedRunFollowupTurn);
    }
    const queuedBehindActiveRun = isRunActive?.() === true;
    await touchActiveSessionEntry();
    if (queuedBehindActiveRun) {
      await typingSignals.signalToolStart();
    } else {
      typing.cleanup();
    }
    return undefined;
  }

  followupRun.run.config = await resolveQueuedReplyExecutionConfig(followupRun.run.config, {
    originatingChannel: sessionCtx.OriginatingChannel,
    messageProvider: followupRun.run.messageProvider,
    originatingAccountId: followupRun.originatingAccountId,
    agentAccountId: followupRun.run.agentAccountId,
  });

  const replyToChannel = resolveOriginMessageProvider({
    originatingChannel: sessionCtx.OriginatingChannel,
    provider: sessionCtx.Surface ?? sessionCtx.Provider,
  }) as OriginatingChannelType | undefined;
  const replyToMode = resolveReplyToMode(
    followupRun.run.config,
    replyToChannel,
    sessionCtx.AccountId,
    sessionCtx.ChatType,
  );
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const cfg = followupRun.run.config;
  const replyMediaContext = createReplyMediaContext({
    cfg,
    sessionKey,
    workspaceDir: followupRun.run.workspaceDir,
    messageProvider: followupRun.run.messageProvider,
    accountId: followupRun.originatingAccountId ?? followupRun.run.agentAccountId,
    groupId: followupRun.run.groupId,
    groupChannel: followupRun.run.groupChannel,
    groupSpace: followupRun.run.groupSpace,
    requesterSenderId: followupRun.run.senderId,
    requesterSenderName: followupRun.run.senderName,
    requesterSenderUsername: followupRun.run.senderUsername,
    requesterSenderE164: followupRun.run.senderE164,
  });
  const compactionNoticeMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
  const sendDirectCompactionNotice = shouldNotifyUserAboutCompaction(cfg)
    ? async (phase: CompactionNoticePhase) => {
        if (!opts?.onBlockReply) {
          return;
        }
        const noticePayload = createCompactionNoticePayload({
          phase,
          currentMessageId: compactionNoticeMessageId,
          applyReplyToMode,
        });
        try {
          await opts.onBlockReply(noticePayload);
        } catch (err) {
          logVerbose(`context maintenance notice delivery failed: ${String(err)}`);
        }
      }
    : undefined;
  const blockReplyCoalescing =
    blockStreamingEnabled && opts?.onBlockReply
      ? resolveEffectiveBlockStreamingConfig({
          cfg,
          provider: sessionCtx.Provider,
          accountId: sessionCtx.AccountId,
          chunking: blockReplyChunking,
        }).coalescing
      : undefined;
  const blockReplyPipeline =
    blockStreamingEnabled && opts?.onBlockReply
      ? createBlockReplyPipeline({
          onBlockReply: opts.onBlockReply,
          timeoutMs: blockReplyTimeoutMs,
          coalescing: blockReplyCoalescing,
          buffer: createAudioAsVoiceBuffer({ isAudioPayload }),
        })
      : null;
  const replySessionKey = sessionKey ?? followupRun.run.sessionKey;
  const replyRouteThreadId = resolveRoutedDeliveryThreadId({
    ctx: sessionCtx,
    sessionKey: replySessionKey,
  });
  let replyOperation: ReplyOperation;
  if (providedReplyOperation) {
    replyOperation = providedReplyOperation;
    if (replyOperationRunState) {
      replyOperationRunState.admission = { status: "owned" };
    }
  } else {
    const replyTurnKind = resolveReplyTurnKind(opts);
    const admission = await admitReplyTurn({
      sessionId: followupRun.run.sessionId,
      sessionKey: replySessionKey ?? "",
      expectedSessionId: activeSessionEntry?.sessionId,
      storePath,
      kind: replyTurnKind,
      resetTriggered: effectiveResetTriggered,
      routeThreadId: replyRouteThreadId,
      upstreamAbortSignal: opts?.abortSignal,
      onReplyAdmissionWaitChange: opts?.onReplyAdmissionWaitChange,
    });
    if (replyOperationRunState) {
      replyOperationRunState.admission =
        admission.status === "owned"
          ? { status: "owned" }
          : { status: "skipped", reason: admission.reason };
    }
    if (admission.status === "skipped") {
      typing.cleanup();
      if (admission.reason !== "active-run" || replyTurnKind !== "visible") {
        return undefined;
      }
      return markReplyPayloadForSourceSuppressionDelivery({
        text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT,
      });
    }
    replyOperation = admission.operation;
    const previousRunSessionId = followupRun.run.sessionId;
    followupRun.run.sessionId = replyOperation.sessionId;
    if (replyOperation.sessionId !== previousRunSessionId) {
      const admittedSessionEntry = refreshSessionEntryFromStore({
        storePath,
        sessionKey: replySessionKey,
        fallbackEntry: replySessionKey
          ? (activeSessionStore?.[replySessionKey] ?? activeSessionEntry)
          : activeSessionEntry,
        activeSessionStore,
      });
      if (admittedSessionEntry?.sessionId === replyOperation.sessionId) {
        activeSessionEntry = admittedSessionEntry;
        const admittedSessionFile = resolveAdmittedRunSessionFile({
          agentId: followupRun.run.agentId,
          sessionId: replyOperation.sessionId,
          sessionFile: undefined,
          sessionKey: replySessionKey,
          storePath,
        });
        if (admittedSessionFile) {
          followupRun.run.sessionFile = admittedSessionFile;
        }
      }
    }
  }
  let runFollowupTurn = queuedRunFollowupTurn;
  let shouldDrainQueuedFollowupsAfterClear = false;
  const returnWithQueuedFollowupDrain = <T>(value: T): T => {
    shouldDrainQueuedFollowupsAfterClear = true;
    return value;
  };
  const {
    admitUserTurn,
    beginBeforeAgentReply,
    checkpointBeforeAgentReply,
    clear: clearRestartRecoveryDeliveryClaim,
    isArmed: isRestartRecoveryArmed,
  } = createReplyAgentRestartRecoveryController({
    activeSessionStore,
    cfg,
    followupRun,
    getActiveSessionEntry: () => activeSessionEntry,
    opts,
    replyOperation,
    restartRecoverySourceTurnId,
    runtimePolicySessionKey,
    sessionCtx,
    sessionKey,
    setActiveSessionEntry: (entry) => {
      activeSessionEntry = entry;
    },
    storePath,
  });
  type SessionResetOptions = {
    failureLabel: string;
    buildLogMessage: (nextSessionId: string) => string;
    cleanupTranscripts?: boolean;
  };
  const resetSession = async ({
    failureLabel,
    buildLogMessage,
    cleanupTranscripts,
  }: SessionResetOptions): Promise<boolean> =>
    await resetReplyRunSession({
      options: {
        failureLabel,
        buildLogMessage,
        cleanupTranscripts,
      },
      sessionKey,
      queueKey,
      activeSessionEntry,
      activeSessionStore,
      storePath,
      messageThreadId:
        typeof sessionCtx.MessageThreadId === "string" ? sessionCtx.MessageThreadId : undefined,
      followupRun,
      onActiveSessionEntry: (nextEntry) => {
        activeSessionEntry = nextEntry;
      },
      onNewSession: () => {
        activeIsNewSession = true;
      },
    });
  const resetSessionAfterRoleOrderingConflict = async (reason: string): Promise<boolean> =>
    resetSession({
      failureLabel: "role ordering conflict",
      buildLogMessage: (nextSessionId) =>
        `Role ordering conflict (${reason}). Restarting session ${sessionKey} -> ${nextSessionId}.`,
      cleanupTranscripts: true,
    });
  try {
    return await executePreparedReplyAgentRun({
      activeSessionStore,
      admitUserTurn,
      agentCfgContextTokens,
      applyReplyToMode,
      beforeAgentReplyDispatchedForSteer,
      beginBeforeAgentReply,
      blockReplyChunking,
      blockReplyPipeline,
      blockStreamingEnabled,
      cfg,
      checkpointBeforeAgentReply,
      commandBody,
      defaultModel,
      followupRun,
      getActiveIsNewSession: () => activeIsNewSession,
      getActiveSessionEntry: () => activeSessionEntry,
      isHeartbeat,
      isRestartRecoveryArmed,
      opts,
      pendingToolTasks,
      performSessionReset: resetSession,
      queueKey,
      replyMediaContext,
      replyOperation,
      replyRouteThreadId,
      replyThreadingOverride,
      replyToChannel,
      replyToMode,
      resetSessionAfterRoleOrderingConflict,
      resolvedBlockStreamingBreak,
      resolvedQueue,
      resolvedVerboseLevel,
      returnWithQueuedFollowupDrain,
      runFollowupTurn,
      runtimePolicySessionKey,
      sendDirectCompactionNotice,
      sessionCtx,
      sessionKey,
      setActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      setRunFollowupTurn: (runner) => {
        runFollowupTurn = runner;
      },
      shouldEmitToolOutput,
      shouldEmitToolResult,
      shouldInjectGroupIntro,
      storePath,
      toolProgressDetail,
      traceAgentPhase,
      transcriptCommandBody,
      turnAdoptionLifecycle,
      typing,
      typingMode,
      typingSignals,
    });
  } catch (error) {
    return await handleReplyAgentRunError(error, {
      cfg,
      isRestartRecoveryArmed,
      replyOperation,
      resolvedVerboseLevel,
      returnWithQueuedFollowupDrain,
      sessionCtx,
    });
  } finally {
    await cleanupReplyAgentRun({
      blockReplyPipeline,
      clearRestartRecoveryDeliveryClaim,
      providedReplyOperation,
      queueKey,
      replyOperation,
      runFollowupTurn,
      sessionKey,
      shouldDrainQueuedFollowupsAfterClear,
      typing,
    });
  }
}
