import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { clearAutoFallbackPrimaryProbeSelection } from "../../agents/agent-scope.js";
import { resolveSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../../agents/openai-routing.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { logVerbose } from "../../globals.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { clearCommandLane, getQueueSize } from "../../process/command-queue.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  normalizeThinkLevel,
  resolveSupportedThinkingLevel,
} from "../thinking.js";
import type { PreparedReplyRunContext } from "./get-reply-run-context.js";
import {
  hasResolvedThinkingCatalogEntry,
  loadAgentRunnerRuntime,
  loadEmbeddedAgentRuntime,
  loadSessionUpdatesRuntime,
  routeThreadIdsMatch,
} from "./get-reply-run-helpers.js";
import { resolvePreparedReplyQueueState } from "./get-reply-run-queue.js";
import { buildReplyPromptEnvelope } from "./prompt-prelude.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import { resolveQueueSettings } from "./queue/settings-runtime.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  abortReplyRunBySessionId,
  isReplyRunActiveForSessionId,
  isReplyRunStreamingForSessionId,
  resolveActiveReplyRunThreadId,
  resolveActiveReplyRunSessionId,
  waitForReplyRunEndBySessionId,
} from "./reply-run-registry.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import {
  isSlackDirectRoutedThreadTurn,
  resolveRoutedDeliveryThreadId,
} from "./routed-delivery-thread.js";
import { drainFormattedSystemEvents } from "./session-system-events.js";

export async function prepareReplyRunAdmission(context: PreparedReplyRunContext) {
  const {
    params,
    traceRunPhase,
    inboundEventKind,
    sourceReplyDeliveryMode,
    useFastReplyRuntime,
    thinkingRuntime,
    isFirstTurnInSession,
    baseBodyFinal,
    hasUserBody,
    isBareSessionReset,
    startupAction,
    startupContextPrelude,
    softResetTail,
    workspaceDir,
    isMainSession,
    inboundUserContextPromptJoiner,
    heartbeatRunScope,
    effectiveQueueMode,
    effectiveResetTriggered,
    explicitThinkingLevelOverride,
    refreshInboundContextAfterAdmissionWait,
  } = context;
  const {
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    directives,
    modelState,
    provider,
    model,
    perMessageQueueOptions,
    typing,
    opts,
    isNewSession,
    sessionKey,
    sessionId,
    storePath,
    sessionEntryHandle,
    sessionStore,
  } = params;
  let { sessionEntry, prefixedBodyBase } = context;
  let { resolvedThinkLevel } = params;

  // Extract first-token think hint from the user body BEFORE prepending system events.
  // If done after, the System: prefix becomes parts[0] and silently shadows any
  // low|medium|high shorthand the user typed.
  if (!resolvedThinkLevel && prefixedBodyBase) {
    const parts = prefixedBodyBase.split(/\s+/);
    const maybeLevel = normalizeThinkLevel(parts[0]);
    const thinkingCatalog = maybeLevel
      ? await traceRunPhase("reply.resolve_thinking_catalog_for_hint", () =>
          modelState.resolveThinkingCatalog(),
        )
      : undefined;
    if (
      maybeLevel &&
      isThinkingLevelSupported({
        provider,
        model,
        level: maybeLevel,
        catalog: thinkingCatalog,
        agentRuntime: thinkingRuntime,
      })
    ) {
      resolvedThinkLevel = maybeLevel;
      prefixedBodyBase = parts.slice(1).join(" ").trim();
    }
  }
  const prefixedBodyCore = prefixedBodyBase;
  const threadStarterBody = normalizeOptionalString(ctx.ThreadStarterBody);
  const threadHistoryBody = normalizeOptionalString(ctx.ThreadHistoryBody);
  const threadContextNote = threadHistoryBody
    ? `[Thread history - for context]\n${threadHistoryBody}`
    : !isNewSession && threadStarterBody
      ? `[Thread starter - for context]\n${threadStarterBody}`
      : undefined;
  const drainedSystemEventBlocks: string[] = [];
  const rebuildPromptBodies = async () => {
    if (!useFastReplyRuntime && heartbeatRunScope !== "commitment-only") {
      const eventsBlock = await drainFormattedSystemEvents({
        cfg,
        sessionKey,
        isMainSession,
        isNewSession,
        suppressHeartbeatOwnedEvents: context.isHeartbeat,
      });
      if (eventsBlock) {
        drainedSystemEventBlocks.push(eventsBlock);
      }
    }
    const { activeGoalContext, inboundUserContext } = context.getInboundContext();
    return buildReplyPromptEnvelope({
      ctx,
      sessionCtx,
      baseBody: baseBodyFinal,
      prefixedBody: prefixedBodyCore,
      hasUserBody,
      inboundUserContext,
      activeGoalContext,
      inboundUserContextPromptJoiner,
      isBareSessionReset,
      startupAction,
      startupContextPrelude,
      softResetTail,
      isHeartbeat: context.isHeartbeat,
      inboundEventKind,
      sourceReplyDeliveryMode,
      threadContextNote,
      systemEventBlocks: drainedSystemEventBlocks,
      media: opts?.media,
    });
  };
  const skillResult = isFastTestRuntimeEnv()
    ? {
        sessionEntry,
        skillsSnapshot: sessionEntry?.skillsSnapshot,
      }
    : await traceRunPhase("reply.ensure_skill_snapshot", async () => {
        const { ensureSkillSnapshot } = await loadSessionUpdatesRuntime();
        return await ensureSkillSnapshot({
          sessionEntry,
          sessionEntryHandle,
          sessionStore,
          sessionKey,
          storePath,
          sessionId,
          isFirstTurnInSession,
          workspaceDir,
          cfg,
          execOverrides: params.execOverrides,
          skillFilter: opts?.skillFilter,
          skillOverrides: opts?.skillOverrides,
        });
      });
  sessionEntry = skillResult.sessionEntry;
  if (sessionEntry) {
    sessionEntryHandle?.replaceCurrent(sessionEntry);
  }
  const skillsSnapshot = skillResult.skillsSnapshot;
  let {
    prefixedCommandBody,
    queuedBody,
    transcriptBody,
    transcriptCommandBody,
    media: promptMedia,
    currentInboundContext,
  } = await traceRunPhase("reply.build_prompt_bodies", () => rebuildPromptBodies());
  const isRoomEvent = inboundEventKind === "room_event";
  if (!resolvedThinkLevel) {
    resolvedThinkLevel = await traceRunPhase("reply.resolve_default_thinking", () =>
      modelState.resolveDefaultThinkingLevel(),
    );
  }
  const allowedThinkingCatalog = modelState.allowedModelCatalog ?? [];
  let thinkingCatalog = allowedThinkingCatalog.length > 0 ? allowedThinkingCatalog : undefined;
  let thinkingLevelSupported = isThinkingLevelSupported({
    provider,
    model,
    level: resolvedThinkLevel,
    catalog: thinkingCatalog,
    agentRuntime: thinkingRuntime,
  });
  const shouldHydrateThinkingCatalog =
    !thinkingLevelSupported ||
    (resolvedThinkLevel !== "off" &&
      !hasResolvedThinkingCatalogEntry({ catalog: thinkingCatalog, provider, model }));
  if (shouldHydrateThinkingCatalog) {
    // Hydrate the runtime model catalog only when the lightweight catalog cannot
    // prove support or lacks reasoning metadata for the selected model. The full
    // catalog load was a 14s+ reply-blocking cost for known Codex models that
    // already publish authoritative thinking metadata.
    thinkingCatalog = await traceRunPhase("reply.resolve_thinking_catalog", () =>
      modelState.resolveThinkingCatalog(),
    );
    thinkingLevelSupported = isThinkingLevelSupported({
      provider,
      model,
      level: resolvedThinkLevel,
      catalog: thinkingCatalog,
      agentRuntime: thinkingRuntime,
    });
  }
  if (!thinkingLevelSupported) {
    const explicitThink =
      (directives.hasThinkDirective && directives.thinkLevel !== undefined) ||
      explicitThinkingLevelOverride !== undefined;
    if (explicitThink) {
      typing.cleanup();
      return {
        kind: "reply",
        reply: {
          text: `Thinking level "${resolvedThinkLevel}" is not supported for ${provider}/${model}. Use one of: ${formatThinkingLevels(provider, model, ", ", thinkingCatalog, thinkingRuntime)}.`,
        },
      } as const;
    }
    const fallbackThinkLevel = resolveSupportedThinkingLevel({
      provider,
      model,
      level: resolvedThinkLevel,
      catalog: thinkingCatalog,
      agentRuntime: thinkingRuntime,
    });
    if (fallbackThinkLevel !== resolvedThinkLevel) {
      // Execution fallbacks are turn-local; directive/model persistence owns
      // durable thinking remaps so explicit session overrides survive replies.
      resolvedThinkLevel = fallbackThinkLevel;
    }
  }

  const providedReplyOperation = opts?.replyOperation;
  // Native command turns reserve their operation under the slash SOURCE key so
  // commands never contend with the target's active run (#104144). When such a
  // turn continues into a full agent turn (/steer fallback, /goal, /learn,
  // unhandled body), it mutates the TARGET session: it must adopt the target's
  // run slot before running or concurrent target inbounds double-admit and
  // split the session (#104844).
  const commandTurnContinuationTargetKey =
    providedReplyOperation !== undefined &&
    providedReplyOperation.result === null &&
    providedReplyOperation.phase === "queued" &&
    sessionKey !== undefined &&
    providedReplyOperation.key !== sessionKey &&
    resolveCommandTurnTargetSessionKey(ctx) !== undefined
      ? sessionKey
      : undefined;
  if (
    commandTurnContinuationTargetKey === undefined &&
    providedReplyOperation !== undefined &&
    providedReplyOperation.result === null &&
    providedReplyOperation.phase === "queued" &&
    sessionId !== undefined &&
    sessionId !== providedReplyOperation.sessionId
  ) {
    // Dispatch reserves a queued operation before session init. If stale init
    // rotates the session, move the reservation so later steer/abort paths
    // target the session that will actually run. Command-turn continuations
    // rebind after slot adoption below: rebinding first would collide with a
    // still-active target operation that owns the same session ID.
    providedReplyOperation.updateSessionId(sessionId);
  }
  const isOwnPreDispatchOperationSession = (candidateSessionId: string | undefined): boolean =>
    providedReplyOperation !== undefined &&
    providedReplyOperation.result === null &&
    providedReplyOperation.phase === "queued" &&
    candidateSessionId === providedReplyOperation.sessionId;
  const sessionIdFinal = sessionId ?? providedReplyOperation?.sessionId ?? crypto.randomUUID();
  const sessionFilePathOptions = resolveSessionFilePathOptions({ agentId, storePath });
  const resolvePreparedSessionState = (): {
    sessionEntry: SessionEntry | undefined;
    sessionId: string;
    sessionFile: string;
  } => {
    // Working-set exact key first; disk alias resolve only when storePath known.
    // No whole-map scan — that encodes the store layout the accessor hides.
    const latestSessionEntry =
      sessionStore && sessionKey
        ? (sessionStore[sessionKey] ??
          (storePath
            ? loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" })
            : undefined) ??
          sessionEntry)
        : sessionEntry;
    const latestSessionId = latestSessionEntry?.sessionId ?? sessionIdFinal;
    opts?.onSessionPrepared?.({ sessionKey, sessionId: latestSessionId, storePath });
    const sessionFile = storePath
      ? formatSqliteSessionFileMarker({ agentId, sessionId: latestSessionId, storePath })
      : resolveSessionFilePath(latestSessionId, latestSessionEntry, sessionFilePathOptions);
    return { sessionEntry: latestSessionEntry, sessionId: latestSessionId, sessionFile };
  };
  let preparedSessionState = resolvePreparedSessionState();
  const resolvedQueue = useFastReplyRuntime
    ? { mode: "collect" as const, debounceMs: 0, cap: 1, dropPolicy: "summarize" as const }
    : resolveQueueSettings({
        cfg,
        channel: sessionCtx.Provider,
        sessionEntry,
        inlineMode: effectiveQueueMode,
        inlineOptions: perMessageQueueOptions,
      });
  const embeddedAgentRuntime = useFastReplyRuntime
    ? null
    : await traceRunPhase("reply.load_embedded_agent_runtime", () => loadEmbeddedAgentRuntime());
  const resolveActiveEmbeddedSessionId = (sessionFile = preparedSessionState.sessionFile) =>
    embeddedAgentRuntime?.resolveActiveEmbeddedRunSessionId(sessionKey) ??
    embeddedAgentRuntime?.resolveActiveEmbeddedRunSessionIdBySessionFile?.(sessionFile);
  const sessionLaneKey = embeddedAgentRuntime
    ? embeddedAgentRuntime.resolveEmbeddedSessionLane(sessionKey ?? sessionIdFinal)
    : undefined;
  const laneSize = sessionLaneKey ? getQueueSize(sessionLaneKey) : 0;
  const activeRunQueueMode = effectiveResetTriggered ? "interrupt" : resolvedQueue.mode;
  const rawActiveSessionIdForInterrupt = resolveActiveEmbeddedSessionId();
  const activeSessionIdForInterrupt = isOwnPreDispatchOperationSession(
    rawActiveSessionIdForInterrupt,
  )
    ? undefined
    : rawActiveSessionIdForInterrupt;
  if (
    activeRunQueueMode === "interrupt" &&
    !isRoomEvent &&
    sessionLaneKey &&
    (laneSize > 0 || activeSessionIdForInterrupt)
  ) {
    const cleared = clearCommandLane(sessionLaneKey);
    const aborted = embeddedAgentRuntime?.abortEmbeddedAgentRun(
      activeSessionIdForInterrupt ?? preparedSessionState.sessionId,
    );
    logVerbose(`Interrupting ${sessionLaneKey} (cleared ${cleared}, aborted=${aborted})`);
  }
  const agentHarnessPolicy = useFastReplyRuntime
    ? undefined
    : resolveAgentHarnessPolicy({
        provider,
        modelId: model,
        config: cfg,
        agentId,
        sessionKey: context.runtimePolicySessionKey,
      });
  const resolveAcceptedAuthProfileProviders = () =>
    agentHarnessPolicy
      ? listOpenAIAuthProfileProvidersForAgentRuntime({
          provider,
          harnessRuntime: agentHarnessPolicy.runtime,
          config: cfg,
        })
      : [provider];
  const resolveRuntimeAuthProfile = async () => {
    if (useFastReplyRuntime) {
      return {
        authProfileId: preparedSessionState.sessionEntry?.authProfileOverride,
        authProfileIdSource: preparedSessionState.sessionEntry?.authProfileOverrideSource,
      };
    }
    const shouldUseEphemeralSession = params.autoFallbackPrimaryProbe !== undefined;
    const authSessionKey = shouldUseEphemeralSession ? (sessionKey ?? sessionIdFinal) : sessionKey;
    const authSessionEntry =
      shouldUseEphemeralSession && preparedSessionState.sessionEntry
        ? { ...preparedSessionState.sessionEntry }
        : preparedSessionState.sessionEntry;
    if (params.autoFallbackPrimaryProbe && authSessionEntry) {
      clearAutoFallbackPrimaryProbeSelection(authSessionEntry);
    }
    const authSessionStore =
      shouldUseEphemeralSession && authSessionEntry
        ? { [authSessionKey]: authSessionEntry }
        : sessionStore;
    const resolvedAuthProfileId = await resolveSessionAuthProfileOverride({
      cfg,
      provider,
      acceptedProviderIds: resolveAcceptedAuthProfileProviders(),
      agentDir,
      sessionEntry: authSessionEntry,
      sessionStore: authSessionStore,
      sessionKey: authSessionKey,
      storePath: shouldUseEphemeralSession ? undefined : storePath,
      isNewSession,
    });
    return {
      authProfileId: resolvedAuthProfileId,
      authProfileIdSource:
        resolvedAuthProfileId && authSessionEntry?.authProfileOverride === resolvedAuthProfileId
          ? authSessionEntry.authProfileOverrideSource
          : undefined,
    };
  };
  let { authProfileId, authProfileIdSource } = await traceRunPhase(
    "reply.resolve_auth_profile",
    () => resolveRuntimeAuthProfile(),
  );
  const { runReplyAgent } = await traceRunPhase("reply.load_agent_runner_runtime", () =>
    loadAgentRunnerRuntime(),
  );
  const queueKey = sessionKey ?? sessionIdFinal;
  preparedSessionState = resolvePreparedSessionState();
  const currentRouteThreadId = resolveRoutedDeliveryThreadId({ ctx, sessionKey });
  const applySlackRouteThreadSteeringGuard = isSlackDirectRoutedThreadTurn(ctx);
  const resolveActiveRunAcceptsCurrentThread = (busy: { isActive: boolean }) => {
    if (!busy.isActive || !sessionKey || !applySlackRouteThreadSteeringGuard) {
      return true;
    }
    return routeThreadIdsMatch(resolveActiveReplyRunThreadId(sessionKey), currentRouteThreadId);
  };
  const resolveActiveReplyOperationSessionId = () =>
    sessionKey ? resolveActiveReplyRunSessionId(sessionKey) : undefined;
  const resolveActiveQueueSessionId = () =>
    resolveActiveEmbeddedSessionId() ??
    resolveActiveReplyOperationSessionId() ??
    preparedSessionState.sessionId;
  const resolveQueueBusyState = () => {
    const embeddedActiveSessionId = resolveActiveEmbeddedSessionId();
    const replyOperationActiveSessionId = resolveActiveReplyOperationSessionId();
    const activeSessionId =
      embeddedActiveSessionId ?? replyOperationActiveSessionId ?? preparedSessionState.sessionId;
    if (!activeSessionId || (!embeddedAgentRuntime && !replyOperationActiveSessionId)) {
      return { activeSessionId: undefined, isActive: false, isStreaming: false };
    }
    if (isOwnPreDispatchOperationSession(activeSessionId)) {
      return { activeSessionId, isActive: false, isStreaming: false };
    }
    const replyOperationActive =
      replyOperationActiveSessionId != null &&
      isReplyRunActiveForSessionId(replyOperationActiveSessionId);
    return {
      activeSessionId,
      isActive:
        (embeddedActiveSessionId != null &&
          (embeddedAgentRuntime?.isEmbeddedAgentRunActive(embeddedActiveSessionId) ?? false)) ||
        replyOperationActive,
      isStreaming:
        (embeddedActiveSessionId != null &&
          (embeddedAgentRuntime?.isEmbeddedAgentRunStreaming(embeddedActiveSessionId) ?? false)) ||
        (replyOperationActiveSessionId != null &&
          isReplyRunStreamingForSessionId(replyOperationActiveSessionId)),
    };
  };
  if (commandTurnContinuationTargetKey && providedReplyOperation) {
    const adoption = await admitReplyTurn({
      sessionKey: commandTurnContinuationTargetKey,
      sessionId: providedReplyOperation.sessionId,
      expectedSessionId: preparedSessionState.sessionEntry?.sessionId,
      storePath,
      kind: "visible",
      resetTriggered: effectiveResetTriggered,
      routeThreadId: currentRouteThreadId,
      upstreamAbortSignal: opts?.abortSignal,
      // Never wait on the target's active turn: a blocked continuation would
      // re-create the #104142 command-lane wedge. When the slot is owned, the
      // queue policy below sees the target-keyed owner and steers/queues this
      // turn instead of running it concurrently.
      waitForActive: false,
      adoptOperation: providedReplyOperation,
    });
    if (adoption.status === "skipped" && adoption.reason === "aborted") {
      typing.cleanup();
      return { kind: "reply", reply: undefined } as const;
    }
    if (
      adoption.status === "owned" &&
      sessionId !== undefined &&
      sessionId !== providedReplyOperation.sessionId
    ) {
      providedReplyOperation.updateSessionId(sessionId);
    }
  }
  const { activeSessionId, isActive, isStreaming } = resolveQueueBusyState();
  const activeRunAcceptsCurrentThread = resolveActiveRunAcceptsCurrentThread({ isActive });
  const shouldSteer =
    !isRoomEvent &&
    activeRunAcceptsCurrentThread &&
    !context.isHeartbeat &&
    !effectiveResetTriggered &&
    resolvedQueue.mode === "steer";
  const shouldFollowup =
    !effectiveResetTriggered &&
    ((isRoomEvent && isActive) ||
      resolvedQueue.mode === "steer" ||
      resolvedQueue.mode === "followup" ||
      resolvedQueue.mode === "collect");
  const activeRunQueueAction = resolveActiveRunQueueAction({
    isActive,
    isHeartbeat: context.isHeartbeat,
    shouldFollowup,
    queueMode: activeRunQueueMode,
    resetTriggered: effectiveResetTriggered,
  });
  if (isActive && activeRunQueueAction === "run-now") {
    const queueState = await resolvePreparedReplyQueueState({
      activeRunQueueAction,
      activeSessionId: activeSessionId ?? resolveActiveQueueSessionId(),
      queueMode: activeRunQueueMode,
      sessionKey,
      sessionId: sessionIdFinal,
      abortActiveRun: (activeRunSessionId) => {
        const embeddedAborted =
          embeddedAgentRuntime?.abortEmbeddedAgentRun(activeRunSessionId) ?? false;
        const replyOperationAborted = abortReplyRunBySessionId(activeRunSessionId);
        return embeddedAborted || replyOperationAborted;
      },
      waitForActiveRunEnd: (activeRunSessionId) =>
        isReplyRunActiveForSessionId(activeRunSessionId)
          ? waitForReplyRunEndBySessionId(activeRunSessionId, REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS)
          : (embeddedAgentRuntime?.waitForEmbeddedAgentRunEnd(activeRunSessionId) ??
            Promise.resolve(undefined)),
      refreshPreparedState: async () => {
        preparedSessionState = resolvePreparedSessionState();
        ({ authProfileId, authProfileIdSource } = await resolveRuntimeAuthProfile());
        preparedSessionState = resolvePreparedSessionState();
        // The interrupted run may have changed goal or suggestion state while admission waited.
        await refreshInboundContextAfterAdmissionWait();
        sessionEntry = context.getSessionEntry();
        ({
          prefixedCommandBody,
          queuedBody,
          transcriptBody,
          transcriptCommandBody,
          media: promptMedia,
          currentInboundContext,
        } = await traceRunPhase("reply.build_prompt_bodies", () => rebuildPromptBodies()));
      },
      resolveBusyState: resolveQueueBusyState,
    });
    if (queueState.kind === "reply") {
      typing.cleanup();
      return { kind: "reply", reply: queueState.reply } as const;
    }
  }

  return {
    kind: "ready",
    context,
    resolvedThinkLevel,
    sessionEntry,
    skillsSnapshot,
    prefixedCommandBody,
    queuedBody,
    transcriptBody,
    transcriptCommandBody,
    promptMedia,
    currentInboundContext,
    isRoomEvent,
    providedReplyOperation,
    sessionIdFinal,
    preparedSessionState,
    resolvedQueue,
    embeddedAgentRuntime,
    resolveActiveEmbeddedSessionId,
    resolvePreparedSessionState,
    runReplyAgent,
    queueKey,
    shouldSteer,
    shouldFollowup,
    isActive,
    isStreaming,
    authProfileId,
    authProfileIdSource,
  } as const;
}

export type PreparedReplyRunAdmission = Extract<
  Awaited<ReturnType<typeof prepareReplyRunAdmission>>,
  { kind: "ready" }
>;
