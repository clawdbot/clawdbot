import {
  embeddedAgentLog,
  formatErrorMessage,
  runAgentCleanupStep,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
  type EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { classifyCodexModelCallFailureKind } from "./attempt-diagnostics.js";
import {
  buildCodexTurnStartFailureResult,
  isInvalidCodexImagePayloadError,
} from "./attempt-results.js";
import { isCodexContextRestartSelectionChangedError } from "./attempt-startup.js";
import type { CodexTurnStartResponse } from "./protocol.js";
import { emitCodexAppServerEvent, runCodexAgentEndHook } from "./run-attempt-lifecycle.js";
import type { CodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import {
  isCodexActiveCompactTurnError,
  clearCodexBindingAfterInvalidImagePayload,
  shouldUseFreshCodexThreadAfterContextEngineOverflow,
} from "./run-attempt-state.js";
import type { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { buildCodexUserPromptMessage } from "./transcript-mirror.js";
import {
  formatCodexTurnStartUsageLimitError,
  markCodexAuthProfileBlockedFromRateLimits,
} from "./usage-limit-error.js";

export async function startCodexAttemptTurn(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  notifications: CodexAttemptNotificationController,
  requestRuntime: Awaited<ReturnType<typeof prepareCodexAttemptTurnRequest>>,
): Promise<{ result: EmbeddedRunAttemptResult } | { turn: CodexTurnStartResponse }> {
  const {
    prompt,
    state: resourceState,
    trajectoryRecorder,
    markTrajectoryEndRecorded,
    activateNativePreToolUseFailureFallback,
    releaseCurrentRoute,
    releaseSandboxExecEnvironment,
    releaseSharedClientLeaseAndRetireOneShotClient,
  } = resources;
  const { context, turnState, systemPromptReport } = prompt;
  const { runtime, historyState, hookContext, hookContextWindowFields, hookRunner } = context;
  const { connection, runtimeParams, effectiveRuntimeProviderId, effectiveRuntimeModelId } =
    runtime;
  const {
    params,
    usesSupervisionConnection,
    runAbortController,
    activeContextEngine,
    bindingStore,
    bindingIdentity,
    appServer,
    attemptStartedAt,
    startupAuthProfileId,
    abortFromUpstream,
  } = connection;
  const { state, turnIdRef } = turnRuntime;
  const { waitForActiveNativeTurnCompletion } = notifications;
  const { codexModelCallDiagnostics, startCodexTurn, buildLlmInputEvent } = requestRuntime;
  let turn: CodexTurnStartResponse | undefined;
  try {
    codexModelCallDiagnostics.emitStarted();
    runAgentHarnessLlmInputHook({ event: buildLlmInputEvent(), ctx: hookContext, hookRunner });
    turn = await startCodexTurn();
  } catch (error) {
    let turnStartError = error;
    if (isCodexActiveCompactTurnError(turnStartError)) {
      embeddedAgentLog.info(
        "codex app-server turn/start blocked by active compact turn; waiting to retry",
        { threadId: resourceState.thread.threadId },
      );
      const compactTurnCompleted = await waitForActiveNativeTurnCompletion();
      if (compactTurnCompleted && !runAbortController.signal.aborted) {
        void emitCodexAppServerEvent(params, {
          stream: "codex_app_server.lifecycle",
          data: {
            phase: "turn_start_retry_after_compact",
            threadId: resourceState.thread.threadId,
          },
        });
        try {
          turn = await startCodexTurn();
        } catch (retryError) {
          turnStartError = retryError;
        }
      }
    }
    if (
      turn === undefined &&
      resourceState.thread.connectionScope !== "supervision" &&
      shouldUseFreshCodexThreadAfterContextEngineOverflow({
        error: turnStartError,
        contextEngineActive: Boolean(activeContextEngine),
        thread: resourceState.thread,
      }) &&
      resourceState.restartContextEngineCodexThread
    ) {
      embeddedAgentLog.warn(
        "codex app-server context-engine turn overflowed on resume; retrying with fresh thread",
        { threadId: resourceState.thread.threadId, error: formatErrorMessage(turnStartError) },
      );
      try {
        const clearedBinding = await bindingStore.mutate(bindingIdentity, {
          kind: "clear",
          threadId: resourceState.thread.threadId,
        });
        if (!clearedBinding) {
          embeddedAgentLog.warn(
            "codex app-server preserved newer context-engine binding after resume overflow; skipping fresh retry",
            { threadId: resourceState.thread.threadId, error: formatErrorMessage(turnStartError) },
          );
        } else {
          resourceState.thread = await resourceState.restartContextEngineCodexThread();
          const retryBinding = await bindingStore.read(bindingIdentity);
          if (
            retryBinding &&
            retryBinding.threadId === resourceState.thread.threadId &&
            retryBinding.contextEngine?.projection
          ) {
            await bindingStore.mutate(bindingIdentity, {
              kind: "patch",
              threadId: retryBinding.threadId,
              patch: {
                contextEngine: { ...retryBinding.contextEngine, projection: undefined },
              },
            });
            embeddedAgentLog.info(
              "codex app-server cleared stale context-engine projection after overflow retry",
              {
                threadId: resourceState.thread.threadId,
                previousEpoch: retryBinding.contextEngine.projection.epoch,
              },
            );
          }
          void emitCodexAppServerEvent(params, {
            stream: "codex_app_server.lifecycle",
            data: { phase: "thread_ready_retry", threadId: resourceState.thread.threadId },
          });
          try {
            turn = await startCodexTurn();
          } catch (retryError) {
            turnStartError = retryError;
          }
        }
      } catch (retrySetupError) {
        turnStartError = retrySetupError;
      }
    }
    if (turn === undefined) {
      const usageLimitError = await formatCodexTurnStartUsageLimitError({
        client: resourceState.client,
        error: turnStartError,
        errorNotification: state.latestStartupErrorNotification,
        rateLimitsRevisionBeforeTurnStart: state.rateLimitsRevisionBeforeLastTurnStart,
        timeoutMs: appServer.requestTimeoutMs,
        signal: runAbortController.signal,
      });
      const message = usageLimitError?.message ?? formatErrorMessage(turnStartError);
      if (isInvalidCodexImagePayloadError(message)) {
        await clearCodexBindingAfterInvalidImagePayload(bindingStore, bindingIdentity, {
          phase: "turn_start",
          threadId: resourceState.thread.threadId,
          error: message,
        });
      }
      void emitCodexAppServerEvent(params, {
        stream: "codex_app_server.lifecycle",
        data: { phase: "turn_start_failed", error: message },
      });
      trajectoryRecorder?.recordEvent("session.ended", {
        status: "error",
        threadId: resourceState.thread.threadId,
        timedOut: state.timedOut,
        aborted: runAbortController.signal.aborted,
        promptError: message,
      });
      markTrajectoryEndRecorded();
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
          assistantTexts: [],
        },
        ctx: hookContext,
        hookRunner,
      });
      const failureKind = classifyCodexModelCallFailureKind({
        error: turnStartError,
        timedOut: state.timedOut,
        turnCompletionIdleTimedOut: state.turnCompletionIdleTimedOut,
        runAborted: runAbortController.signal.aborted,
        abortReason: runAbortController.signal.reason,
        clientClosedAbort: state.clientClosedAbort,
        formatError: formatErrorMessage,
      });
      codexModelCallDiagnostics.emitError(message, failureKind ? { failureKind } : {});
      const messagesSnapshot = [
        ...historyState.messages,
        buildCodexUserPromptMessage({ ...runtimeParams, prompt: turnState.codexTurnPromptText }),
      ];
      await runCodexAgentEndHook(params, {
        event: {
          messages: messagesSnapshot,
          success: false,
          error: message,
          durationMs: Date.now() - attemptStartedAt,
        },
        ctx: hookContext,
        hookRunner,
      });
      if (!state.timedOut) {
        await unsubscribeCodexThreadBestEffort(resourceState.client, {
          threadId: resourceState.thread.threadId,
          timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        });
      }
      releaseCurrentRoute();
      activateNativePreToolUseFailureFallback();
      resourceState.nativeHookRelay?.unregister();
      await releaseSandboxExecEnvironment();
      await runAgentCleanupStep({
        runId: params.runId,
        sessionId: params.sessionId,
        step: "codex-trajectory-flush-startup-failure",
        log: embeddedAgentLog,
        cleanup: async () => trajectoryRecorder?.flush(),
      });
      params.abortSignal?.removeEventListener("abort", abortFromUpstream);
      await releaseSharedClientLeaseAndRetireOneShotClient();
      if (usageLimitError) {
        await markCodexAuthProfileBlockedFromRateLimits({
          params,
          authProfileId: startupAuthProfileId,
          rateLimits: usageLimitError.rateLimitsForProfile,
        });
        return {
          result: buildCodexTurnStartFailureResult({
            params,
            message: usageLimitError.message,
            messagesSnapshot,
            systemPromptReport,
          }),
        };
      }
      if (isCodexContextRestartSelectionChangedError(turnStartError)) {
        return {
          result: {
            ...buildCodexTurnStartFailureResult({
              params,
              message,
              messagesSnapshot,
              systemPromptReport,
            }),
            codexAppServerFailure: {
              kind: "client_closed_before_turn_completed" as const,
              transport: appServer.start.transport,
              threadId: resourceState.thread.threadId,
              replaySafe: true,
            },
          },
        };
      }
      throw turnStartError;
    }
  }
  if (!turn) {
    activateNativePreToolUseFailureFallback();
    await releaseSharedClientLeaseAndRetireOneShotClient();
    throw new Error("codex app-server turn/start failed without an error");
  }
  turnIdRef.current = turn.turn.id;
  return { turn };
}
