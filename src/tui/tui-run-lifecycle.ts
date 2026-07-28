// Coordinates active TUI runs, watchdogs, terminal errors, and history refresh.
import { classifyFailoverReason, isAuthErrorMessage } from "../agents/embedded-agent-helpers.js";
import { formatRawAssistantErrorForUi } from "../shared/assistant-error-format.js";
import { asString } from "./tui-formatters.js";
import type { TuiSessionRunCoordinator } from "./tui-session-run-coordinator.js";
import {
  clearPendingSubmit,
  clearPendingSubmitDraft,
  getPendingSubmitAcceptedRunId,
  hasPendingSubmit,
} from "./tui-submit-state.js";
import type { AgentEvent, TuiStateAccess } from "./tui-types.js";

const DEFAULT_STREAMING_WATCHDOG_MS = 30_000;
const LIFECYCLE_ERROR_RETRY_GRACE_MS = 15_000;
const STREAMING_WATCHDOG_USER_MESSAGE =
  "This response is taking longer than expected. Still waiting for the current run.";

type TuiRunLifecycleContext = {
  state: TuiStateAccess;
  runCoordinator: TuiSessionRunCoordinator;
  chatLog: {
    addSystem: (text: string) => void;
    addPendingSystem: (runId: string, text: string) => void;
    dismissPendingSystem: (runId: string) => void;
  };
  btw: { clear: () => void };
  tui: { requestRender: (force?: boolean) => void };
  setActivityStatus: (status: string) => void;
  refreshSessionInfo?: () => Promise<void>;
  isLocalRunId?: (runId: string) => boolean;
  forgetLocalRunId?: (runId: string) => void;
  clearLocalRunIds?: () => void;
  clearLocalBtwRunIds?: () => void;
  streamingWatchdogMs?: number;
  localMode?: boolean;
};

/** Gives session resets, concurrent runs, and reconnects one lifecycle owner. */
export function createTuiRunLifecycle(context: TuiRunLifecycleContext) {
  const {
    state,
    runCoordinator,
    chatLog,
    btw,
    tui,
    setActivityStatus,
    refreshSessionInfo,
    isLocalRunId,
    forgetLocalRunId,
    clearLocalRunIds,
    clearLocalBtwRunIds,
    localMode,
  } = context;
  const { sessionRuns, liveTerminalErrorMessages } = runCoordinator;
  const pendingTerminalLifecycleErrors = new Map<
    string,
    { errorMessage: string; timer: ReturnType<typeof setTimeout> }
  >();
  const streamingWatchdogMs =
    typeof context.streamingWatchdogMs === "number" &&
    Number.isFinite(context.streamingWatchdogMs) &&
    context.streamingWatchdogMs >= 0
      ? Math.floor(context.streamingWatchdogMs)
      : DEFAULT_STREAMING_WATCHDOG_MS;

  let lastSessionKey = state.currentSessionKey;
  let reconnectPendingRunId: string | null = null;
  let streamingWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let streamingWatchdogRunId: string | null = null;

  const flushPendingHistoryRefreshIfIdle = () => {
    if (
      state.activeChatRunId ||
      hasPendingSubmit(state) ||
      runCoordinator.isSessionMessagePersistencePending
    ) {
      return;
    }
    if (!runCoordinator.pendingHistoryRefresh && !runCoordinator.hasPendingSessionMessageRefresh) {
      return;
    }
    runCoordinator.pendingHistoryRefresh = false;
    runCoordinator.consumeSessionMessageRefresh();
    runCoordinator.queueHistoryReload();
  };

  const clearStreamingWatchdog = () => {
    if (streamingWatchdogTimer) {
      clearTimeout(streamingWatchdogTimer);
      streamingWatchdogTimer = null;
    }
    streamingWatchdogRunId = null;
  };

  const clearPendingTerminalLifecycleError = (runId: string) => {
    const pending = pendingTerminalLifecycleErrors.get(runId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    pendingTerminalLifecycleErrors.delete(runId);
  };

  const clearPendingTerminalLifecycleErrors = () => {
    for (const pending of pendingTerminalLifecycleErrors.values()) {
      clearTimeout(pending.timer);
    }
    pendingTerminalLifecycleErrors.clear();
  };

  const clearTrackedRunState = () => {
    runCoordinator.clear();
    clearPendingSubmit(state);
    reconnectPendingRunId = null;
    clearLocalRunIds?.();
    clearLocalBtwRunIds?.();
    clearPendingTerminalLifecycleErrors();
    btw.clear();
    clearStreamingWatchdog();
  };

  const armStreamingWatchdog = (runId: string) => {
    if (streamingWatchdogMs <= 0) {
      return;
    }
    if (streamingWatchdogTimer) {
      clearTimeout(streamingWatchdogTimer);
    }
    streamingWatchdogRunId = runId;
    streamingWatchdogTimer = setTimeout(() => {
      streamingWatchdogTimer = null;
      if (streamingWatchdogRunId !== runId || state.activeChatRunId !== runId) {
        return;
      }
      streamingWatchdogRunId = null;
      if (reconnectPendingRunId === runId) {
        reconnectPendingRunId = null;
        state.activeChatRunId = null;
        state.activityStatus = "idle";
        setActivityStatus("idle");
        runCoordinator.pendingHistoryRefresh = false;
        runCoordinator.queueHistoryReload();
        tui.requestRender();
        return;
      }
      chatLog.addPendingSystem(runId, STREAMING_WATCHDOG_USER_MESSAGE);
      tui.requestRender();
    }, streamingWatchdogMs);
    streamingWatchdogTimer.unref?.();
  };

  const syncSessionKey = () => {
    if (state.currentSessionKey === lastSessionKey) {
      return;
    }
    lastSessionKey = state.currentSessionKey;
    if (!state.activeChatRunId && !hasPendingSubmit(state)) {
      clearTrackedRunState();
    }
  };

  const resolveAuthErrorHint = (errorMessage: string): string | undefined => {
    if (!localMode) {
      return undefined;
    }
    const provider = state.sessionInfo.modelProvider?.trim();
    const failoverReason = classifyFailoverReason(errorMessage, { provider });
    if (failoverReason === "billing" || failoverReason === "rate_limit") {
      return undefined;
    }
    if (!isAuthErrorMessage(errorMessage)) {
      return undefined;
    }
    return provider
      ? `auth or provider access failed for ${provider}. Run /auth ${provider} to refresh credentials; if you already re-authed, switch models/providers because this account may still be blocked for inference.`
      : "auth or provider access failed for the current provider. Run /auth to refresh credentials; if you already re-authed, switch models/providers because this account may still be blocked for inference.";
  };

  const applyFallbackStepModelUpdate = (event: AgentEvent): boolean => {
    const data = event.data ?? {};
    if (event.stream !== "lifecycle" || asString(data.phase, "") !== "fallback_step") {
      return false;
    }
    if (typeof data.fallbackStepToModel !== "string") {
      return false;
    }
    const modelRef = data.fallbackStepToModel.trim();
    const separator = modelRef.indexOf("/");
    if (separator <= 0 || separator >= modelRef.length - 1) {
      return false;
    }
    const provider = modelRef.slice(0, separator).trim();
    const model = modelRef.slice(separator + 1).trim();
    if (!provider || !model) {
      return false;
    }
    state.sessionInfo.modelProvider = provider;
    state.sessionInfo.model = model;
    return true;
  };

  const markSubmittedRunRegistered = (runId: string) => {
    runCoordinator.bindRegisteredPendingRun(runId);
    clearPendingSubmitDraft(state, runId);
  };

  const acknowledgeChatRun = (runId: string, options?: { protectStream?: boolean }) => {
    if (reconnectPendingRunId === runId) {
      reconnectPendingRunId = null;
    }
    clearPendingTerminalLifecycleError(runId);
    chatLog.dismissPendingSystem(runId);
    runCoordinator.noteSessionRun(runId, options);
    markSubmittedRunRegistered(runId);
  };

  const clearActiveRunIfMatch = (runId: string) => {
    if (state.activeChatRunId === runId) {
      state.activeChatRunId = null;
    }
  };

  const promoteMostRecentSessionRun = (): boolean => {
    if (state.activeChatRunId) {
      return false;
    }
    const nextRunId = runCoordinator.resolveMostRecentPromotableRun();
    if (!nextRunId) {
      return false;
    }
    // Keep concurrent work visible after its previous activity owner ends.
    state.activeChatRunId = nextRunId;
    clearStreamingWatchdog();
    setActivityStatus("running");
    armStreamingWatchdog(nextRunId);
    return true;
  };

  const clearStaleStreamingIfNoTrackedRunRemains = () => {
    const activeRunId = state.activeChatRunId;
    const activeRunIsStillTracked = activeRunId ? sessionRuns.has(activeRunId) : false;
    if (state.activityStatus !== "streaming" || activeRunIsStillTracked || sessionRuns.size > 0) {
      return;
    }
    state.activeChatRunId = null;
    state.activityStatus = "idle";
    setActivityStatus("idle");
    clearStreamingWatchdog();
    flushPendingHistoryRefreshIfIdle();
  };

  const reconnectStreamingWatchdog = () => {
    clearStreamingWatchdog();
    const activeRunId = state.activeChatRunId;
    if (!activeRunId) {
      reconnectPendingRunId = null;
      clearStaleStreamingIfNoTrackedRunRemains();
      return;
    }
    if (!sessionRuns.has(activeRunId)) {
      reconnectPendingRunId = null;
      state.activeChatRunId = null;
      state.activityStatus = "idle";
      setActivityStatus("idle");
      flushPendingHistoryRefreshIfIdle();
      return;
    }
    reconnectPendingRunId = activeRunId;
    setActivityStatus("streaming");
    armStreamingWatchdog(activeRunId);
  };

  const finalizeRun = (params: {
    runId: string;
    wasActiveRun: boolean;
    status: "idle" | "error";
    displayedFinal?: boolean;
  }) => {
    runCoordinator.noteFinalizedRun(params.runId, { displayedFinal: params.displayedFinal });
    clearActiveRunIfMatch(params.runId);
    const promotedRemainingRun = promoteMostRecentSessionRun();
    flushPendingHistoryRefreshIfIdle();
    if (!promotedRemainingRun) {
      if (params.wasActiveRun) {
        setActivityStatus(params.status);
        clearStreamingWatchdog();
      } else {
        if (streamingWatchdogRunId === params.runId) {
          clearStreamingWatchdog();
        }
        clearStaleStreamingIfNoTrackedRunRemains();
      }
    }
    void refreshSessionInfo?.();
  };

  const terminateRun = (params: {
    runId: string;
    wasActiveRun: boolean;
    status: "aborted" | "error";
  }) => {
    runCoordinator.noteCompletedRun(params.runId);
    runCoordinator.dropSessionRun(params.runId);
    clearActiveRunIfMatch(params.runId);
    const promotedRemainingRun = promoteMostRecentSessionRun();
    flushPendingHistoryRefreshIfIdle();
    if (!promotedRemainingRun) {
      if (params.wasActiveRun) {
        setActivityStatus(params.status);
        clearStreamingWatchdog();
      } else if (streamingWatchdogRunId === params.runId) {
        clearStreamingWatchdog();
      }
    }
    void refreshSessionInfo?.();
  };

  const hasConcurrentActiveRun = (runId: string) => {
    const activeRunId = state.activeChatRunId;
    return Boolean(activeRunId && activeRunId !== runId);
  };

  const maybeRefreshHistoryForRun = (
    runId: string,
    options?: {
      allowLocalWithoutDisplayableFinal?: boolean;
      hasDisplayableFinal?: boolean;
      wasPendingChatRun?: boolean;
    },
  ) => {
    const isPendingChatRun =
      options?.wasPendingChatRun === true || getPendingSubmitAcceptedRunId(state) === runId;
    const isLocalRun = isLocalRunId?.(runId) ?? false;
    if (isLocalRun) {
      forgetLocalRunId?.(runId);
      if (!options?.allowLocalWithoutDisplayableFinal) {
        return;
      }
      if (state.activeChatRunId && state.activeChatRunId !== runId) {
        runCoordinator.pendingHistoryRefresh = true;
        return;
      }
    }
    if (!isPendingChatRun && hasPendingSubmit(state)) {
      runCoordinator.pendingHistoryRefresh = true;
      return;
    }
    // A full history rebuild before persistence would erase the displayed final.
    if (options?.hasDisplayableFinal || hasConcurrentActiveRun(runId)) {
      return;
    }
    runCoordinator.pendingHistoryRefresh = false;
    runCoordinator.queueHistoryReload();
  };

  const renderTerminalRunError = (params: {
    runId: string;
    errorMessage: string;
    requireActiveOrPending?: boolean;
  }): boolean => {
    const { runId, errorMessage } = params;
    const wasActiveRun = state.activeChatRunId === runId;
    if (
      params.requireActiveOrPending &&
      !wasActiveRun &&
      getPendingSubmitAcceptedRunId(state) !== runId
    ) {
      return false;
    }
    const renderedError = formatRawAssistantErrorForUi(errorMessage);
    chatLog.dismissPendingSystem(runId);
    const displayMessage = resolveAuthErrorHint(errorMessage) ?? `run error: ${renderedError}`;
    liveTerminalErrorMessages.set(runId, displayMessage);
    chatLog.addSystem(displayMessage);
    runCoordinator.noteFinalizedRun(runId, { displayedFinal: true });
    terminateRun({ runId, wasActiveRun, status: "error" });
    maybeRefreshHistoryForRun(runId, { hasDisplayableFinal: true });
    return true;
  };

  const scheduleTerminalLifecycleError = (runId: string, errorMessage: string) => {
    clearPendingTerminalLifecycleError(runId);
    const timer = setTimeout(() => {
      pendingTerminalLifecycleErrors.delete(runId);
      if (renderTerminalRunError({ runId, errorMessage, requireActiveOrPending: true })) {
        tui.requestRender(true);
      }
    }, LIFECYCLE_ERROR_RETRY_GRACE_MS);
    timer.unref?.();
    pendingTerminalLifecycleErrors.set(runId, { errorMessage, timer });
  };

  const dispose = () => {
    runCoordinator.clear();
    clearStreamingWatchdog();
    clearPendingTerminalLifecycleErrors();
  };

  return {
    acknowledgeChatRun,
    applyFallbackStepModelUpdate,
    armStreamingWatchdog,
    clearPendingTerminalLifecycleError,
    clearStreamingWatchdog,
    clearStaleStreamingIfNoTrackedRunRemains,
    clearTrackedRunState,
    dispose,
    finalizeRun,
    flushPendingHistoryRefreshIfIdle,
    hasConcurrentActiveRun,
    markSubmittedRunRegistered,
    maybeRefreshHistoryForRun,
    pauseStreamingWatchdog: clearStreamingWatchdog,
    reconnectStreamingWatchdog,
    renderTerminalRunError,
    scheduleTerminalLifecycleError,
    syncSessionKey,
    terminateRun,
  };
}
