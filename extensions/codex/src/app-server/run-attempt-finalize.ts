import { addAbortListener } from "node:events";
import {
  buildEmbeddedForegroundPromptContext,
  embeddedAgentLog,
  formatErrorMessage,
  runAgentHarnessLlmOutputHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { classifyCodexModelCallFailureKind } from "./attempt-diagnostics.js";
import {
  buildCodexAppServerPromptTimeoutOutcome,
  collectTerminalAssistantText,
  isInvalidCodexImagePayloadError,
  resolveCodexAppServerReplayBlockedReason,
} from "./attempt-results.js";
import { attemptTerminal, type EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { TURN_FINALIZE_DRAIN_ABORT_GRACE_MS } from "./attempt-timeouts.js";
import { buildCodexContinuityCalibration } from "./context-engine-projection.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
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
  clearCodexBindingAfterInvalidImagePayload,
  shouldUseFreshCodexThreadAfterContextEngineOverflow,
} from "./run-attempt-state.js";
import type { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { assertCodexBindingMayBeReplaced } from "./session-binding.js";
import { captureCodexSettledTurnFinalizationContext } from "./settled-turn-context.js";
import { normalizeCodexTrajectoryError, recordCodexTrajectoryCompletion } from "./trajectory.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";
import {
  CodexUsageLimitPromptError,
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
  const { runtime, attemptTools, activeTranscriptTarget, hookContext } = context;
  const { hookContextWindowFields, hookRunner } = context;
  const { connection, preparedAuthBinding } = runtime;
  const { effectiveRuntimeProviderId, effectiveRuntimeModelId } = runtime;
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
    agentDir,
    attemptStartedAt,
    startupAuthProfileId,
  } = connection;
  const { toolBridge, toolState } = attemptTools;
  const canClearBindingForRecovery = (operation: string) => {
    if (params.expectedSessionRuntimeOwnership) {
      // Optional recovery preserves both native ownership and the completed turn's outcome.
      embeddedAgentLog.warn(
        "codex app-server preserved native binding instead of recovery rotation",
        {
          threadId: resourceState.thread.threadId,
          operation,
        },
      );
      return false;
    }
    assertCodexBindingMayBeReplaced(resourceState.thread, operation);
    return true;
  };
  const { state, completion, deadlines } = turnRuntime;
  const { emitLifecycleTerminal, buildLifecycleTerminalMeta } = lifecycle;
  const { drainNotificationQueue } = notifications;
  const { codexModelCallDiagnostics } = requestRuntime;
  const {
    activeTurnId,
    activeProjector,
    runtimeModelSelection,
    streamState,
    freezeRunTerminalOutcome,
    notifyUserMessagePersisted,
  } = activeTurn;
  await completion;
  const abortGraceElapsed = createDeferred<void>();
  let settlementPhase: "active" | "expired" | "closed" = "active";
  let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
  const beginAbortGrace = () => {
    if (settlementPhase !== "active") {
      return;
    }
    abortGraceTimer = setTimeout(() => {
      settlementPhase = "expired";
      abortGraceElapsed.resolve();
    }, TURN_FINALIZE_DRAIN_ABORT_GRACE_MS);
    abortGraceTimer.unref?.();
  };
  const abortListener = addAbortListener(runAbortController.signal, () => {
    // Abort may first arrive after native completion. Its authoritative cleanup
    // must finish before projection gets the full five-second drain grace.
    void state.abortCleanup.then(beginAbortGrace, beginAbortGrace);
  });
  const closeProjection = () => {
    state.projectionClosed = true;
    return activeProjector.closeProjection();
  };
  const closeSettlement = () => {
    if (settlementPhase === "closed") {
      return;
    }
    settlementPhase = "closed";
    abortListener[Symbol.dispose]();
    clearTimeout(abortGraceTimer);
    deadlines.dispose();
  };
  const settlement = drainNotificationQueue().then(closeProjection);
  let projectionDrained = false;
  try {
    try {
      // Native completion does not end accepted projection or checkpoint work.
      // Both remain under the original receipt-anchored settlement deadline.
      projectionDrained = await Promise.race([
        settlement.then(() => true),
        abortGraceElapsed.promise.then(() => false),
      ]);
      if (runAbortController.signal.aborted) {
        await state.abortCleanup;
      }
    } finally {
      if (!state.projectionClosed) {
        await resources.runCleanupStep("codex-transcript-checkpoint", closeProjection);
      }
    }
    const result = activeProjector.buildResult(toolBridge.telemetry, {
      yieldDetected: toolState.yieldDetected,
    });
    const projectedTerminal = attemptTerminal.project(result.terminal);
    // Transport loss aborts in-flight work mechanically, but its terminal outcome
    // must remain a failure unless the operator explicitly canceled the attempt.
    const isFinalAborted = () =>
      terminalState.explicitCancellationObserved ||
      (!resourceState.executionDisconnectError &&
        (projectedTerminal.aborted ||
          (runAbortController.signal.aborted && !state.clientClosedAbort)));
    let enrichedPromptError =
      resourceState.executionDisconnectError ??
      state.clientClosedPromptError ??
      (state.timeout?.kind === "settlement"
        ? "codex app-server terminal settlement timed out"
        : state.timeout?.kind === "execution"
          ? "codex app-server execution budget timed out"
          : projectedTerminal.promptError);
    const enrichedPromptErrorMessage =
      typeof enrichedPromptError === "string"
        ? enrichedPromptError
        : enrichedPromptError instanceof Error
          ? enrichedPromptError.message
          : enrichedPromptError
            ? formatErrorMessage(enrichedPromptError)
            : undefined;
    if (isInvalidCodexImagePayloadError(enrichedPromptErrorMessage)) {
      await clearCodexBindingAfterInvalidImagePayload(
        bindingStore,
        bindingIdentity,
        {
          phase: "turn_completed",
          threadId: resourceState.thread.threadId,
          turnId: activeTurnId,
          error: enrichedPromptErrorMessage,
        },
        params.expectedSessionRuntimeOwnership,
      );
    }
    if (
      resourceState.thread.connectionScope !== "supervision" &&
      shouldUseFreshCodexThreadAfterContextEngineOverflow({
        error: enrichedPromptError,
        contextEngineActive: Boolean(activeContextEngine),
        thread: resourceState.thread,
      }) &&
      canClearBindingForRecovery("clearing a native context after overflow")
    ) {
      embeddedAgentLog.warn(
        "codex app-server context-engine turn overflowed after resume; clearing thread binding for recovery",
        {
          threadId: resourceState.thread.threadId,
          turnId: activeTurnId,
          error: enrichedPromptErrorMessage,
        },
      );
      await bindingStore.mutate(bindingIdentity, {
        kind: "clear",
        threadId: resourceState.thread.threadId,
      });
    }
    const refreshedUsageLimitPromptError = await refreshCodexUsageLimitPromptError({
      client: resourceState.client,
      message: enrichedPromptErrorMessage,
      timeoutMs: appServer.requestTimeoutMs,
      signal: runAbortController.signal,
    });
    if (refreshedUsageLimitPromptError) {
      await markCodexAuthProfileBlockedFromRateLimits({
        params,
        authProfileId: startupAuthProfileId,
        rateLimits: refreshedUsageLimitPromptError.rateLimitsForProfile,
      });
      enrichedPromptError = new CodexUsageLimitPromptError(refreshedUsageLimitPromptError.message);
    } else if (
      enrichedPromptError instanceof CodexUsageLimitPromptError &&
      state.rateLimitsRevisionBeforeLastTurnStart !== undefined &&
      readCodexRateLimitsRevision(resourceState.client) >
        state.rateLimitsRevisionBeforeLastTurnStart
    ) {
      await markCodexAuthProfileBlockedFromRateLimits({
        params,
        authProfileId: startupAuthProfileId,
        rateLimits: readRecentCodexRateLimits(resourceState.client),
      });
    }
    const projectTerminalOutcome = () => {
      const effectiveTimedOut = state.timeout !== undefined;
      const clientClosedPromptErrorForFinal = state.clientClosedPromptError;
      const finalPromptError =
        resourceState.executionDisconnectError ??
        clientClosedPromptErrorForFinal ??
        (state.timeout?.kind === "settlement"
          ? "codex app-server terminal settlement timed out"
          : state.timeout?.kind === "execution"
            ? "codex app-server execution budget timed out"
            : enrichedPromptError);
      const finalPromptErrorSource =
        effectiveTimedOut || clientClosedPromptErrorForFinal
          ? "prompt"
          : projectedTerminal.promptErrorSource;
      const codexAppServerFailureKind = clientClosedPromptErrorForFinal
        ? "client_closed_before_turn_completed"
        : state.timeout?.kind === "settlement"
          ? "turn_settlement_timeout"
          : undefined;
      const replayBlockedReason = codexAppServerFailureKind
        ? resolveCodexAppServerReplayBlockedReason(result)
        : undefined;
      const promptTimeoutOutcome = buildCodexAppServerPromptTimeoutOutcome(state.timeout);
      const failureDiagnostics =
        codexAppServerFailureKind === "client_closed_before_turn_completed" &&
        state.clientClosedDiagnostic
          ? { transportError: state.clientClosedDiagnostic }
          : state.timeout?.kind === "settlement"
            ? { timeoutMs: state.timeout.timeoutMs }
            : undefined;
      const codexAppServerFailure = codexAppServerFailureKind
        ? ({
            kind: codexAppServerFailureKind,
            transport: appServer.start.transport,
            threadId: resourceState.thread.threadId,
            turnId: activeTurnId,
            replaySafe:
              codexAppServerFailureKind === "client_closed_before_turn_completed" &&
              replayBlockedReason === undefined,
            ...(replayBlockedReason ? { replayBlockedReason } : {}),
            ...(failureDiagnostics ? { diagnostics: failureDiagnostics } : {}),
          } satisfies NonNullable<EmbeddedRunAttemptResult["codexAppServerFailure"]>)
        : undefined;
      const finalAborted = isFinalAborted();
      if (finalAborted && result.attemptUsage) {
        result.attemptUsage = { ...result.attemptUsage, contextUsage: { state: "unavailable" } };
      }
      const completedTurnStatus = activeProjector.getCompletedTurnStatus();
      const locallyCompletedTurn =
        state.completed &&
        state.localCompletionRequested &&
        !state.timeout &&
        clientClosedPromptErrorForFinal === undefined;
      const turnSucceeded =
        !finalAborted &&
        !effectiveTimedOut &&
        (finalPromptError === null || finalPromptError === undefined) &&
        (completedTurnStatus === "completed" || locallyCompletedTurn);
      const completedSourceReply = toolBridge.telemetry.messagingToolSentTargets.some(
        (target) => target.sourceReplyFinal === true,
      );
      if (completedSourceReply) {
        // Harness classification only sees assistant/reasoning/plan projections.
        // A reply delivered entirely through the source message tool is visible
        // output, so an empty/reasoning-only classification is stale at this point.
        result.agentHarnessResultClassification = undefined;
      }
      const attemptSucceeded =
        turnSucceeded && result.agentHarnessResultClassification === undefined;
      result.terminal = attemptTerminal.normalize({
        timedOut: effectiveTimedOut,
        aborted: finalAborted,
        promptError: finalPromptError,
        promptErrorSource: finalPromptErrorSource,
      });
      // Failure enrichment can change the outcome after projection. Update this turn's
      // terminal rows before transcript hooks read them; earlier work keeps its own outcome.
      for (const message of [
        result.lastAssistant,
        result.currentAttemptAssistant,
        result.messagesSnapshot.find(
          (candidate) => readMirrorIdentity(candidate) === `${activeTurnId}:assistant`,
        ),
      ]) {
        if (message?.role === "assistant") {
          const providerRefusal = message.diagnostics?.some(
            (diagnostic) => diagnostic.type === "provider_refusal",
          );
          // The projector owns refusal classification. Preserve it unless a stronger
          // local abort or prompt failure supersedes this turn's provider outcome.
          if (!providerRefusal || finalAborted || finalPromptError) {
            message.stopReason = finalAborted ? "aborted" : finalPromptError ? "error" : "stop";
            message.errorMessage = finalPromptError
              ? formatErrorMessage(finalPromptError)
              : undefined;
          }
        }
      }
      return {
        effectiveTimedOut,
        finalPromptError,
        codexAppServerFailure,
        promptTimeoutOutcome,
        finalAborted,
        turnSucceeded,
        attemptSucceeded,
        completedTurnStatus,
      };
    };
    // Message-write hooks see the enriched native outcome. The same projection
    // runs after the bounded mirror join if Stop or the deadline arrives there.
    const mirrorTerminal = projectTerminalOutcome();
    type MirrorOutcome = Awaited<ReturnType<typeof codexTranscriptMirrorRuntime.mirrorBestEffort>>;
    const unavailableMirror: MirrorOutcome = {
      assistantTranscriptOwned: false,
      mirroredMessages: [],
    };
    let mirrorOutcome = unavailableMirror;
    try {
      if (projectionDrained && settlementPhase === "active") {
        mirrorOutcome = await Promise.race([
          codexTranscriptMirrorRuntime.mirrorBestEffort({
            assertWriteCurrent: () => {
              if (settlementPhase !== "active") {
                throw new Error("Codex transcript settlement is no longer active");
              }
              const current = projectTerminalOutcome();
              if (
                current.finalAborted !== mirrorTerminal.finalAborted ||
                current.effectiveTimedOut !== mirrorTerminal.effectiveTimedOut ||
                current.finalPromptError !== mirrorTerminal.finalPromptError
              ) {
                throw new Error("Codex transcript terminal outcome changed before write");
              }
            },
            params,
            agentId: sessionAgentId,
            notifyUserMessagePersisted,
            result,
            sessionKey: contextSessionKey,
            cwd: effectiveCwd,
            threadId: resourceState.thread.threadId,
            turnId: activeTurnId,
          }),
          abortGraceElapsed.promise.then(() => unavailableMirror),
        ]);
      }
      if (runAbortController.signal.aborted) {
        await state.abortCleanup;
      }
    } finally {
      // Retire this exact write before releasing the run. A queued mirror cannot
      // borrow a later session writer after its settlement deadline has elapsed.
      closeSettlement();
    }
    const {
      effectiveTimedOut,
      finalPromptError,
      codexAppServerFailure,
      promptTimeoutOutcome,
      finalAborted,
      turnSucceeded,
      attemptSucceeded,
      completedTurnStatus,
    } = projectTerminalOutcome();
    terminalState.turnSucceeded = turnSucceeded;
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
    const { assistantTranscriptOwned, assistantTranscriptIdempotencyKey, terminalAnchor } =
      mirrorOutcome;
    const shouldCaptureSettledTurnFinalizationContext =
      result.assistantTexts.every((text) => !text.trim()) &&
      result.messagesSnapshot.some((message) => message.role === "toolResult") &&
      (!finalPromptError || activeProjector.settledTurnFailureFinalizationAllowed);
    // Supervised auth belongs to its native connection, which has no generic stock
    // tool-free summary operation. Retain fallback eligibility instead of selecting host auth.
    const settledTurnFinalizationContext = shouldCaptureSettledTurnFinalizationContext
      ? ((!usesSupervisionConnection
          ? await captureCodexSettledTurnFinalizationContext({
              ...activeTranscriptTarget,
              model: resourceState.thread.model,
              modelProvider: resourceState.thread.modelProvider,
              authProfileId: startupAuthProfileId,
              mirroredMessages: mirrorOutcome.mirroredMessages,
              settledMessages: result.messagesSnapshot,
              turnId: activeTurnId,
              signal: params.abortSignal,
              assertActive: connection.assertCurrent,
            })
          : undefined) ?? Object.freeze({ source: "unavailable" as const }))
      : undefined;
    if (settledTurnFinalizationContext?.source === "unavailable") {
      embeddedAgentLog.warn("codex settled-turn finalization context is unavailable", {
        runId: params.runId,
        threadId: resourceState.thread.threadId,
        turnId: activeTurnId,
        reason: usesSupervisionConnection
          ? "native_auth_finalization_unsupported"
          : "context_unavailable",
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
          : (params.runtimePlan?.observability.resolvedRef ??
            `${params.provider}/${params.modelId}`),
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
    // A non-retryable refusal is a visible terminal reply, not learning evidence
    // for another call to the same provider. User-aborted turns remain eligible.
    const providerRefusal = result.currentAttemptAssistant?.diagnostics?.some(
      (diagnostic) => diagnostic.type === "provider_refusal",
    );
    await runCodexAgentEndHook(params, {
      skillExperienceReviewSource: providerRefusal ? undefined : terminalAnchor,
      event: {
        messages: result.messagesSnapshot,
        success: !finalAborted && !finalPromptError,
        ...(finalPromptError ? { error: formatErrorMessage(finalPromptError) } : {}),
        durationMs: Date.now() - attemptStartedAt,
      },
      ctx: {
        ...hookContext,
        modelProviderId: resourceState.thread.modelProvider ?? effectiveRuntimeProviderId,
        modelId: resourceState.thread.model ?? effectiveRuntimeModelId,
        authProfileId: resourceState.thread.authProfileId ?? startupAuthProfileId,
        modelIterations: result.modelIterations ?? 0,
        skillWorkshopAvailable: flattenCodexDynamicToolFunctions(
          attemptTools.toolBridge.availableSpecs,
        ).some((tool) => tool.name === "skill_workshop"),
        compacted: (result.compactionCount ?? 0) > 0,
        senderId: params.senderId ?? undefined,
        foregroundPromptContext: buildEmbeddedForegroundPromptContext(
          { ...params, agentId: sessionAgentId },
          agentDir,
        ),
      },
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
        // Only no-engine continuity prompts may calibrate their measured history.
        // Billing spans every model call; density needs only the latest full prompt.
        const continuityCalibration = context.promptState.noEngineContinuityProjectionApplied
          ? buildCodexContinuityCalibration({
              promptChars: prompt.turnState.codexTurnPromptText.length,
              inputTokens:
                result.attemptUsage?.contextUsage?.state === "available"
                  ? (result.attemptUsage.contextUsage.promptTokens ?? 0)
                  : 0,
            })
          : undefined;
        await bindingStore.mutate(
          bindingIdentity,
          {
            kind: "patch",
            threadId: resourceState.thread.threadId,
            patch: {
              historyCoveredThrough: new Date().toISOString(),
              ...(continuityCalibration ? { continuityCalibration } : {}),
            },
          },
          connection.assertCurrent,
        );
      } catch (error) {
        if (resourceState.thread.connectionScope === "supervision") {
          throw error;
        }
        if (canClearBindingForRecovery("clearing native coverage after a completed turn")) {
          const cleared = await bindingStore.mutate(
            bindingIdentity,
            { kind: "clear", threadId: resourceState.thread.threadId },
            connection.assertCurrent,
          );
          if (!cleared) {
            throw error;
          }
          embeddedAgentLog.warn(
            "codex app-server binding coverage update failed after completed turn; cleared stale binding",
            { threadId: resourceState.thread.threadId, turnId: activeTurnId, error },
          );
        }
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
    // Preserve the exact result identity carrying host-issued TTS delivery provenance.
    const finalizedResult: EmbeddedRunAttemptResult = Object.assign(result, {
      ...(runtimeModelSelection ? { runtimeModelSelection } : {}),
      ...(toolState.yieldAcknowledgment
        ? { yieldAcknowledgment: toolState.yieldAcknowledgment }
        : {}),
      ...(codexAppServerFailure ? { codexAppServerFailure } : {}),
      ...(promptTimeoutOutcome ? { promptTimeoutOutcome } : {}),
      ...(assistantTranscriptOwned ? { assistantTranscriptOwned: true } : {}),
      ...(assistantTranscriptIdempotencyKey ? { assistantTranscriptIdempotencyKey } : {}),
      ...(terminalAnchor ? { contextEngineTerminalAnchor: terminalAnchor } : {}),
      ...(settledTurnFinalizationContext ? { settledTurnFinalizationContext } : {}),
      ...(resourceState.runtimeArtifact ? { runtimeArtifact: resourceState.runtimeArtifact } : {}),
      ...(resourceState.runtimeContinuationStarted ? { runtimeContinuationStarted: true } : {}),
      ...(!finalAborted && !effectiveTimedOut && !finalPromptError && preparedAuthBinding
        ? { authBindingFingerprint: preparedAuthBinding.fingerprint }
        : {}),
      systemPromptReport,
    });
    if (turnSucceeded && toolState.yieldDetected && !runAbortController.signal.aborted) {
      resourceState.nativeHookRelay?.authorizeRetentionAfterSuccessfulYield();
    }
    return finalizedResult;
  } finally {
    closeSettlement();
  }
}
