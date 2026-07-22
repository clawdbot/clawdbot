import {
  buildHarnessContextEngineRuntimeContextFromUsage,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  embeddedAgentLog,
  finalizeHarnessContextEngineTurn,
  formatErrorMessage,
  resolveContextEngineOwnerPluginId,
  runAgentHarnessLlmOutputHook,
  runHarnessContextEngineMaintenance,
  type EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readMirroredSessionHistoryMessages } from "./attempt-context.js";
import { classifyCodexModelCallFailureKind } from "./attempt-diagnostics.js";
import {
  buildCodexAppServerPromptTimeoutOutcome,
  collectTerminalAssistantText,
  isInvalidCodexImagePayloadError,
  resolveCodexAppServerReplayBlockedReason,
} from "./attempt-results.js";
import { readCodexRateLimitsRevision, readRecentCodexRateLimits } from "./rate-limit-cache.js";
import type { CodexAttemptActiveTurn } from "./run-attempt-active-turn.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import {
  emitCodexAppServerEvent,
  runCodexAgentEndHook,
  shouldKeepCodexSharedAbortOpen,
} from "./run-attempt-lifecycle.js";
import type { CodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import {
  buildCodexAppServerTimeoutDiagnostics,
  clearCodexBindingAfterInvalidImagePayload,
  markCodexAppServerBindingCoveredThroughTurn,
  shouldUseFreshCodexThreadAfterContextEngineOverflow,
} from "./run-attempt-state.js";
import type { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { captureCodexSettledTurnFinalizationContext } from "./settled-turn-context.js";
import { settleCodexSourceReplyFinality } from "./source-reply-finality.js";
import { normalizeCodexTrajectoryError, recordCodexTrajectoryCompletion } from "./trajectory.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";
import {
  createCodexUsageLimitPromptError,
  isCodexUsageLimitPromptError,
  markCodexAuthProfileBlockedFromRateLimits,
  refreshCodexUsageLimitPromptError,
} from "./usage-limit-error.js";

export async function finalizeCodexAttempt(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  lifecycle: CodexAttemptLifecycleController,
  notifications: CodexAttemptNotificationController,
  requestRuntime: Awaited<ReturnType<typeof prepareCodexAttemptTurnRequest>>,
  activeTurn: CodexAttemptActiveTurn,
): Promise<EmbeddedRunAttemptResult> {
  const { prompt, state: resourceState, trajectoryRecorder, markTrajectoryEndRecorded } = resources;
  const { context, systemPromptReport } = prompt;
  const { runtime, attemptTools, activeTranscriptTarget, historyState, hookContext } = context;
  const { hookContextWindowFields, hookRunner, promptState } = context;
  const { connection, preparedAuthBinding, activeSessionId, activeSessionFile } = runtime;
  const {
    buildActiveRunAttemptParams,
    effectiveContextTokenBudget,
    effectiveRuntimeProviderId,
    effectiveRuntimeModelId,
  } = runtime;
  const {
    params,
    terminalState,
    runAbortController,
    activeContextEngine,
    bindingStore,
    bindingIdentity,
    appServer,
    usesSupervisionConnection,
    sessionAgentId,
    contextSessionKey,
    effectiveCwd,
    effectiveWorkspace,
    agentDir,
    attemptStartedAt,
    startupAuthProfileId,
  } = connection;
  const { toolBridge, toolState } = attemptTools;
  const {
    state,
    completion,
    pendingOpenClawDynamicToolCompletionIds,
    activeTurnItemIds,
    activeCompletionBlockerItemIds,
    activeFinalizationHookRunIds,
    turnWatches,
  } = turnRuntime;
  const { emitLifecycleTerminal, buildLifecycleTerminalMeta } = lifecycle;
  const { drainNotificationQueue } = notifications;
  const { codexModelCallDiagnostics } = requestRuntime;
  const {
    activeTurnId,
    activeProjector,
    streamState,
    freezeRunTerminalOutcome,
    notifyUserMessagePersisted,
  } = activeTurn;
  await completion;
  // Include projection work already queued when timeout completion wins.
  await drainNotificationQueue();
  const hasQuiescentCompletedAssistant =
    activeProjector.hasCompletedTerminalAssistantText() &&
    state.activeAppServerTurnRequests === 0 &&
    activeTurnItemIds.size === 0 &&
    activeCompletionBlockerItemIds.size === 0 &&
    pendingOpenClawDynamicToolCompletionIds.size === 0 &&
    activeFinalizationHookRunIds.size === 0 &&
    state.unsettledFinalizationHookCount === 0 &&
    state.rejectedFinalizationHookAssistant === undefined;
  const hasRecoverableCompletedAssistant =
    !turnWatches.isCompletionIdleWatchPinnedByTerminalError() &&
    turnWatches.isAssistantCompletionIdleWatchArmed() &&
    hasQuiescentCompletedAssistant;
  const recoveredTurnWatchTimeout =
    state.turnCompletionIdleTimedOut &&
    !terminalState.explicitCancellationObserved &&
    !state.terminalTurnNotificationQueued &&
    hasRecoverableCompletedAssistant &&
    activeProjector.recoverCompletedTerminalAssistantAfterTurnWatchTimeout();
  if (recoveredTurnWatchTimeout) {
    embeddedAgentLog.warn(
      "codex app-server recovered completed assistant output after missing turn completion",
      {
        threadId: resourceState.thread.threadId,
        turnId: activeTurnId,
        timeoutKind: state.turnWatchTimeoutKind,
        idleMs: state.turnWatchTimeoutIdleMs,
        timeoutMs: state.turnWatchTimeoutMs,
      },
    );
    trajectoryRecorder?.recordEvent("turn.watch_timeout_recovered", {
      threadId: resourceState.thread.threadId,
      turnId: activeTurnId,
      timeoutKind: state.turnWatchTimeoutKind,
      idleMs: state.turnWatchTimeoutIdleMs,
      timeoutMs: state.turnWatchTimeoutMs,
    });
  }
  const result = activeProjector.buildResult(toolBridge.telemetry, {
    yieldDetected: toolState.yieldDetected,
  });
  const effectiveTimedOut = state.timedOut && !recoveredTurnWatchTimeout;
  const effectiveTurnCompletionIdleTimedOut =
    state.turnCompletionIdleTimedOut && !recoveredTurnWatchTimeout;
  const isFinalAborted = () =>
    result.aborted ||
    terminalState.explicitCancellationObserved ||
    (runAbortController.signal.aborted && !state.clientClosedAbort && !recoveredTurnWatchTimeout);
  const clientClosedPromptErrorForFinal =
    state.clientClosedPromptError && hasRecoverableCompletedAssistant
      ? undefined
      : state.clientClosedPromptError;
  let finalPromptError =
    clientClosedPromptErrorForFinal ??
    (effectiveTurnCompletionIdleTimedOut
      ? state.turnCompletionIdleTimeoutMessage
      : effectiveTimedOut
        ? "codex app-server attempt timed out"
        : result.promptError);
  const finalPromptErrorMessage =
    typeof finalPromptError === "string"
      ? finalPromptError
      : finalPromptError instanceof Error
        ? finalPromptError.message
        : finalPromptError
          ? formatErrorMessage(finalPromptError)
          : undefined;
  if (isInvalidCodexImagePayloadError(finalPromptErrorMessage)) {
    await clearCodexBindingAfterInvalidImagePayload(bindingStore, bindingIdentity, {
      phase: "turn_completed",
      threadId: resourceState.thread.threadId,
      turnId: activeTurnId,
      error: finalPromptErrorMessage,
    });
  }
  if (
    resourceState.thread.connectionScope !== "supervision" &&
    shouldUseFreshCodexThreadAfterContextEngineOverflow({
      error: finalPromptError,
      contextEngineActive: Boolean(activeContextEngine),
      thread: resourceState.thread,
    })
  ) {
    embeddedAgentLog.warn(
      "codex app-server context-engine turn overflowed after resume; clearing thread binding for recovery",
      {
        threadId: resourceState.thread.threadId,
        turnId: activeTurnId,
        error: finalPromptErrorMessage,
      },
    );
    await bindingStore.mutate(bindingIdentity, {
      kind: "clear",
      threadId: resourceState.thread.threadId,
    });
  }
  const refreshedUsageLimitPromptError = await refreshCodexUsageLimitPromptError({
    client: resourceState.client,
    message: finalPromptErrorMessage,
    timeoutMs: appServer.requestTimeoutMs,
    signal: runAbortController.signal,
  });
  if (refreshedUsageLimitPromptError) {
    await markCodexAuthProfileBlockedFromRateLimits({
      params,
      authProfileId: startupAuthProfileId,
      rateLimits: refreshedUsageLimitPromptError.rateLimitsForProfile,
    });
    finalPromptError = createCodexUsageLimitPromptError(refreshedUsageLimitPromptError.message);
  } else if (
    isCodexUsageLimitPromptError(finalPromptError) &&
    state.rateLimitsRevisionBeforeLastTurnStart !== undefined &&
    readCodexRateLimitsRevision(resourceState.client) > state.rateLimitsRevisionBeforeLastTurnStart
  ) {
    await markCodexAuthProfileBlockedFromRateLimits({
      params,
      authProfileId: startupAuthProfileId,
      rateLimits: readRecentCodexRateLimits(resourceState.client),
    });
  }
  const finalPromptErrorSource =
    effectiveTimedOut || clientClosedPromptErrorForFinal ? "prompt" : result.promptErrorSource;
  const codexAppServerFailureKind = clientClosedPromptErrorForFinal
    ? "client_closed_before_turn_completed"
    : effectiveTurnCompletionIdleTimedOut
      ? "turn_completion_idle_timeout"
      : undefined;
  const replayBlockedReason = codexAppServerFailureKind
    ? resolveCodexAppServerReplayBlockedReason(result)
    : undefined;
  const promptTimeoutOutcome = buildCodexAppServerPromptTimeoutOutcome({
    result,
    turnCompletionIdleTimedOut: effectiveTurnCompletionIdleTimedOut,
    turnWatchTimeoutKind: state.turnWatchTimeoutKind,
  });
  const failureDiagnostics =
    codexAppServerFailureKind === "turn_completion_idle_timeout" &&
    state.turnWatchTimeoutKind === "completion"
      ? buildCodexAppServerTimeoutDiagnostics({
          idleMs: state.turnWatchTimeoutIdleMs,
          timeoutMs: state.turnWatchTimeoutMs,
          lastActivityReason: state.turnWatchTimeoutLastActivityReason,
          details: state.turnWatchTimeoutDetails,
        })
      : undefined;
  const codexAppServerFailure = codexAppServerFailureKind
    ? ({
        kind: codexAppServerFailureKind,
        ...(codexAppServerFailureKind === "turn_completion_idle_timeout" &&
        state.turnWatchTimeoutKind
          ? { turnWatchTimeoutKind: state.turnWatchTimeoutKind }
          : {}),
        transport: appServer.start.transport,
        threadId: resourceState.thread.threadId,
        turnId: activeTurnId,
        replaySafe: replayBlockedReason === undefined,
        ...(replayBlockedReason ? { replayBlockedReason } : {}),
        ...(failureDiagnostics ? { diagnostics: failureDiagnostics } : {}),
      } satisfies NonNullable<EmbeddedRunAttemptResult["codexAppServerFailure"]>)
    : undefined;
  const finalAborted = isFinalAborted();
  const completedTurnStatus = activeProjector.getCompletedTurnStatus();
  const completedWithoutTerminalNotification =
    state.completed &&
    !state.terminalTurnNotificationQueued &&
    !state.timedOut &&
    clientClosedPromptErrorForFinal === undefined;
  const turnSucceeded =
    !finalAborted &&
    !effectiveTimedOut &&
    (finalPromptError === null || finalPromptError === undefined) &&
    (completedTurnStatus === "completed" ||
      recoveredTurnWatchTimeout ||
      completedWithoutTerminalNotification);
  // buildResult retains the bridge's delivery records. Resolve omitted final
  // intent only after the authoritative turn outcome is known, before any
  // terminal observer consumes the result.
  const completedSourceReply = settleCodexSourceReplyFinality(toolBridge.telemetry, turnSucceeded);
  if (completedSourceReply) {
    // Harness classification only sees assistant/reasoning/plan projections.
    // A reply delivered entirely through the source message tool is visible
    // output, so an empty/reasoning-only classification is stale at this point.
    result.agentHarnessResultClassification = undefined;
  }
  const attemptSucceeded = turnSucceeded && result.agentHarnessResultClassification === undefined;
  terminalState.sharedAbortAllowedAfterTerminalOutcome = shouldKeepCodexSharedAbortOpen({
    trigger: params.trigger,
    result,
    attemptSucceeded,
    explicitCancellationObserved: terminalState.explicitCancellationObserved,
  });
  // Every terminal observer must see the same immutable outcome.
  freezeRunTerminalOutcome();
  const modelCallFailureKind =
    classifyCodexModelCallFailureKind({
      error: finalPromptError,
      timedOut: effectiveTimedOut,
      turnCompletionIdleTimedOut: effectiveTurnCompletionIdleTimedOut,
      runAborted: finalAborted,
      abortReason: terminalState.explicitCancellationReason ?? runAbortController.signal.reason,
      clientClosedAbort: state.clientClosedAbort,
      formatError: formatErrorMessage,
    }) ?? (finalAborted ? "aborted" : undefined);
  if (modelCallFailureKind) {
    codexModelCallDiagnostics.emitError(
      finalPromptError ?? "codex app-server attempt interrupted",
      {
        failureKind: modelCallFailureKind,
      },
    );
  } else if (finalPromptError) {
    codexModelCallDiagnostics.emitError(finalPromptError);
  } else {
    codexModelCallDiagnostics.emitCompleted(result);
  }
  const mirrorOutcome = await codexTranscriptMirrorRuntime.mirrorBestEffort({
    params,
    agentId: sessionAgentId,
    notifyUserMessagePersisted,
    result,
    sessionKey: contextSessionKey,
    cwd: effectiveCwd,
    threadId: resourceState.thread.threadId,
    turnId: activeTurnId,
  });
  const { assistantTranscriptOwned } = mirrorOutcome;
  const shouldCaptureSettledTurnFinalizationContext =
    turnSucceeded &&
    result.assistantTexts.every((text) => !text.trim()) &&
    result.messagesSnapshot.some((message) => message.role === "toolResult");
  const settledTurnFinalizationContext = shouldCaptureSettledTurnFinalizationContext
    ? await captureCodexSettledTurnFinalizationContext({
        ...activeTranscriptTarget,
        mirroredMessages: mirrorOutcome.mirroredMessages,
        settledMessages: result.messagesSnapshot,
        turnId: activeTurnId,
      })
    : undefined;
  if (shouldCaptureSettledTurnFinalizationContext && !settledTurnFinalizationContext) {
    // The isolated child must not infer around a partial or drifting transcript.
    // Omitting this field preserves the existing incomplete-turn failure.
    embeddedAgentLog.warn("codex settled-turn finalization context is unavailable", {
      threadId: resourceState.thread.threadId,
      turnId: activeTurnId,
    });
  }
  if (activeContextEngine) {
    const contextEnginePluginId = resolveContextEngineOwnerPluginId(activeContextEngine);
    const isHeartbeat =
      params.bootstrapContextRunKind === "heartbeat" ||
      params.bootstrapContextRunKind === "commitment-only";
    const finalMessages =
      (await readMirroredSessionHistoryMessages(activeTranscriptTarget)) ??
      historyState.messages.concat(result.messagesSnapshot);
    await finalizeHarnessContextEngineTurn({
      contextEngine: activeContextEngine,
      promptError: Boolean(finalPromptError),
      aborted: finalAborted,
      yieldAborted: Boolean(result.yieldDetected),
      sessionIdUsed: activeSessionId,
      sessionKey: contextSessionKey,
      sessionFile: activeSessionFile,
      sessionTarget: params.sessionTarget,
      messagesSnapshot: finalMessages,
      prePromptMessageCount: promptState.prePromptMessageCount,
      tokenBudget: effectiveContextTokenBudget,
      runtimeContext: buildHarnessContextEngineRuntimeContextFromUsage({
        attempt: buildActiveRunAttemptParams(),
        workspaceDir: effectiveWorkspace,
        cwd: effectiveCwd,
        agentDir,
        activeAgentId: sessionAgentId,
        contextEnginePluginId,
        tokenBudget: effectiveContextTokenBudget,
        lastCallUsage: result.attemptUsage,
        promptCache: result.promptCache,
      }),
      contextEngineHostSupport: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
      providerId: usesSupervisionConnection
        ? (resourceState.thread.modelProvider ?? effectiveRuntimeProviderId)
        : params.provider,
      requestedModelId: usesSupervisionConnection ? undefined : params.requestedModelId,
      modelId: usesSupervisionConnection
        ? (resourceState.thread.model ?? effectiveRuntimeModelId)
        : params.modelId,
      fallbackReason: usesSupervisionConnection ? undefined : params.fallbackReason,
      degradedReason: usesSupervisionConnection ? undefined : params.degradedReason,
      runMaintenance: runHarnessContextEngineMaintenance,
      config: params.config,
      warn: (message) => embeddedAgentLog.warn(message),
      isHeartbeat,
    });
  }
  runAgentHarnessLlmOutputHook({
    event: {
      runId: params.runId,
      sessionId: params.sessionId,
      provider: usesSupervisionConnection
        ? (resourceState.thread.modelProvider ?? effectiveRuntimeProviderId)
        : params.provider,
      model: usesSupervisionConnection
        ? (resourceState.thread.model ?? effectiveRuntimeModelId)
        : params.modelId,
      ...hookContextWindowFields,
      resolvedRef: usesSupervisionConnection
        ? `${resourceState.thread.modelProvider ?? effectiveRuntimeProviderId}/${resourceState.thread.model ?? effectiveRuntimeModelId}`
        : (params.runtimePlan?.observability.resolvedRef ?? `${params.provider}/${params.modelId}`),
      ...(!usesSupervisionConnection && params.runtimePlan?.observability.harnessId
        ? { harnessId: params.runtimePlan.observability.harnessId }
        : {}),
      assistantTexts: result.assistantTexts,
      ...(result.lastAssistant ? { lastAssistant: result.lastAssistant } : {}),
      ...(result.attemptUsage ? { usage: result.attemptUsage } : {}),
    },
    ctx: hookContext,
    hookRunner,
  });
  await runCodexAgentEndHook(params, {
    event: {
      messages: result.messagesSnapshot,
      success: !finalAborted && !finalPromptError,
      ...(finalPromptError ? { error: formatErrorMessage(finalPromptError) } : {}),
      durationMs: Date.now() - attemptStartedAt,
    },
    ctx: hookContext,
    hookRunner,
  });
  state.shouldDelayNativeHookRelayUnregister =
    completedTurnStatus === "completed" &&
    !effectiveTimedOut &&
    !runAbortController.signal.aborted &&
    !finalAborted &&
    !finalPromptError;
  if (state.shouldDelayNativeHookRelayUnregister) {
    try {
      await markCodexAppServerBindingCoveredThroughTurn({
        bindingStore,
        identity: bindingIdentity,
        threadId: resourceState.thread.threadId,
      });
    } catch (error) {
      if (resourceState.thread.connectionScope === "supervision") {
        throw error;
      }
      const cleared = await bindingStore.mutate(bindingIdentity, {
        kind: "clear",
        threadId: resourceState.thread.threadId,
      });
      if (!cleared) {
        throw error;
      }
      embeddedAgentLog.warn(
        "codex app-server binding coverage update failed after completed turn; cleared stale binding",
        { threadId: resourceState.thread.threadId, turnId: activeTurnId, error },
      );
    }
  }
  recordCodexTrajectoryCompletion(trajectoryRecorder, {
    attempt: params,
    result,
    threadId: resourceState.thread.threadId,
    turnId: activeTurnId,
    timedOut: effectiveTimedOut,
    yieldDetected: toolState.yieldDetected,
  });
  trajectoryRecorder?.recordEvent("session.ended", {
    status: finalPromptError
      ? "error"
      : finalAborted || effectiveTimedOut
        ? "interrupted"
        : "success",
    threadId: resourceState.thread.threadId,
    turnId: activeTurnId,
    timedOut: effectiveTimedOut,
    yieldDetected: toolState.yieldDetected,
    promptError: normalizeCodexTrajectoryError(finalPromptError),
  });
  markTrajectoryEndRecorded();
  const terminalAssistantText = collectTerminalAssistantText(result);
  if (
    terminalAssistantText &&
    (!streamState.eventEmitted || streamState.needsTerminalSnapshot) &&
    !finalAborted &&
    !finalPromptError
  ) {
    void emitCodexAppServerEvent(params, {
      stream: "assistant",
      data: { text: terminalAssistantText },
    });
  }
  emitLifecycleTerminal(
    finalPromptError
      ? {
          phase: "error",
          error: formatErrorMessage(finalPromptError),
          ...buildLifecycleTerminalMeta({ aborted: finalAborted, timedOut: effectiveTimedOut }),
        }
      : {
          phase: "end",
          ...buildLifecycleTerminalMeta({
            aborted: finalAborted,
            timedOut: effectiveTimedOut,
            yielded: toolState.yieldDetected,
          }),
        },
  );
  return {
    ...result,
    timedOut: effectiveTimedOut,
    aborted: finalAborted,
    promptError: finalPromptError,
    promptErrorSource: finalPromptErrorSource,
    ...(codexAppServerFailure ? { codexAppServerFailure } : {}),
    ...(promptTimeoutOutcome ? { promptTimeoutOutcome } : {}),
    ...(assistantTranscriptOwned ? { assistantTranscriptOwned: true } : {}),
    ...(settledTurnFinalizationContext ? { settledTurnFinalizationContext } : {}),
    ...(resourceState.runtimeArtifact ? { runtimeArtifact: resourceState.runtimeArtifact } : {}),
    ...(!finalAborted && !effectiveTimedOut && !finalPromptError && preparedAuthBinding
      ? { authBindingFingerprint: preparedAuthBinding.fingerprint }
      : {}),
    systemPromptReport,
  };
}
