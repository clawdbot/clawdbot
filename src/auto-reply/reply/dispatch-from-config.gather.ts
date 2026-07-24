import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { normalizeExplicitSessionKey } from "../../config/sessions/explicit-session-key-normalization.js";
import {
  deriveInboundMessageHookContext,
  toPluginInboundClaimContext,
  toPluginInboundClaimEvent,
} from "../../hooks/message-hook-mappers.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import {
  logMessageDispatchCompleted,
  logMessageDispatchStarted,
  markDiagnosticSessionProgress,
} from "../../logging/diagnostic.js";
import { createDiagnosticMessageLifecycle } from "../../logging/message-lifecycle.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { normalizeTtsAutoMode } from "../../tts/tts-config.js";
import type { FinalizedRuntimeMsgContext as FinalizedMsgContext } from "../templating.js";
import { normalizeVerboseLevel } from "../thinking.js";
import type {
  DispatchProcessedOptions,
  DispatchProcessedOutcome,
  InboundMessageAuditTerminalRecorder,
} from "./dispatch-from-config.audit.js";
import {
  resolveBoundAcpDispatchSessionKey,
  resolveSessionStoreLookup,
} from "./dispatch-from-config.context.js";
import { createShouldEmitVerboseProgress } from "./dispatch-from-config.harness-defaults.js";
import { createDispatchReplyOperationCoordinator } from "./dispatch-from-config.lifecycle.js";
import { createFinalizationAwareTtsPayloadApplier } from "./dispatch-from-config.payloads.js";
import { extendPreparedDispatchState } from "./dispatch-from-config.phase-state.js";
import { loadRuntimePlugins } from "./dispatch-from-config.runtime-loaders.js";
import { createReplyHotPathTimingTracker } from "./dispatch-from-config.timing.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { resolveEffectiveReplyRoute } from "./effective-reply-route.js";
import type { ReplySessionBinding } from "./get-reply.types.js";
import {
  finalizeInboundContext,
  isFinalizedInboundContext,
  stripLegacyMediaContextFields,
} from "./inbound-context.js";
import { hasInboundAudio } from "./inbound-media.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { isReplyProfilerEnabled } from "./reply-timing-tracker.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import { stageRemoteInboundMediaIfNeeded } from "./stage-remote-inbound-media.js";

export async function gatherDispatchRequest(
  params: DispatchFromConfigParams,
  messageAuditTerminal: InboundMessageAuditTerminalRecorder | undefined,
) {
  const ctx = isFinalizedInboundContext(params.ctx)
    ? params.ctx
    : finalizeInboundContext(params.ctx);
  const normalizedParams = ctx === params.ctx ? params : { ...params, ctx };
  const state = { params: normalizedParams, messageAuditTerminal };
  const { cfg, dispatcher } = normalizedParams;
  if (params.replyOptions?.abortSignal?.aborted) {
    messageAuditTerminal?.note("skipped", { reason: "reply_operation_aborted" });
    return {
      status: "complete" as const,
      result: {
        queuedFinal: false,
        counts: dispatcher.getQueuedCounts(),
      },
    };
  }
  const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
  const channel = normalizeLowercaseStringOrEmpty(ctx.Surface ?? ctx.Provider ?? "unknown");
  const chatId = ctx.To ?? ctx.From;
  const messageId =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const sessionKey =
    normalizeOptionalString(ctx.SessionKey) ?? normalizeOptionalString(ctx.CommandTargetSessionKey);
  const startTime = diagnosticsEnabled ? Date.now() : 0;
  const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);
  const initialSessionStoreEntry = resolveSessionStoreLookup(ctx, cfg);
  // resolveSessionStoreLookup is command-target-aware (it prefers
  // resolveCommandTurnTargetSessionKey), whereas the lifecycle's sessionKey is
  // source-first (ctx.SessionKey). On a native command turn that targets a
  // different session, the resolved entry can belong to the *target* while the
  // lifecycle reports the *source* key — so only carry the UUID when the entry
  // is for the same session the lifecycle reports, to avoid mis-associating a
  // session id with the wrong session key. When they diverge, emit sessionKey
  // only (prior behavior).
  const lifecycleSessionId =
    initialSessionStoreEntry.sessionKey === sessionKey
      ? initialSessionStoreEntry.entry?.sessionId
      : undefined;
  const messageLifecycle = createDiagnosticMessageLifecycle({
    enabled: diagnosticsEnabled,
    channel,
    chatId,
    messageId,
    sessionKey,
    sessionId: lifecycleSessionId,
    source: "dispatch",
    processingReason: "message_start",
    startedAtMs: startTime,
    trackSessionState: canTrackSession,
  });
  const traceAttributes = {
    surface: channel,
    hasSessionKey: Boolean(sessionKey),
    hasRunId: typeof params.replyOptions?.runId === "string",
  };
  const replyHotPathTiming = createReplyHotPathTimingTracker({
    profilerEnabled: isReplyProfilerEnabled({ config: cfg }),
  });
  const traceReplyPhase = <T>(name: string, run: () => Promise<T> | T): Promise<T> =>
    replyHotPathTiming.measure(name, () =>
      measureDiagnosticsTimelineSpan(name, run, {
        phase: "agent-turn",
        config: cfg,
        attributes: traceAttributes,
      }),
    );
  let agentDispatchStartedAt = 0;

  const recordProcessed = (outcome: DispatchProcessedOutcome, opts?: DispatchProcessedOptions) => {
    messageAuditTerminal?.note(outcome, opts);
    if (diagnosticsEnabled) {
      replyHotPathTiming.logIfSlow({
        channel,
        messageId,
        sessionKey,
        outcome,
        reason: opts?.reason,
      });
    }
    messageLifecycle.markProcessed(outcome, opts);
  };

  const recordAgentDispatchStarted = () => {
    if (!diagnosticsEnabled || agentDispatchStartedAt > 0) {
      return;
    }
    agentDispatchStartedAt = Date.now();
    logMessageDispatchStarted({
      channel,
      sessionKey: acpDispatchSessionKey,
      source: "replyResolver",
    });
  };

  const recordAgentDispatchCompleted = (
    outcome: "completed" | "skipped" | "error",
    opts?: {
      reason?: string;
      error?: string;
    },
  ) => {
    if (!diagnosticsEnabled || agentDispatchStartedAt <= 0) {
      return;
    }
    logMessageDispatchCompleted({
      channel,
      sessionKey: acpDispatchSessionKey,
      source: "replyResolver",
      durationMs: Date.now() - agentDispatchStartedAt,
      outcome,
      reason: opts?.reason,
      error: opts?.error,
    });
  };

  const markProcessing = () => {
    messageLifecycle.markProcessing();
  };

  const markIdle = (reason: string) => {
    messageLifecycle.markIdle(reason);
  };

  let inboundDedupeReplayUnsafe = false;
  const markInboundDedupeReplayUnsafe = () => {
    inboundDedupeReplayUnsafe = true;
  };

  const boundAcpDispatchSessionKey = resolveBoundAcpDispatchSessionKey({ ctx, cfg });
  const acpDispatchSessionKey =
    boundAcpDispatchSessionKey ?? initialSessionStoreEntry.sessionKey ?? sessionKey;
  // initialSessionStoreEntry stays command-target-aware for handler/store
  // lookups (status/stop/model act on the target via CommandTargetSessionKey).
  // Reply-run ownership must stay SOURCE-keyed: a native command turn must not
  // wait on or contend with the target's active run. Bound ACP routing uses
  // acpDispatchSessionKey separately and must not move source admission.
  const sourceSessionKey = normalizeOptionalString(ctx.SessionKey);
  const dispatchOperationSessionKey =
    sourceSessionKey ?? initialSessionStoreEntry.sessionKey ?? sessionKey ?? acpDispatchSessionKey;
  const operationSessionStoreEntry =
    sourceSessionKey &&
    initialSessionStoreEntry.sessionKey &&
    sourceSessionKey !== initialSessionStoreEntry.sessionKey
      ? resolveSessionStoreLookup(
          {
            ...ctx,
            // Strip target so store resolution follows the source SessionKey.
            CommandTargetSessionKey: undefined,
          },
          cfg,
        )
      : initialSessionStoreEntry;
  const initialDispatchReplyOperation = dispatchOperationSessionKey
    ? replyRunRegistry.get(dispatchOperationSessionKey)
    : undefined;
  if (
    params.replyOptions?.isHeartbeat === true &&
    dispatchOperationSessionKey &&
    initialDispatchReplyOperation
  ) {
    messageAuditTerminal?.note("skipped", { reason: "reply-operation-active" });
    return {
      status: "complete" as const,
      result: {
        queuedFinal: false,
        counts: dispatcher.getQueuedCounts(),
      },
    };
  }
  const markProgress = () => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    markDiagnosticSessionProgress({ sessionKey });
    if (acpDispatchSessionKey && acpDispatchSessionKey !== sessionKey) {
      markDiagnosticSessionProgress({ sessionKey: acpDispatchSessionKey });
    }
  };
  const sessionStoreEntry = boundAcpDispatchSessionKey
    ? resolveSessionStoreLookup({ ...ctx, SessionKey: boundAcpDispatchSessionKey }, cfg)
    : initialSessionStoreEntry;
  let preparedSessionBinding: ReplySessionBinding | undefined =
    sessionStoreEntry.sessionKey && sessionStoreEntry.entry?.sessionId
      ? {
          sessionKey: sessionStoreEntry.sessionKey,
          sessionId: sessionStoreEntry.entry.sessionId,
          storePath: sessionStoreEntry.storePath,
        }
      : undefined;
  let preparedOperationSessionBinding: ReplySessionBinding | undefined =
    operationSessionStoreEntry.sessionKey && operationSessionStoreEntry.entry?.sessionId
      ? {
          sessionKey: operationSessionStoreEntry.sessionKey,
          sessionId: operationSessionStoreEntry.entry.sessionId,
          storePath: operationSessionStoreEntry.storePath,
        }
      : undefined;
  const sessionKeysMatch = (left?: string, right?: string) =>
    Boolean(
      left &&
      right &&
      normalizeExplicitSessionKey(left, ctx) === normalizeExplicitSessionKey(right, ctx),
    );
  const notePreparedSession = (binding: ReplySessionBinding) => {
    if (sessionKeysMatch(binding.sessionKey, sessionStoreEntry.sessionKey)) {
      preparedSessionBinding = binding;
    }
    if (sessionKeysMatch(binding.sessionKey, operationSessionStoreEntry.sessionKey)) {
      preparedOperationSessionBinding = binding;
    }
    params.replyOptions?.onSessionPrepared?.(binding);
  };
  const resolveOperationExpectedSessionId = () =>
    preparedOperationSessionBinding?.sessionId ?? operationSessionStoreEntry.entry?.sessionId;
  const resolvePreparedTranscriptBinding = (mirrorSessionKey?: string) => {
    if (
      !preparedSessionBinding ||
      !sessionKeysMatch(mirrorSessionKey, preparedSessionBinding.sessionKey)
    ) {
      return undefined;
    }
    return preparedSessionBinding;
  };
  const sessionAgentId = resolveSessionAgentId({
    sessionKey: acpDispatchSessionKey,
    config: cfg,
    fallbackAgentId: ctx.AgentId,
  });
  const sessionAgentCfg = resolveAgentConfig(cfg, sessionAgentId);
  const verboseProgress = createShouldEmitVerboseProgress({
    agentId: sessionAgentId,
    sessionKey: acpDispatchSessionKey,
    storePath: sessionStoreEntry.storePath,
    initialExplicitLevel: sessionStoreEntry.entry?.verboseLevel,
    fallbackLevel:
      normalizeVerboseLevel(
        sessionStoreEntry.entry?.verboseLevel ??
          sessionAgentCfg?.verboseDefault ??
          cfg.agents?.defaults?.verboseDefault ??
          "",
      ) ?? "off",
  });
  const shouldEmitVerboseProgress = verboseProgress.shouldEmit;
  const shouldEmitFullVerboseProgress = verboseProgress.shouldEmitFull;
  const replyRoute = resolveEffectiveReplyRoute({ ctx, entry: sessionStoreEntry.entry });
  // Restore route thread context only from the active turn or the thread-scoped session key.
  // Do not read thread ids from the normalised session store here: `origin.threadId` can be
  // folded back into lastThreadId/deliveryContext during store normalisation and resurrect a
  // stale route after thread delivery was intentionally cleared.
  const routeThreadId = resolveRoutedDeliveryThreadId({
    ctx,
    sessionKey: acpDispatchSessionKey,
  });
  // Inherited sessions_send routes carry thread ids only when the stored route
  // proves the thread came from an explicit target, not session normalization.
  const routeReplyThreadId = replyRoute.threadId ?? routeThreadId;
  const inboundAudio = hasInboundAudio(ctx);
  const sessionTtsAuto = normalizeTtsAutoMode(sessionStoreEntry.entry?.ttsAuto);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, sessionAgentId);
  const replyOperationCoordinator = createDispatchReplyOperationCoordinator({
    ctx,
    dispatcher,
    dispatchOperationSessionKey,
    initialDispatchReplyOperation,
    messageAuditTerminal,
    operationSessionStoreEntry,
    replyOptions: params.replyOptions,
    resolveOperationExpectedSessionId,
    routeThreadId,
  });
  const {
    completeDispatchReplyOperation,
    dispatchHookDispatcher,
    ensureDispatchReplyOperation,
    failDispatchReplyOperation,
    getDispatchAbortOperation,
    getDispatchAbortSignal,
    getDispatchReplyOperation,
    getObservedReplyDelivery,
    getPreDispatchAbortSignal,
    getReplyOptions,
    isDispatchOperationAborted,
    isPreDispatchOperationAborted,
    markObservedReplyDelivery,
    releasePreDispatchLifecycleAdmission,
    runWithDispatchLifecycleAdmission,
    throwIfDispatchOperationAborted,
    trackDispatchLifecycleWork,
  } = replyOperationCoordinator;
  const maybeApplyTtsWithFinalizationLease = createFinalizationAwareTtsPayloadApplier({
    getReplyOperation: getDispatchReplyOperation,
    hasInboundAudio: () =>
      inboundAudio || getDispatchReplyOperation()?.acceptedSteeredInboundAudio === true,
  });
  const { ensureRuntimePluginsLoaded } = await traceReplyPhase("reply.load_runtime_plugins", () =>
    loadRuntimePlugins(),
  );
  await traceReplyPhase("reply.ensure_runtime_plugins", () => {
    ensureRuntimePluginsLoaded({ config: cfg, workspaceDir });
  });
  const hookRunner = getGlobalHookRunner();
  // Extract message context for hooks (plugin and internal)
  const timestamp =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined;
  const messageIdForHook =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const hookCtx = { ...ctx };
  const buildHookState = (sourceCtx: FinalizedMsgContext) => {
    const nextHookContext = deriveInboundMessageHookContext(sourceCtx, {
      messageId: messageIdForHook,
    });
    return {
      hookContext: nextHookContext,
      inboundClaimContext: toPluginInboundClaimContext(nextHookContext),
      inboundClaimEvent: toPluginInboundClaimEvent(nextHookContext, {
        commandAuthorized:
          typeof ctx.CommandAuthorized === "boolean" ? ctx.CommandAuthorized : undefined,
        wasMentioned: typeof ctx.WasMentioned === "boolean" ? ctx.WasMentioned : undefined,
      }),
    };
  };
  let { hookContext, inboundClaimContext, inboundClaimEvent } = buildHookState(hookCtx);
  const { isGroup, groupId } = hookContext;
  let hookMediaPrepared = false;
  let hookMediaMetadataStaged = false;
  const prepareHookMediaMetadata = async () => {
    if (hookMediaPrepared) {
      return;
    }
    hookMediaPrepared = true;
    // Plugin hooks may run in a different Codex cwd from core dispatch, so
    // only actual hook/plugin-claim consumers get remote-cache media paths.
    // Keep ctx unstaged for the normal get-reply single-stage path.
    const staged = await traceReplyPhase("reply.stage_remote_media_for_dispatch", () =>
      stageRemoteInboundMediaIfNeeded({
        ctx: hookCtx,
        cfg,
        sessionKey: acpDispatchSessionKey,
        workspaceDir,
        remoteMediaMode: "cache",
      }),
    );
    if (staged) {
      hookMediaMetadataStaged = true;
      ({ hookContext, inboundClaimContext, inboundClaimEvent } = buildHookState(hookCtx));
    }
  };
  const buildMessageReceivedHookContext = () => {
    const mediaRemoteHost = normalizeOptionalString(ctx.MediaRemoteHost);
    const hasUnstagedRemoteMediaMetadata = Boolean(
      hookContext.mediaPath ||
      hookContext.mediaUrl ||
      hookContext.mediaType ||
      hookContext.mediaPaths?.length ||
      hookContext.mediaUrls?.length ||
      hookContext.mediaTypes?.length,
    );
    if (hookMediaMetadataStaged || !mediaRemoteHost || !hasUnstagedRemoteMediaMetadata) {
      return hookContext;
    }
    const messageReceivedCtx = { ...hookCtx };
    // message_received hooks run before normal get-reply staging, so remote
    // host paths are not safe as live media. Keep originals as debug metadata.
    stripLegacyMediaContextFields(messageReceivedCtx);
    delete messageReceivedCtx.media;
    return {
      ...buildHookState(messageReceivedCtx).hookContext,
      mediaRemoteHost,
      mediaStagingPending: true,
      originalMediaPath: hookContext.mediaPath,
      originalMediaUrl: hookContext.mediaUrl,
      originalMediaType: hookContext.mediaType,
      originalMediaPaths: hookContext.mediaPaths,
      originalMediaUrls: hookContext.mediaUrls,
      originalMediaTypes: hookContext.mediaTypes,
    };
  };
  const nextState = extendPreparedDispatchState(
    state,
    {
      ctx,
      cfg,
      dispatcher,
      sessionKey,
      traceReplyPhase,
      recordProcessed,
      recordAgentDispatchStarted,
      recordAgentDispatchCompleted,
      markProcessing,
      markIdle,
      markInboundDedupeReplayUnsafe,
      acpDispatchSessionKey,
      markProgress,
      sessionStoreEntry,
      notePreparedSession,
      resolvePreparedTranscriptBinding,
      sessionAgentId,
      shouldEmitVerboseProgress,
      shouldEmitFullVerboseProgress,
      replyRoute,
      routeReplyThreadId,
      inboundAudio,
      sessionTtsAuto,
      workspaceDir,
      completeDispatchReplyOperation,
      dispatchHookDispatcher,
      ensureDispatchReplyOperation,
      failDispatchReplyOperation,
      getDispatchAbortOperation,
      getDispatchAbortSignal,
      getDispatchReplyOperation,
      getObservedReplyDelivery,
      getPreDispatchAbortSignal,
      getReplyOptions,
      isDispatchOperationAborted,
      isPreDispatchOperationAborted,
      markObservedReplyDelivery,
      releasePreDispatchLifecycleAdmission,
      runWithDispatchLifecycleAdmission,
      throwIfDispatchOperationAborted,
      trackDispatchLifecycleWork,
      maybeApplyTtsWithFinalizationLease,
      hookRunner,
      timestamp,
      messageIdForHook,
      isGroup,
      groupId,
      prepareHookMediaMetadata,
      buildMessageReceivedHookContext,
    },
    {
      inboundDedupeReplayUnsafe: {
        get: () => inboundDedupeReplayUnsafe,
        set: (value: boolean) => {
          inboundDedupeReplayUnsafe = value;
        },
      },
      hookContext: {
        get: () => hookContext,
        set: (value: typeof hookContext) => {
          hookContext = value;
        },
      },
      inboundClaimContext: {
        get: () => inboundClaimContext,
        set: (value: typeof inboundClaimContext) => {
          inboundClaimContext = value;
        },
      },
      inboundClaimEvent: {
        get: () => inboundClaimEvent,
        set: (value: typeof inboundClaimEvent) => {
          inboundClaimEvent = value;
        },
      },
    },
  );
  return { status: "ready" as const, state: nextState };
}

type GatherDispatchRequestResult = Awaited<ReturnType<typeof gatherDispatchRequest>>;
export type GatherDispatchRequestReadyState = Extract<
  GatherDispatchRequestResult,
  { status: "ready" }
>["state"];
