import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import { settleProgressVisibilityCallbackResult } from "../../channels/progress-visibility.js";
import { hasRestartRecoverySourceClaim } from "../../config/sessions/restart-recovery-state.js";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { logVerbose } from "../../globals.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { hasOutboundReplyContent } from "../../plugin-sdk/reply-payload.js";
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
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
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
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import { REPLY_ADMISSION_TICKET } from "./reply-admission-ticket.js";
import { createReplyMediaContext } from "./reply-media-paths.js";
import { isReplyOperationSuperseded } from "./reply-operation-abort.js";
import { recordReplyOperationAgentTurn } from "./reply-operation-agent-turn-state.js";
import * as replyRunState from "./reply-operation-run-state.js";
import { type ReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { bindReplyOperationTyping } from "./reply-run-typing.js";
import { createReplyToModeFilterForChannel, resolveReplyToMode } from "./reply-threading.js";
import {
  createFollowupRunToolAuthorityProjector,
  resolveFollowupRunToolAuthorityFingerprint,
} from "./reply-tool-authority.js";
import { admitReplyTurn, resolveReplyTurnKind } from "./reply-turn-admission.js";
import {
  isDuplicateRestartRecoverySource,
  retireTerminalRestartRecoverySourceClaim,
} from "./restart-recovery-claim.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";
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
    queueAdmissionState = "empty",
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
  const releaseAdmissionTicket = () => opts?.[REPLY_ADMISSION_TICKET]?.release();
  let activeSessionEntry = sessionEntry;
  const activeSessionStore = sessionStore;
  let activeIsNewSession = isNewSession;
  const effectiveResetTriggered = resetTriggered === true;
  const activeRunQueueMode = effectiveResetTriggered ? "interrupt" : resolvedQueue.mode;

  const isHeartbeat = opts?.isHeartbeat === true;
  let didDeliverVisiblePartialReply = false;
  const onPartialReply = opts?.onPartialReply;
  const runOpts = onPartialReply
    ? {
        ...opts,
        onPartialReply: async (payload: Parameters<NonNullable<typeof opts.onPartialReply>>[0]) => {
          const observed = await settleProgressVisibilityCallbackResult(onPartialReply(payload));
          if (observed.visible && hasOutboundReplyContent(payload, { trimText: true })) {
            didDeliverVisiblePartialReply = true;
          }
          return observed.result;
        },
      }
    : opts;
  const replyOperationRunState = replyRunState.resolveReplyOperationRunState(opts);
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
  const incomingToolAuthorityFingerprint = resolveFollowupRunToolAuthorityFingerprint(followupRun);
  const activeReplyOperation = sessionKey
    ? (replyRunRegistry.get(sessionKey) ?? providedReplyOperation)
    : providedReplyOperation;
  const activeToolAuthorityFingerprint = activeReplyOperation?.toolAuthorityFingerprint;
  const incomingAuthorityAtActiveRoute = activeReplyOperation?.toolAuthorityRoute
    ? resolveFollowupRunToolAuthorityFingerprint(
        followupRun,
        activeReplyOperation.toolAuthorityRoute,
      )
    : undefined;
  const hasAuthorityMismatch =
    activeReplyOperation !== undefined &&
    activeToolAuthorityFingerprint !== incomingToolAuthorityFingerprint;
  const hasRouteOnlyAuthorityMismatch =
    hasAuthorityMismatch &&
    activeToolAuthorityFingerprint !== undefined &&
    incomingAuthorityAtActiveRoute === activeToolAuthorityFingerprint;
  const shouldQueueAuthorityMismatch =
    effectiveShouldSteer && isActive && hasAuthorityMismatch && !hasRouteOnlyAuthorityMismatch;
  if (shouldQueueAuthorityMismatch) {
    logVerbose(
      `queue: active session ${activeReplyOperation?.sessionId ?? followupRun.run.sessionId} has different or unknown tool authority; queuing instead of steering`,
    );
  }
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
    releaseAdmissionTicket();
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

  const queuedRunFollowupTurn = createFollowupRunner({
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

  if (
    effectiveShouldSteer &&
    isActive &&
    !shouldQueueAuthorityMismatch &&
    opts?.messageInjectionAttempted !== true
  ) {
    replyRunState.bindQueueDispositionToRunState(followupRun, replyOperationRunState);
    await runActiveReplySteer({
      followupRun,
      opts,
      providedReplyOperation,
      queueKey,
      releaseAdmissionTicket,
      replyOperationRunState,
      resolvedQueue,
      restartRecoverySourceTurnId,
      runFollowup: queuedRunFollowupTurn,
      sessionCtx,
      sessionKey,
      touchActiveSessionEntry,
      typing,
      typingSignals,
      toolAuthorityFingerprint: incomingToolAuthorityFingerprint,
      pendingInputAuthorityFingerprint: hasRouteOnlyAuthorityMismatch
        ? activeToolAuthorityFingerprint
        : undefined,
    });
    return undefined;
  }

  const activeRunQueueAction = resolveActiveRunQueueAction({
    queueAdmissionState,
    isActive,
    isHeartbeat,
    shouldFollowup: effectiveShouldFollowup || shouldQueueAuthorityMismatch,
    queueMode: activeRunQueueMode,
    resetTriggered: effectiveResetTriggered,
  });
  if (activeRunQueueAction === "drop") {
    if (replyOperationRunState) {
      replyOperationRunState.admission = { status: "skipped", reason: "active-run" };
    }
    releaseAdmissionTicket();
    typing.cleanup();
    return undefined;
  }

  if (activeRunQueueAction === "enqueue-followup") {
    replyRunState.bindQueueDispositionToRunState(followupRun, replyOperationRunState);
    const enqueued = enqueueFollowupRun(
      queueKey,
      followupRun,
      resolvedQueue,
      "message-id",
      queuedRunFollowupTurn,
      false,
    );
    if (!enqueued) {
      releaseAdmissionTicket();
      typing.cleanup();
      return undefined;
    }
    if (replyOperationRunState) {
      replyOperationRunState.admission = { status: "accepted", mode: "followup" };
    }
    // The queue must stay dormant while the active owner can still collect
    // messages. Registering after enqueue closes the owner-clear race.
    const queuedOperationOwner = replyRunRegistry.get(queueKey) ?? activeReplyOperation;
    if (queuedOperationOwner) {
      scheduleFollowupDrainAfterReplyOperationClear({
        operation: queuedOperationOwner,
        queueKey,
        runFollowup: queuedRunFollowupTurn,
      });
    } else {
      scheduleFollowupDrain(queueKey, queuedRunFollowupTurn);
    }
    releaseAdmissionTicket();
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
  followupRun.run.agentId ??= resolveDefaultAgentId(followupRun.run.config);

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
    ? async (phase: CompactionNoticePhase, text?: string) => {
        if (!opts?.onBlockReply) {
          return;
        }
        const noticePayload = createCompactionNoticePayload({
          phase,
          text,
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
    releaseAdmissionTicket();
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
      originatingLeafEntryId: turnAdoptionLifecycle?.originatingLeafEntryId,
      upstreamAbortSignal: opts?.abortSignal,
    });
    if (replyOperationRunState) {
      replyOperationRunState.admission =
        admission.status === "owned"
          ? { status: "owned" }
          : { status: "skipped", reason: admission.reason };
    }
    if (admission.status === "skipped") {
      releaseAdmissionTicket();
      typing.cleanup();
      if (admission.reason !== "active-run" || replyTurnKind !== "visible") {
        return undefined;
      }
      return markReplyPayloadForSourceSuppressionDelivery({
        text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT,
      });
    }
    replyOperation = admission.operation;
    releaseAdmissionTicket();
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
  replyOperation.bindToolAuthorityProjector(createFollowupRunToolAuthorityProjector(followupRun));
  replyOperation.bindToolAuthorityFingerprint(
    resolveFollowupRunToolAuthorityFingerprint(followupRun),
  );
  bindReplyOperationTyping(replyOperation, typing);
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
      opts: runOpts,
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
    recordReplyOperationAgentTurn(
      replyOperationRunState,
      isReplyOperationSuperseded(replyOperation) ? "superseded" : "failed",
      replyOperation,
    );
    return await handleReplyAgentRunError(error, {
      blockReplyPipeline,
      cfg,
      didDeliverVisiblePartialReply: () => didDeliverVisiblePartialReply,
      isHeartbeat,
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
