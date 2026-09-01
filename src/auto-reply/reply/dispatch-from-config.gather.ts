import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import type { PreparedReplyDispatchRuntime } from "../../agents/prepared-model-runtime.types.js";
import { normalizeExplicitSessionKey } from "../../config/sessions/explicit-session-key-normalization.js";
import {
  deriveInboundMessageHookContext,
  toPluginInboundClaimPair,
} from "../../hooks/message-hook-mappers.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import {
  logMessageDispatchCompleted,
  logMessageDispatchStarted,
  markDiagnosticSessionProgress,
} from "../../logging/diagnostic.js";
import { createDiagnosticMessageLifecycle } from "../../logging/message-lifecycle.js";
import { stripLegacyMediaContextFields } from "../../media/media-facts.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveSessionDispatchKind } from "../../sessions/session-key-utils.js";
import { prepareChannelParticipantObservation } from "../../sessions/session-participant-input.js";
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
import {
  loadPreparedModelRuntime,
  loadRuntimePlugins,
} from "./dispatch-from-config.runtime-loaders.js";
import { createReplyHotPathTimingTracker } from "./dispatch-from-config.timing.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { noteDispatchProcessedOutcome } from "./dispatch-processed-outcome.js";
import { resolveEffectiveReplyRoute } from "./effective-reply-route.js";
import type { ReplySessionBinding } from "./get-reply.types.js";
import { finalizeInboundContext, isFinalizedInboundContext } from "./inbound-context.js";
import { hasInboundAudio } from "./inbound-media.js";
import { bindReplyDispatcherConversationContext } from "./reply-dispatcher.js";
import {
  resolveReplyOperationRunState,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { isReplyProfilerEnabled } from "./reply-timing-tracker.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import { stageRemoteInboundMediaIfNeeded } from "./stage-remote-inbound-media.js";

export async function gatherDispatchRequest(
  params: DispatchFromConfigParams,
  messageAuditTerminal: InboundMessageAuditTerminalRecorder | undefined,
  allowActiveQueueResolution = false,
) {
  const ctx = isFinalizedInboundContext(params.ctx)
    ? params.ctx
    : finalizeInboundContext(params.ctx);
  const turnAdoptionLifecycle = params.replyOptions?.turnAdoptionLifecycle;
  prepareChannelParticipantObservation(ctx);
  const turnAdoptionState = { adopted: false };
  const normalizedParams: DispatchFromConfigParams = {
    ...params,
    ctx,
    replyOptions: {
      ...params.replyOptions,
      ...(turnAdoptionLifecycle
        ? {
            turnAdoptionLifecycle: {
              ...turnAdoptionLifecycle,
              onAdopted: async () => {
                // The upstream owner is durable only after its callback commits.
                // A rejected callback must leave replay dedupe releasable.
                await turnAdoptionLifecycle.onAdopted();
                turnAdoptionState.adopted = true;
              },
            },
          }
        : {}),
    },
  };
  const state = {
    params: normalizedParams,
    messageAuditTerminal,
    inboundDedupeReplayUnsafe: false,
    turnAdoptionState: turnAdoptionLifecycle ? turnAdoptionState : undefined,
  };
  const { cfg, dispatcher } = normalizedParams;
  bindReplyDispatcherConversationContext(dispatcher, ctx.agentText);
  const replyOperationRunState: ReplyOperationRunState =
    resolveReplyOperationRunState(normalizedParams.replyOptions) ?? {};
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
    noteDispatchProcessedOutcome({
      outcome,
      ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
    });
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
  const finishReplyOperationAborted = () => {
    recordProcessed("skipped", { reason: "reply_operation_aborted" });
    return {
      status: "complete" as const,
      result: {
        queuedFinal: false,
        counts: dispatcher.getQueuedCounts(),
      },
    };
  };
  if (params.replyOptions?.abortSignal?.aborted) {
    return finishReplyOperationAborted();
  }

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

  const markInboundDedupeReplayUnsafe = () => {
    state.inboundDedupeReplayUnsafe = true;
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
    noteDispatchProcessedOutcome({ outcome: "skipped", reason: "reply-operation-active" });
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
  const dispatchKind = resolveSessionDispatchKind(acpDispatchSessionKey, sessionStoreEntry.entry);
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
  // A bound ACP key names an external harness, not a configured model-runtime owner.
  // Keep the source owner for Gateway dispatch while ACP execution uses the bound target below.
  const preparedReplyDispatchAgentId = boundAcpDispatchSessionKey
    ? resolveSessionAgentId({ sessionKey, config: cfg, fallbackAgentId: ctx.AgentId })
    : sessionAgentId;
  let preparedReplyDispatchRuntime: PreparedReplyDispatchRuntime | undefined;
  try {
    preparedReplyDispatchRuntime = params.usePublishedModelRuntime
      ? await traceReplyPhase("reply.load_prepared_dispatch_runtime", async () => {
          const { loadPublishedGatewayReplyDispatchRuntime } = await loadPreparedModelRuntime();
          return await loadPublishedGatewayReplyDispatchRuntime({
            agentId: preparedReplyDispatchAgentId,
            abortSignal: params.replyOptions?.abortSignal,
          });
        })
      : undefined;
  } catch (error) {
    if (params.replyOptions?.abortSignal?.aborted && isAbortError(error)) {
      return finishReplyOperationAborted();
    }
    throw error;
  }
  const workspaceDir =
    preparedReplyDispatchRuntime?.workspaceDir ?? resolveAgentWorkspaceDir(cfg, sessionAgentId);
  const replyOperationCoordinator = createDispatchReplyOperationCoordinator({
    allowActiveQueueResolution,
    agentId: sessionAgentId,
    cfg,
    ctx,
    dispatcher,
    dispatchOperationSessionKey,
    initialDispatchReplyOperation,
    messageAuditTerminal,
    operationSessionStoreEntry,
    replyOptions: normalizedParams.replyOptions,
    resolveOperationExpectedSessionId,
    routeThreadId,
    sessionWorkerPlacementContext: normalizedParams.sessionWorkerPlacementContext,
  });
  const {
    completeDispatchReplyOperation,
    dispatchHookDispatcher,
    ensureDispatchReplyOperation,
    failDispatchReplyOperation,
    getAgentRunTerminalOutcome,
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
    turnLedger,
  } = replyOperationCoordinator;
  const maybeApplyTtsWithFinalizationLease = createFinalizationAwareTtsPayloadApplier({
    getReplyOperation: getDispatchReplyOperation,
    hasInboundAudio: () =>
      inboundAudio || getDispatchReplyOperation()?.acceptedSteeredInboundAudio === true,
  });
  const pluginRegistry =
    preparedReplyDispatchRuntime?.inboundPluginRegistry ??
    (await traceReplyPhase("reply.load_runtime_plugin_registry_handle", async () => {
      const { loadAgentRuntimePluginRegistryHandle } = await traceReplyPhase(
        "reply.load_runtime_plugins",
        loadRuntimePlugins,
      );
      return loadAgentRuntimePluginRegistryHandle({
        config: cfg,
        workspaceDir,
        allowGatewaySubagentBinding: true,
      });
    }));
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
    const inboundClaim = toPluginInboundClaimPair(nextHookContext, {
      commandAuthorized:
        typeof ctx.CommandAuthorized === "boolean" ? ctx.CommandAuthorized : undefined,
      wasMentioned: typeof ctx.WasMentioned === "boolean" ? ctx.WasMentioned : undefined,
    });
    return {
      hookContext: nextHookContext,
      inboundClaimContext: inboundClaim.context,
      inboundClaimEvent: inboundClaim.event,
    };
  };
  const hookState = buildHookState(hookCtx);
  const { isGroup, groupId } = hookState.hookContext;
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
        agentId: sessionAgentId,
        sessionKey: acpDispatchSessionKey,
        workspaceDir,
        remoteMediaMode: "cache",
      }),
    );
    if (staged) {
      hookMediaMetadataStaged = true;
      Object.assign(hookState, buildHookState(hookCtx));
    }
  };
  const buildMessageReceivedHookContext = () => {
    const mediaRemoteHost = normalizeOptionalString(ctx.MediaRemoteHost);
    const { hookContext } = hookState;
    const hasUnstagedRemoteMediaMetadata = Boolean(hookContext.media?.length);
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
      originalMedia: hookContext.media?.map((entry) => ({ ...entry })),
      originalMediaPath: hookContext.mediaPath,
      originalMediaUrl: hookContext.mediaUrl,
      originalMediaType: hookContext.mediaType,
      originalMediaPaths: hookContext.mediaPaths,
      originalMediaUrls: hookContext.mediaUrls,
      originalMediaTypes: hookContext.mediaTypes,
    };
  };
  const nextState = extendPreparedDispatchState(state, {
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
    dispatchKind,
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
    preparedReplyDispatchRuntime,
    pluginRegistry,
    replyOperationRunState,
    completeDispatchReplyOperation,
    dispatchHookDispatcher,
    ensureDispatchReplyOperation,
    failDispatchReplyOperation,
    getAgentRunTerminalOutcome,
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
    turnLedger,
    maybeApplyTtsWithFinalizationLease,
    hookRunner,
    timestamp,
    messageIdForHook,
    isGroup,
    groupId,
    hookState,
    prepareHookMediaMetadata,
    buildMessageReceivedHookContext,
  });
  return { status: "ready" as const, state: nextState };
}

type GatherDispatchRequestResult = Awaited<ReturnType<typeof gatherDispatchRequest>>;
export type GatherDispatchRequestReadyState = Extract<
  GatherDispatchRequestResult,
  { status: "ready" }
>["state"];
