import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
  interruptCodexTurnBestEffort,
} from "./attempt-client-cleanup.js";
import { createCodexSteeringQueue } from "./attempt-steering.js";
import {
  resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs,
  resolveCodexTurnAssistantCompletionIdleTimeoutMs,
  resolveCodexTurnCompletionIdleTimeoutMs,
  resolveCodexTurnTerminalIdleTimeoutMs,
} from "./attempt-timeouts.js";
import {
  createCodexAttemptTurnWatchController,
  type CodexAttemptTurnWatchTimeoutKind,
} from "./attempt-turn-watches.js";
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
  const { context } = prompt;
  const { connection } = context.runtime;
  const { params, options, appServer, runAbortController } = connection;
  const state = {
    latestStartupErrorNotification: undefined as CodexServerNotification | undefined,
    rateLimitsRevisionBeforeLastTurnStart: undefined as number | undefined,
    completed: false,
    terminalTurnNotificationQueued: false,
    // App-server collapses user interrupts and replacements to "interrupted";
    // this marker remains the user-interrupt hint until Codex exposes abortReason.
    sawCodexInterruptMarker: false,
    timedOut: false,
    turnCompletionIdleTimedOut: false,
    turnWatchTimeoutKind: undefined as CodexAttemptTurnWatchTimeoutKind | undefined,
    turnWatchTimeoutIdleMs: undefined as number | undefined,
    turnWatchTimeoutMs: undefined as number | undefined,
    turnWatchTimeoutLastActivityReason: undefined as string | undefined,
    turnWatchTimeoutDetails: undefined as Record<string, unknown> | undefined,
    turnCompletionIdleTimeoutMessage: undefined as string | undefined,
    clientClosedPromptError: undefined as string | undefined,
    clientClosedAbort: false,
    shouldDelayNativeHookRelayUnregister: false,
    lifecycleStarted: false,
    lifecycleTerminalEmitted: false,
    resolveCompletion: undefined as (() => void) | undefined,
    nativeHookRelayLastRenewedAt: 0,
    activeAppServerTurnRequests: 0,
    unsettledFinalizationHookCount: 0,
    rejectedFinalizationHookAssistant: undefined as { itemId?: string } | undefined,
    turnCrossedToolHandoff: false,
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
  const completion = new Promise<void>((resolve) => {
    state.resolveCompletion = resolve;
  });
  const turnCompletionIdleTimeoutMs = resolveCodexTurnCompletionIdleTimeoutMs(
    options.turnCompletionIdleTimeoutMs ?? appServer.turnCompletionIdleTimeoutMs,
  );
  const turnAssistantCompletionIdleTimeoutMs = resolveCodexTurnAssistantCompletionIdleTimeoutMs(
    options.turnAssistantCompletionIdleTimeoutMs,
  );
  const postToolRawAssistantCompletionIdleTimeoutMs =
    resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(
      options.postToolRawAssistantCompletionIdleTimeoutMs ??
        appServer.postToolRawAssistantCompletionIdleTimeoutMs,
      turnAssistantCompletionIdleTimeoutMs,
    );
  const turnTerminalIdleTimeoutMs = resolveCodexTurnTerminalIdleTimeoutMs(
    options.turnTerminalIdleTimeoutMs,
    params.runTimeoutOverrideMs,
  );
  const turnAttemptIdleTimeoutMs = Math.max(100, Math.floor(params.timeoutMs));
  const pendingOpenClawDynamicToolCompletionIds = new Set<string>();
  // One execution promise per call id prevents duplicate delivery from
  // repeating non-idempotent computer input while the attempt remains active.
  const openClawDynamicToolExecutions = createCodexDynamicToolExecutionRegistry();
  const activeTurnItemIds = new Set<string>();
  const activeCompletionBlockerItemIds = new Set<string>();
  const activeFinalizationHookRunIds = new Set<string>();
  const finalizationHookBatchStatuses = new Map<string, string | undefined>();
  const turnIdRef: { current?: string } = {};
  const userInputBridgeRef: { current?: ReturnType<typeof createCodexUserInputBridge> } = {};
  const steeringQueueRef: { current?: ReturnType<typeof createCodexSteeringQueue> } = {};
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
        attemptTimeoutMs: turnAttemptIdleTimeoutMs,
        startupTimeoutMs,
        turnStartTimeoutMs: params.timeoutMs,
      }),
    );
  };
  const turnWatches = createCodexAttemptTurnWatchController({
    threadId: resourceState.thread.threadId,
    signal: runAbortController.signal,
    getTurnId: () => turnIdRef.current,
    isCompleted: () => state.completed,
    isTerminalTurnNotificationQueued: () => state.terminalTurnNotificationQueued,
    getActiveAppServerTurnRequests: () => state.activeAppServerTurnRequests,
    getActiveTurnItemCount: () => activeTurnItemIds.size,
    getActiveCompletionBlockerItemCount: () => activeCompletionBlockerItemIds.size,
    getActiveFinalizationHookCount: () => state.unsettledFinalizationHookCount,
    canReleaseAssistantCompletionIdle: () =>
      projectorRef.current?.hasLatestTerminalAssistantCandidateText() === true,
    turnCompletionIdleTimeoutMs,
    turnAssistantCompletionIdleTimeoutMs,
    turnAttemptIdleTimeoutMs,
    turnTerminalIdleTimeoutMs,
    interruptTimeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
    onInterruptTurn: (input) => interruptCodexTurnBestEffort(resourceState.client, input),
    onTimeout: (timeout) => {
      state.timedOut = true;
      state.turnCompletionIdleTimedOut = true;
      state.turnWatchTimeoutKind = timeout.kind;
      state.turnWatchTimeoutIdleMs = timeout.idleMs;
      state.turnWatchTimeoutMs = timeout.timeoutMs;
      state.turnWatchTimeoutLastActivityReason = timeout.lastActivityReason;
      state.turnWatchTimeoutDetails = timeout.details;
      state.turnCompletionIdleTimeoutMessage =
        "codex app-server turn idle timed out waiting for turn/completed";
    },
    onMarkTimedOut: () => projectorRef.current?.markTimedOut(),
    onAbort: (reason) => runAbortController.abort(reason),
    onCompleted: () => {
      state.completed = true;
    },
    onResolveCompletion: () => state.resolveCompletion?.(),
    onRecordEvent: (name, fields) => trajectoryRecorder?.recordEvent(name, fields),
    onAttemptProgress: (reason) => {
      renewNativeHookRelayForTurnProgress();
      params.onRunProgress?.({
        reason,
        provider: params.provider,
        model: params.modelId,
        backend: "codex-app-server",
      });
    },
    onProgressDiagnostic: (reason) => {
      emitTrustedDiagnosticEvent({
        type: "run.progress",
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        reason: `codex_app_server:${reason}`,
      });
    },
  });
  return {
    state,
    completion,
    turnCompletionIdleTimeoutMs,
    turnAssistantCompletionIdleTimeoutMs,
    postToolRawAssistantCompletionIdleTimeoutMs,
    turnTerminalIdleTimeoutMs,
    turnAttemptIdleTimeoutMs,
    pendingOpenClawDynamicToolCompletionIds,
    openClawDynamicToolExecutions,
    activeTurnItemIds,
    activeCompletionBlockerItemIds,
    activeFinalizationHookRunIds,
    finalizationHookBatchStatuses,
    turnIdRef,
    userInputBridgeRef,
    steeringQueueRef,
    renewNativeHookRelayForTurnProgress,
    turnWatches,
  };
}

export type CodexAttemptTurnState = ReturnType<typeof createCodexAttemptTurnState>;
