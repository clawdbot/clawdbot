import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  closeCodexStartupClientBestEffort,
  interruptCodexTurnAndWaitBestEffort,
} from "./attempt-client-cleanup.js";
import {
  createCodexAttemptDeadlineController,
  type CodexAttemptTimeout,
} from "./attempt-deadlines.js";
import { createCodexSteeringQueue } from "./attempt-steering.js";
import type { AttemptSettlementWarning } from "./attempt-terminal.js";
import {
  resolveCodexNativeHookRelayTtlMs,
  CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS,
} from "./native-hook-relay.js";
import type {
  CodexServerNotification,
  CodexDynamicToolCallParams,
  CodexDynamicToolCallResponse,
} from "./protocol.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import { createCodexDynamicToolExecutionRegistry } from "./run-attempt-tools.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";

const CODEX_NATIVE_HOOK_RELAY_RENEW_INTERVAL_MS = 60_000;

export function createCodexAttemptTurnState(resources: CodexAttemptResources) {
  const {
    prompt,
    state: resourceState,
    projectorRef,
    trajectoryRecorder,
    startupTimeoutMs,
  } = resources;
  const { connection } = prompt.context.runtime;
  const { params, options, runAbortController } = connection;
  const state = {
    latestStartupErrorNotification: undefined as CodexServerNotification | undefined,
    rateLimitsRevisionBeforeLastTurnStart: undefined as number | undefined,
    completed: false,
    abortCleanup: Promise.resolve(),
    // SAFETY: Unset is valid; only completed native cleanup can advance this closed state to confirmed.
    permissionChangeRestart: undefined as "requested" | "confirmed" | undefined,
    localCompletionRequested: false,
    terminalTurnNotificationQueued: false,
    // App-server collapses user interrupts and replacements to "interrupted";
    // this marker remains the user-interrupt hint until Codex exposes abortReason.
    sawCodexInterruptMarker: false,
    timeout: undefined as CodexAttemptTimeout | undefined,
    // SAFETY: Only the correlated completed-answer deadline fills this initially empty slot.
    settlementWarning: undefined as AttemptSettlementWarning | undefined,
    // SAFETY: Finalization fills this initially empty slot while its transcript mirror is pending.
    pendingSettlementStage: undefined as string | undefined,
    clientClosedPromptError: undefined as string | undefined,
    clientClosedDiagnostic: undefined as string | undefined,
    clientClosedAbort: false,
    shouldDelayNativeHookRelayUnregister: false,
    lifecycleStarted: false,
    lifecycleTerminalEmitted: false,
    nativeHookRelayLastRenewedAt: 0,
    activeAppServerTurnRequests: 0,
    activeLocalProjections: 0,
    projectionClosed: false,
    pendingTerminalDynamicToolRelease: undefined as
      | {
          call: CodexDynamicToolCallParams;
          response: CodexDynamicToolCallResponse;
          durationMs: number;
        }
      | undefined,
    terminalDynamicToolReleaseCheckScheduled: false,
    currentTurnHadNonTerminalDynamicToolResult: false,
  };
  const { promise: completion, resolve: resolveCompletion } = createDeferred<void>();
  const settlementExpired = createDeferred<void>();
  const pendingOpenClawDynamicToolCompletionIds = new Set<string>();
  // One execution promise per call id prevents duplicate delivery from
  // repeating non-idempotent computer input while the attempt remains active.
  const openClawDynamicToolExecutions = createCodexDynamicToolExecutionRegistry();
  const activeTurnItemIds = new Set<string>();
  const turnIdRef: { current?: string } = {};
  const userInputBridgeRef: { current?: ReturnType<typeof createCodexUserInputBridge> } = {};
  const steeringQueueRef: { current?: ReturnType<typeof createCodexSteeringQueue> } = {};
  const completeTurn = () => {
    if (state.completed) {
      return;
    }
    state.completed = true;
    steeringQueueRef.current?.cancel();
    deadlines.beginSettlement(Date.now());
    resolveCompletion();
  };
  const interruptTurn = async (
    turnId: string,
    completionOptions?: { locallyCompleted?: boolean; timeoutMs?: number },
  ) => {
    if (completionOptions?.locallyCompleted) {
      state.localCompletionRequested = true;
    }
    const completed = await interruptCodexTurnAndWaitBestEffort(resourceState.client, {
      threadId: resourceState.thread.threadId,
      turnId,
      timeoutMs: completionOptions?.timeoutMs,
    });
    if (!completed) {
      await closeCodexStartupClientBestEffort(resourceState.client);
    }
    return completed;
  };
  const renewNativeHookRelayForTurnProgress = () => {
    if (!resourceState.nativeHookRelay || options.nativeHookRelay?.ttlMs !== undefined) {
      return;
    }
    const now = Date.now();
    const renewsRecently =
      now - state.nativeHookRelayLastRenewedAt < CODEX_NATIVE_HOOK_RELAY_RENEW_INTERVAL_MS;
    const expiresSoon =
      now >= resourceState.nativeHookRelay.expiresAtMs - CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
    if (renewsRecently && !expiresSoon) {
      return;
    }
    state.nativeHookRelayLastRenewedAt = now;
    resourceState.nativeHookRelay.renew(
      resolveCodexNativeHookRelayTtlMs({
        explicitTtlMs: undefined,
        attemptTimeoutMs: params.timeoutMs,
        startupTimeoutMs,
        turnStartTimeoutMs: params.timeoutMs,
      }),
    );
  };
  const noteProgress = (reason: string) => {
    if (state.completed || state.projectionClosed || runAbortController.signal.aborted) {
      return;
    }
    renewNativeHookRelayForTurnProgress();
    params.onRunProgress?.({
      reason,
      provider: params.provider,
      model: params.modelId,
      backend: "codex-app-server",
    });
    emitTrustedDiagnosticEvent({
      type: "run.progress",
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      reason: `codex_app_server:${reason}`,
    });
  };
  const deadlines = createCodexAttemptDeadlineController({
    startedAtMs: connection.attemptStartedAt,
    timeoutMs: params.timeoutMs,
    signal: runAbortController.signal,
    onDeadlineChanged: params.onAttemptDeadlineChanged,
    onTimeout: (timeout) => {
      const pendingStage =
        state.pendingSettlementStage ??
        projectorRef.current?.settlement.pendingStage ??
        "notification_queue";
      if (timeout.kind === "settlement" && projectorRef.current?.recoverCompletedAnswer()) {
        state.settlementWarning = {
          pendingStage,
          elapsedMs: timeout.elapsedMs,
          timeoutMs: timeout.timeoutMs,
        };
        state.projectionClosed = true;
        trajectoryRecorder?.recordEvent("turn.settlement_warning", {
          threadId: resourceState.thread.threadId,
          turnId: turnIdRef.current,
          ...state.settlementWarning,
        });
        embeddedAgentLog.warn(
          "codex app-server retaining completed answer after settlement expiry",
          state.settlementWarning,
        );
        completeTurn();
        settlementExpired.resolve();
        return;
      }
      state.timeout = timeout;
      projectorRef.current?.markTimedOut();
      const error = new Error(
        timeout.kind === "execution"
          ? "codex app-server execution budget timed out"
          : "codex app-server terminal settlement timed out",
      );
      const fields = {
        threadId: resourceState.thread.threadId,
        turnId: turnIdRef.current,
        ...timeout,
        pendingStage,
      };
      trajectoryRecorder?.recordEvent(`turn.${timeout.kind}_timeout`, fields);
      embeddedAgentLog.warn(error.message, fields);
      params.onAttemptTimeout?.(error);
      runAbortController.abort(error);
    },
  });
  return {
    state,
    completion,
    settlementExpired: settlementExpired.promise,
    pendingOpenClawDynamicToolCompletionIds,
    openClawDynamicToolExecutions,
    activeTurnItemIds,
    turnIdRef,
    userInputBridgeRef,
    steeringQueueRef,
    completeTurn,
    interruptTurn,
    renewNativeHookRelayForTurnProgress,
    noteProgress,
    deadlines,
  };
}

export type CodexAttemptTurnState = ReturnType<typeof createCodexAttemptTurnState>;
