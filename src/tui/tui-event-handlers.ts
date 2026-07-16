// Handles TUI keyboard, paste, backend, and command events.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { classifyFailoverReason, isAuthErrorMessage } from "../agents/embedded-agent-helpers.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { formatRawAssistantErrorForUi } from "../shared/assistant-error-format.js";
import {
  asString,
  extractTextFromMessage,
  isCommandMessage,
  sanitizeRenderableText,
} from "./tui-formatters.js";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";
import {
  clearPendingSubmit,
  clearPendingSubmitDraft,
  getPendingSubmitAcceptedRunId,
  hasPendingSubmit,
} from "./tui-submit-state.js";
import type {
  AgentEvent,
  BtwEvent,
  ChatEvent,
  SessionChangedEvent,
  TuiHistoryLoadResult,
  TuiStateAccess,
} from "./tui-types.js";

type EventHandlerChatLog = {
  startTool: (toolCallId: string, toolName: string, args: unknown) => void;
  updateToolResult: (
    toolCallId: string,
    result: unknown,
    options?: { partial?: boolean; isError?: boolean },
  ) => void;
  addSystem: (text: string) => void;
  addPendingSystem: (runId: string, text: string) => void;
  dismissPendingSystem: (runId: string) => void;
  updateAssistant: (text: string, runId: string) => void;
  finalizeAssistant: (text: string, runId: string) => void;
  dropAssistant: (runId: string) => void;
};

type EventHandlerTui = {
  requestRender: (force?: boolean) => void;
};

type EventHandlerBtwPresenter = {
  showResult: (params: { question: string; text: string; isError?: boolean }) => void;
  clear: () => void;
};

const MAX_ABORT_DIAGNOSTIC_LENGTH = 160;

function formatAbortDiagnostic(value: string | undefined): string | undefined {
  const diagnostic = sanitizeRenderableText(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!diagnostic) {
    return undefined;
  }
  return diagnostic.length > MAX_ABORT_DIAGNOSTIC_LENGTH
    ? `${truncateUtf16Safe(diagnostic, MAX_ABORT_DIAGNOSTIC_LENGTH - 1)}…`
    : diagnostic;
}

type EventHandlerContext = {
  chatLog: EventHandlerChatLog;
  btw: EventHandlerBtwPresenter;
  tui: EventHandlerTui;
  state: TuiStateAccess;
  setActivityStatus: (text: string) => void;
  refreshSessionInfo?: () => Promise<void>;
  loadHistory?: () => Promise<TuiHistoryLoadResult>;
  noteLocalRunId?: (runId: string) => void;
  isLocalRunId?: (runId: string) => boolean;
  forgetLocalRunId?: (runId: string) => void;
  clearLocalRunIds?: () => void;
  isLocalBtwRunId?: (runId: string) => boolean;
  forgetLocalBtwRunId?: (runId: string) => void;
  clearLocalBtwRunIds?: () => void;
  /** Reset `streaming` after this much delta silence. Set to 0 to disable. */
  streamingWatchdogMs?: number;
  localMode?: boolean;
};

const DEFAULT_STREAMING_WATCHDOG_MS = 30_000;
const LIFECYCLE_ERROR_RETRY_GRACE_MS = 15_000;
const STREAMING_WATCHDOG_USER_MESSAGE =
  "This response is taking longer than expected. Still waiting for the current run.";

export function createEventHandlers(context: EventHandlerContext) {
  const {
    chatLog,
    btw,
    tui,
    state,
    setActivityStatus,
    refreshSessionInfo,
    loadHistory,
    noteLocalRunId,
    isLocalRunId,
    forgetLocalRunId,
    clearLocalRunIds,
    isLocalBtwRunId,
    forgetLocalBtwRunId,
    clearLocalBtwRunIds,
    localMode,
  } = context;
  const sessionRuns = new Map<string, number>();
  const finalizedRuns = new Map<string, number>();
  const finalizedRunsWithDisplay = new Map<string, number>();
  const pendingNewSessionRunIds = new Set<string>();
  const persistedTerminalRunIds = new Map<string, number>();
  const historyReloadRunIds = new Set<string>();
  const historyOwnedReloadRunIds = new Set<string>();
  const historyDisplayedReloadRunIds = new Set<string>();
  const liveTerminalErrorMessages = new Map<string, string>();
  const queuedHistoryReloadRunIds = new Set<string>();
  const deferredHistoryRunEvents = new Map<string, ChatEvent>();
  let historyReloadInFlight = false;
  let historyReloadGeneration = 0;
  const completedRuns = new Map<string, number>();
  const postFinalizingRuns = new Map<string, number>();
  let streamAssembler = new TuiStreamAssembler();
  let lastSessionKey = state.currentSessionKey;
  let pendingHistoryRefresh = false;
  let reconnectPendingRunId: string | null = null;
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
  let streamingWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let streamingWatchdogRunId: string | null = null;

  const reloadHistoryPreservingTerminalErrors = async (): Promise<TuiHistoryLoadResult> => {
    if (!loadHistory) {
      return { loaded: false };
    }
    const reloadGeneration = historyReloadGeneration;
    const result = (await loadHistory()) ?? { loaded: false };
    if (!result.loaded || reloadGeneration !== historyReloadGeneration) {
      return result;
    }
    let restored = false;
    for (const [runId, message] of liveTerminalErrorMessages) {
      if (!finalizedRunsWithDisplay.has(runId)) {
        continue;
      }
      chatLog.addSystem(message);
      restored = true;
    }
    if (restored) {
      tui.requestRender(true);
    }
    return result;
  };

  const flushPendingHistoryRefreshIfIdle = () => {
    if (!pendingHistoryRefresh || state.activeChatRunId || hasPendingSubmit(state)) {
      return;
    }
    pendingHistoryRefresh = false;
    void reloadHistoryPreservingTerminalErrors();
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

  const pauseStreamingWatchdog = () => {
    clearStreamingWatchdog();
  };

  const clearTrackedRunState = () => {
    historyReloadGeneration += 1;
    pendingNewSessionRunIds.clear();
    persistedTerminalRunIds.clear();
    historyReloadRunIds.clear();
    historyOwnedReloadRunIds.clear();
    historyDisplayedReloadRunIds.clear();
    liveTerminalErrorMessages.clear();
    queuedHistoryReloadRunIds.clear();
    deferredHistoryRunEvents.clear();
    finalizedRuns.clear();
    finalizedRunsWithDisplay.clear();
    completedRuns.clear();
    sessionRuns.clear();
    postFinalizingRuns.clear();
    streamAssembler = new TuiStreamAssembler();
    pendingHistoryRefresh = false;
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
        pendingHistoryRefresh = false;
        void reloadHistoryPreservingTerminalErrors();
        tui.requestRender();
        return;
      }
      chatLog.addPendingSystem(runId, STREAMING_WATCHDOG_USER_MESSAGE);
      tui.requestRender();
    }, streamingWatchdogMs);
    const maybeUnref = (streamingWatchdogTimer as { unref?: () => void }).unref;
    if (typeof maybeUnref === "function") {
      maybeUnref.call(streamingWatchdogTimer);
    }
  };

  const pruneRunMap = (runs: Map<string, number>) => {
    if (runs.size <= 200) {
      return;
    }
    const keepUntil = Date.now() - 10 * 60 * 1000;
    for (const [key, ts] of runs) {
      if (runs.size <= 150) {
        break;
      }
      if (ts < keepUntil) {
        runs.delete(key);
      }
    }
    if (runs.size > 200) {
      for (const key of runs.keys()) {
        runs.delete(key);
        if (runs.size <= 150) {
          break;
        }
      }
    }
  };

  const syncSessionKey = () => {
    if (state.currentSessionKey === lastSessionKey) {
      return;
    }
    lastSessionKey = state.currentSessionKey;
    if (state.activeChatRunId || hasPendingSubmit(state)) {
      return;
    }
    clearTrackedRunState();
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

  const parseProviderModelRef = (
    modelRef: unknown,
  ): { provider: string; model: string } | undefined => {
    if (typeof modelRef !== "string") {
      return undefined;
    }
    const trimmed = modelRef.trim();
    const separator = trimmed.indexOf("/");
    if (separator <= 0 || separator >= trimmed.length - 1) {
      return undefined;
    }
    const provider = trimmed.slice(0, separator).trim();
    const model = trimmed.slice(separator + 1).trim();
    return provider && model ? { provider, model } : undefined;
  };

  const applyFallbackStepModelUpdate = (evt: AgentEvent): boolean => {
    const data = evt.data ?? {};
    if (evt.stream !== "lifecycle" || asString(data.phase, "") !== "fallback_step") {
      return false;
    }
    const target = parseProviderModelRef(data.fallbackStepToModel);
    if (!target) {
      return false;
    }
    state.sessionInfo.modelProvider = target.provider;
    state.sessionInfo.model = target.model;
    return true;
  };

  const noteSessionRun = (runId: string) => {
    sessionRuns.set(runId, Date.now());
    pruneRunMap(sessionRuns);
  };

  const markSubmittedRunRegistered = (runId: string) => {
    clearPendingSubmitDraft(state, runId);
  };

  const noteFinalizedRun = (runId: string, opts?: { displayedFinal?: boolean }) => {
    finalizedRuns.set(runId, Date.now());
    completedRuns.set(runId, Date.now());
    if (opts?.displayedFinal === true) {
      finalizedRunsWithDisplay.set(runId, Date.now());
    }
    sessionRuns.delete(runId);
    streamAssembler.drop(runId);
    pruneRunMap(finalizedRuns);
    pruneRunMap(finalizedRunsWithDisplay);
    pruneRunMap(completedRuns);
    for (const retainedRunId of liveTerminalErrorMessages.keys()) {
      if (!finalizedRunsWithDisplay.has(retainedRunId)) {
        liveTerminalErrorMessages.delete(retainedRunId);
      }
    }
  };

  const notePostFinalizingRun = (runId: string) => {
    postFinalizingRuns.set(runId, Date.now());
    pruneRunMap(postFinalizingRuns);
  };

  const clearActiveRunIfMatch = (runId: string) => {
    if (state.activeChatRunId === runId) {
      state.activeChatRunId = null;
    }
  };

  const promoteMostRecentSessionRun = (): boolean => {
    if (state.activeChatRunId || sessionRuns.size === 0) {
      return false;
    }
    let nextRunId: string | undefined;
    let nextSeenAt = -1;
    for (const [runId, seenAt] of sessionRuns) {
      if (seenAt > nextSeenAt) {
        nextRunId = runId;
        nextSeenAt = seenAt;
      }
    }
    if (!nextRunId) {
      return false;
    }
    // A concurrent run can outlive the active run. Keep the activity owner on
    // remaining work so terminal cleanup cannot incorrectly return the TUI idle.
    state.activeChatRunId = nextRunId;
    clearStreamingWatchdog();
    setActivityStatus("running");
    armStreamingWatchdog(nextRunId);
    return true;
  };

  const clearStaleStreamingIfNoTrackedRunRemains = () => {
    const activeRunId = state.activeChatRunId;
    // A missing active run is the recovery case; only tracked active runs block cleanup.
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
    noteFinalizedRun(params.runId, { displayedFinal: params.displayedFinal });
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
    completedRuns.set(params.runId, Date.now());
    pruneRunMap(completedRuns);
    streamAssembler.drop(params.runId);
    sessionRuns.delete(params.runId);
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

  const renderTerminalRunError = (params: {
    runId: string;
    errorMessage: string;
    requireActiveOrPending?: boolean;
  }): boolean => {
    const { runId, errorMessage } = params;
    const wasActiveRun = state.activeChatRunId === runId;
    if (
      params.requireActiveOrPending === true &&
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
    noteFinalizedRun(runId, { displayedFinal: true });
    terminateRun({ runId, wasActiveRun, status: "error" });
    maybeRefreshHistoryForRun(runId, { hasDisplayableFinal: true });
    return true;
  };

  const renderTerminalLifecycleError = (runId: string, errorMessage: string) => {
    if (!renderTerminalRunError({ runId, errorMessage, requireActiveOrPending: true })) {
      return;
    }
    tui.requestRender(true);
  };

  const scheduleTerminalLifecycleError = (runId: string, errorMessage: string) => {
    clearPendingTerminalLifecycleError(runId);
    const timer = setTimeout(() => {
      pendingTerminalLifecycleErrors.delete(runId);
      renderTerminalLifecycleError(runId, errorMessage);
    }, LIFECYCLE_ERROR_RETRY_GRACE_MS);
    timer.unref?.();
    pendingTerminalLifecycleErrors.set(runId, { errorMessage, timer });
  };

  const hasConcurrentActiveRun = (runId: string) => {
    const activeRunId = state.activeChatRunId;
    return Boolean(activeRunId && activeRunId !== runId);
  };

  const maybeRefreshHistoryForRun = (
    runId: string,
    opts?: {
      allowLocalWithoutDisplayableFinal?: boolean;
      hasDisplayableFinal?: boolean;
      wasPendingChatRun?: boolean;
    },
  ) => {
    const isPendingChatRun =
      opts?.wasPendingChatRun === true || getPendingSubmitAcceptedRunId(state) === runId;
    const isLocalRun = isLocalRunId?.(runId) ?? false;
    if (isLocalRun) {
      forgetLocalRunId?.(runId);
      // Local runs with displayable output do not need a history reload.
      if (!opts?.allowLocalWithoutDisplayableFinal) {
        return;
      }
      // Defer the reload if a newer run is active so we preserve the pending
      // user message, then flush once that active run finishes.
      if (state.activeChatRunId && state.activeChatRunId !== runId) {
        pendingHistoryRefresh = true;
        return;
      }
    }
    if (!isPendingChatRun && hasPendingSubmit(state)) {
      pendingHistoryRefresh = true;
      return;
    }
    // When the final event already produced displayable output, skip the
    // reload. loadHistory() does clearAll() + rebuild from server, but the
    // server may not have persisted this message yet, causing the
    // just-rendered final message to vanish (#87922).
    if (opts?.hasDisplayableFinal) {
      return;
    }
    if (hasConcurrentActiveRun(runId)) {
      return;
    }
    pendingHistoryRefresh = false;
    void reloadHistoryPreservingTerminalErrors();
  };

  const messageHasDisplayableNonTextContent = (message: unknown): boolean => {
    if (!message || typeof message !== "object") {
      return false;
    }
    const record = message as Record<string, unknown>;
    if (typeof record.mediaUrl === "string" && record.mediaUrl.trim()) {
      return true;
    }
    if (
      Array.isArray(record.mediaUrls) &&
      record.mediaUrls.some((media) => typeof media === "string" && media.trim())
    ) {
      return true;
    }
    if (!Array.isArray(record.content)) {
      return false;
    }
    return record.content.some((block) => {
      if (!block || typeof block !== "object") {
        return false;
      }
      const type = (block as Record<string, unknown>).type;
      return typeof type === "string" && type !== "text" && type !== "thinking";
    });
  };

  const hasDisplayableFinalEvent = (evt: ChatEvent): boolean => {
    if (typeof evt.errorMessage === "string" && evt.errorMessage.trim()) {
      return true;
    }
    if (!evt.message) {
      return false;
    }
    if (extractTextFromMessage(evt.message, { includeThinking: state.showThinking }).trim()) {
      return true;
    }
    return messageHasDisplayableNonTextContent(evt.message);
  };

  const isSameSessionKey = (left: string | undefined, right: string | undefined): boolean => {
    const normalizedLeft = normalizeLowercaseStringOrEmpty(left);
    const normalizedRight = normalizeLowercaseStringOrEmpty(right);
    if (!normalizedLeft || !normalizedRight) {
      return false;
    }
    if (normalizedLeft === normalizedRight) {
      return true;
    }
    const parsedLeft = parseAgentSessionKey(normalizedLeft);
    const parsedRight = parseAgentSessionKey(normalizedRight);
    if (parsedLeft && parsedRight) {
      return parsedLeft.agentId === parsedRight.agentId && parsedLeft.rest === parsedRight.rest;
    }
    if (parsedLeft) {
      return parsedLeft.rest === normalizedRight;
    }
    if (parsedRight) {
      return normalizedLeft === parsedRight.rest;
    }
    return false;
  };

  const isMatchingGlobalAgentEvent = (
    sessionKey: string | undefined,
    agentId?: string,
  ): boolean => {
    if (normalizeLowercaseStringOrEmpty(sessionKey) !== "global") {
      return true;
    }
    const selectedAgentId = normalizeLowercaseStringOrEmpty(state.currentAgentId);
    const defaultAgentId = normalizeLowercaseStringOrEmpty(state.agentDefaultId);
    const eventAgentId = normalizeLowercaseStringOrEmpty(agentId);
    if (eventAgentId) {
      return eventAgentId === selectedAgentId;
    }
    return selectedAgentId === defaultAgentId;
  };

  const handleChatEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as ChatEvent;
    syncSessionKey();
    if (!isSameSessionKey(evt.sessionKey, state.currentSessionKey)) {
      return;
    }
    if (!isMatchingGlobalAgentEvent(evt.sessionKey, evt.agentId)) {
      return;
    }
    if (historyReloadRunIds.has(evt.runId)) {
      const previous = deferredHistoryRunEvents.get(evt.runId);
      // Keep the latest delta until a terminal event arrives; terminal state
      // stays authoritative if a delayed delta follows it.
      if (!previous || previous.state === "delta" || evt.state !== "delta") {
        deferredHistoryRunEvents.set(evt.runId, evt);
      }
      return;
    }
    if (finalizedRuns.has(evt.runId)) {
      if (evt.state === "delta") {
        return;
      }
      if (evt.state === "error" && finalizedRunsWithDisplay.has(evt.runId)) {
        clearStaleStreamingIfNoTrackedRunRemains();
        return;
      }
      if (evt.state === "final") {
        const hasLateDisplayableFinal =
          hasDisplayableFinalEvent(evt) && !finalizedRunsWithDisplay.has(evt.runId);
        if (!hasLateDisplayableFinal) {
          clearStaleStreamingIfNoTrackedRunRemains();
          return;
        }
      }
    }
    if (reconnectPendingRunId === evt.runId) {
      reconnectPendingRunId = null;
    }
    clearPendingTerminalLifecycleError(evt.runId);
    chatLog.dismissPendingSystem(evt.runId);
    noteSessionRun(evt.runId);
    markSubmittedRunRegistered(evt.runId);
    const isPendingChatRun = getPendingSubmitAcceptedRunId(state) === evt.runId;
    const isLocalChatRun = isLocalRunId?.(evt.runId) ?? false;
    const isLocalBtwRun = isLocalBtwRunId?.(evt.runId) ?? false;
    const isNewOptimisticRun =
      hasPendingSubmit(state) &&
      !isLocalBtwRun &&
      (isPendingChatRun || (isLocalChatRun && evt.runId !== state.activeChatRunId));
    if (isNewOptimisticRun) {
      noteLocalRunId?.(evt.runId);
      clearPendingSubmit(state, evt.runId);
    }
    if (!state.activeChatRunId && !isLocalBtwRun) {
      state.activeChatRunId = evt.runId;
    }
    if (isPendingChatRun) {
      clearPendingSubmit(state, evt.runId);
    }
    if (evt.state === "delta") {
      // Arm watchdog and mark streaming on every delta, even when the visible
      // text hasn't changed yet (e.g. first commentary-only or tool-call delta).
      // Without this, the watchdog never fires and the status bar stays stale.
      setActivityStatus("streaming");
      if (state.activeChatRunId === evt.runId) {
        armStreamingWatchdog(evt.runId);
      }
      const displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
      if (!displayText) {
        return;
      }
      chatLog.updateAssistant(displayText, evt.runId);
    }
    if (evt.state === "final") {
      const isLocalBtwRunLocal = isLocalBtwRunId?.(evt.runId) ?? false;
      const wasActiveRun = state.activeChatRunId === evt.runId;
      if (!evt.message && isLocalBtwRunLocal) {
        forgetLocalBtwRunId?.(evt.runId);
        noteFinalizedRun(evt.runId);
        clearStaleStreamingIfNoTrackedRunRemains();
        tui.requestRender(true);
        return;
      }
      if (!evt.message) {
        maybeRefreshHistoryForRun(evt.runId, {
          allowLocalWithoutDisplayableFinal: true,
          wasPendingChatRun: isPendingChatRun,
        });
        chatLog.dropAssistant(evt.runId);
        finalizeRun({ runId: evt.runId, wasActiveRun, status: "idle" });
        tui.requestRender(true);
        return;
      }
      if (isCommandMessage(evt.message)) {
        maybeRefreshHistoryForRun(evt.runId, { wasPendingChatRun: isPendingChatRun });
        const text = extractTextFromMessage(evt.message);
        if (text) {
          chatLog.addSystem(text);
        }
        finalizeRun({ runId: evt.runId, wasActiveRun, status: "idle", displayedFinal: true });
        tui.requestRender(true);
        return;
      }
      const stopReason =
        evt.message && typeof evt.message === "object" && !Array.isArray(evt.message)
          ? typeof (evt.message as Record<string, unknown>).stopReason === "string"
            ? ((evt.message as Record<string, unknown>).stopReason as string)
            : ""
          : "";

      const finalText = streamAssembler.finalize(
        evt.runId,
        evt.message,
        state.showThinking,
        evt.errorMessage,
      );
      const suppressEmptyExternalPlaceholder =
        finalText === "(no output)" && !isLocalRunId?.(evt.runId);
      // Skip the history reload when the final event produced displayable
      // output. loadHistory() does clearAll() + rebuild from server data,
      // but the server may not have persisted this message yet — causing
      // the just-rendered final message to vanish (#87922).
      maybeRefreshHistoryForRun(evt.runId, {
        hasDisplayableFinal: !suppressEmptyExternalPlaceholder,
        wasPendingChatRun: isPendingChatRun,
      });
      if (suppressEmptyExternalPlaceholder) {
        chatLog.dropAssistant(evt.runId);
      } else {
        chatLog.finalizeAssistant(finalText, evt.runId);
      }
      finalizeRun({
        runId: evt.runId,
        wasActiveRun,
        status: stopReason === "error" ? "error" : "idle",
        displayedFinal: !suppressEmptyExternalPlaceholder,
      });
    }
    if (evt.state === "aborted") {
      forgetLocalBtwRunId?.(evt.runId);
      const wasActiveRun = state.activeChatRunId === evt.runId;
      const diagnostic = formatAbortDiagnostic(evt.errorMessage);
      chatLog.addSystem(diagnostic ? `run aborted: ${diagnostic}` : "run aborted");
      terminateRun({ runId: evt.runId, wasActiveRun, status: "aborted" });
      maybeRefreshHistoryForRun(evt.runId);
    }
    if (evt.state === "error") {
      forgetLocalBtwRunId?.(evt.runId);
      renderTerminalRunError({
        runId: evt.runId,
        errorMessage: evt.errorMessage ?? "unknown",
      });
    }
    tui.requestRender();
  };

  const drainHistoryReloadQueue = () => {
    if (historyReloadInFlight || queuedHistoryReloadRunIds.size === 0 || !loadHistory) {
      return;
    }
    const reloadGeneration = historyReloadGeneration;
    const runIds = Array.from(queuedHistoryReloadRunIds);
    queuedHistoryReloadRunIds.clear();
    historyReloadInFlight = true;
    const finishReload = (result: TuiHistoryLoadResult) => {
      if (reloadGeneration !== historyReloadGeneration) {
        return;
      }
      for (const runId of runIds) {
        historyReloadRunIds.delete(runId);
        const deferred = deferredHistoryRunEvents.get(runId);
        deferredHistoryRunEvents.delete(runId);
        const historyOwned = historyOwnedReloadRunIds.delete(runId);
        const previouslyDisplayed = historyDisplayedReloadRunIds.delete(runId);
        const restoredInFlight = result.loaded && result.inFlightRunId === runId;
        if (historyOwned && !restoredInFlight) {
          // Rebuilt history owns the final row; after a failed rebuild retain
          // the pre-reload display fact so late finals neither duplicate nor vanish.
          finalizeRun({
            runId,
            wasActiveRun: state.activeChatRunId === runId,
            status: "idle",
            displayedFinal: result.loaded || previouslyDisplayed,
          });
        }
        if (deferred && (!result.loaded || historyOwned || restoredInFlight)) {
          handleChatEvent(deferred);
        }
      }
    };
    void reloadHistoryPreservingTerminalErrors()
      .then(finishReload, () => finishReload({ loaded: false }))
      .finally(() => {
        historyReloadInFlight = false;
        drainHistoryReloadQueue();
      });
  };

  const queueHistoryReload = (
    runIds: Iterable<string>,
    historyOwnedRunIds: Iterable<string>,
    displayedRunIds: Iterable<string> = [],
  ) => {
    const historyOwned = new Set(historyOwnedRunIds);
    const displayed = new Set(displayedRunIds);
    if (!loadHistory) {
      for (const runId of runIds) {
        if (historyOwned.has(runId)) {
          noteFinalizedRun(runId, { displayedFinal: true });
        }
      }
      void refreshSessionInfo?.();
      return;
    }
    for (const runId of runIds) {
      historyReloadRunIds.add(runId);
      queuedHistoryReloadRunIds.add(runId);
      if (historyOwned.has(runId)) {
        historyOwnedReloadRunIds.add(runId);
      }
      if (displayed.has(runId)) {
        historyDisplayedReloadRunIds.add(runId);
      }
    }
    drainHistoryReloadQueue();
  };

  const collectTrackedSessionRunIds = () => {
    const runIds = new Set(sessionRuns.keys());
    if (state.activeChatRunId) {
      runIds.add(state.activeChatRunId);
    }
    const pendingRunId = getPendingSubmitAcceptedRunId(state);
    if (pendingRunId) {
      runIds.add(pendingRunId);
    }
    const finalizedRunIds = new Set(finalizedRuns.keys());
    const displayedRunIds = new Set(finalizedRunsWithDisplay.keys());
    for (const runId of finalizedRunIds) {
      runIds.add(runId);
    }
    return { runIds, finalizedRunIds, displayedRunIds };
  };

  const handleSessionsChangedEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as SessionChangedEvent;
    syncSessionKey();
    if (!isSameSessionKey(evt.sessionKey, state.currentSessionKey)) {
      return;
    }
    if (!isMatchingGlobalAgentEvent(evt.sessionKey, evt.agentId)) {
      return;
    }

    if (evt.runId && (evt.phase === "end" || evt.phase === "error")) {
      persistedTerminalRunIds.set(evt.runId, Date.now());
      pruneRunMap(persistedTerminalRunIds);
      if (pendingNewSessionRunIds.delete(evt.runId)) {
        if (evt.phase === "end") {
          const displayedRunIds = finalizedRunsWithDisplay.has(evt.runId) ? [evt.runId] : [];
          queueHistoryReload([evt.runId], [evt.runId], displayedRunIds);
        } else {
          void refreshSessionInfo?.();
        }
      }
      return;
    }
    if (evt.reason !== "new" && evt.reason !== "reset") {
      return;
    }

    const nextSessionId = typeof evt.sessionId === "string" ? evt.sessionId : null;
    const replacesKnownSession =
      state.currentSessionId !== null &&
      nextSessionId !== null &&
      state.currentSessionId !== nextSessionId;
    if (evt.reason === "new" && !replacesKnownSession) {
      const { runIds, displayedRunIds } = collectTrackedSessionRunIds();
      if (runIds.size > 0) {
        if (nextSessionId) {
          state.currentSessionId = nextSessionId;
        }
        if (typeof evt.updatedAt === "number" || evt.updatedAt === null) {
          state.sessionInfo.updatedAt = evt.updatedAt;
        }
        const persistedRunIds: string[] = [];
        for (const runId of runIds) {
          if (persistedTerminalRunIds.has(runId)) {
            persistedRunIds.push(runId);
          } else {
            pendingNewSessionRunIds.add(runId);
          }
        }
        queueHistoryReload(persistedRunIds, persistedRunIds, displayedRunIds);
        tui.requestRender();
        return;
      }
    }

    const {
      runIds: reloadingRunIds,
      finalizedRunIds,
      displayedRunIds,
    } = collectTrackedSessionRunIds();
    clearTrackedRunState();
    state.activeChatRunId = null;
    state.activityStatus = "idle";
    setActivityStatus("idle");
    if (nextSessionId) {
      state.currentSessionId = nextSessionId;
    }
    if (typeof evt.updatedAt === "number" || evt.updatedAt === null) {
      state.sessionInfo.updatedAt = evt.updatedAt;
    }
    if (reloadingRunIds.size > 0) {
      queueHistoryReload(reloadingRunIds, finalizedRunIds, displayedRunIds);
    } else if (loadHistory) {
      void reloadHistoryPreservingTerminalErrors();
    } else {
      void refreshSessionInfo?.();
    }
    tui.requestRender();
  };
  const handleAgentEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as AgentEvent;
    syncSessionKey();
    // System-injected runs (bridge-notify, webhook, cron) never go through the
    // TUI submit path, so no active/pending run id exists when their lifecycle
    // "start" arrives — leaving the status bar idle until the response lands.
    // Adopt such a run for the current session (lifecycle events always carry
    // sessionKey) so the activity indicator shows work is happening, mirroring
    // how chat deltas adopt runs in handleChatEvent. Only claim the active slot
    // when none is held, so a concurrent user run keeps the indicator.
    const isUntrackedRun =
      evt.runId !== state.activeChatRunId &&
      evt.runId !== getPendingSubmitAcceptedRunId(state) &&
      !sessionRuns.has(evt.runId) &&
      !finalizedRuns.has(evt.runId);
    if (
      isUntrackedRun &&
      evt.stream === "lifecycle" &&
      asString(evt.data?.phase, "") === "start" &&
      !(isLocalBtwRunId?.(evt.runId) ?? false) &&
      isSameSessionKey(evt.sessionKey, state.currentSessionKey) &&
      isMatchingGlobalAgentEvent(evt.sessionKey, evt.agentId)
    ) {
      noteSessionRun(evt.runId);
      // Mirror handleChatEvent: side-question (btw) runs never claim the active
      // slot, so a concurrent btw run cannot hijack the main activity indicator.
      if (!state.activeChatRunId) {
        state.activeChatRunId = evt.runId;
      }
    }
    // Agent events (tool streaming, lifecycle) are emitted per-run. Filter against the
    // active chat run id, not the session id. Tool results can arrive after the chat
    // final event, so accept finalized runs for tool updates.
    const isActiveRun = evt.runId === state.activeChatRunId;
    const isPendingRun = evt.runId === getPendingSubmitAcceptedRunId(state);
    const isSessionRun = sessionRuns.has(evt.runId);
    if ((isActiveRun || isPendingRun || isSessionRun) && applyFallbackStepModelUpdate(evt)) {
      if (isActiveRun) {
        armStreamingWatchdog(evt.runId);
      }
      tui.requestRender();
      return;
    }
    const isKnownRun = isActiveRun || isPendingRun || isSessionRun || finalizedRuns.has(evt.runId);
    if (!isKnownRun) {
      return;
    }
    if (evt.stream === "tool") {
      if (isActiveRun) {
        armStreamingWatchdog(evt.runId);
      }
      const verbose = state.sessionInfo.verboseLevel ?? "off";
      const allowToolEvents = verbose !== "off";
      const allowToolOutput = verbose === "full";
      if (!allowToolEvents) {
        return;
      }
      const data = evt.data ?? {};
      const phase = asString(data.phase, "");
      const toolCallId = asString(data.toolCallId, "");
      const toolName = asString(data.name, "tool");
      if (!toolCallId) {
        return;
      }
      if (phase === "start") {
        chatLog.startTool(toolCallId, toolName, data.args);
      } else if (phase === "update") {
        if (!allowToolOutput) {
          return;
        }
        chatLog.updateToolResult(toolCallId, data.partialResult, {
          partial: true,
        });
      } else if (phase === "result") {
        if (allowToolOutput) {
          chatLog.updateToolResult(toolCallId, data.result, {
            isError: Boolean(data.isError),
          });
        } else {
          chatLog.updateToolResult(toolCallId, { content: [] }, { isError: Boolean(data.isError) });
        }
      }
      tui.requestRender();
      return;
    }
    if (evt.stream === "lifecycle") {
      if (isPendingRun) {
        // Exact run ownership matters: concurrent clients share this event stream.
        noteSessionRun(evt.runId);
        markSubmittedRunRegistered(evt.runId);
        state.activeChatRunId = evt.runId;
        noteLocalRunId?.(evt.runId);
        clearPendingSubmit(state, evt.runId);
      }
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (phase && phase !== "error") {
        clearPendingTerminalLifecycleError(evt.runId);
      }
      const isPostFinalizingRun = postFinalizingRuns.has(evt.runId);
      const isPostFinalTerminalPhase =
        isPostFinalizingRun && (phase === "end" || phase === "error");
      if (!isActiveRun && !isPendingRun && phase !== "finishing" && !isPostFinalTerminalPhase) {
        return;
      }
      const canUpdateActivityStatus = !hasConcurrentActiveRun(evt.runId);
      if (phase && phase !== "end" && phase !== "error" && phase !== "finishing") {
        armStreamingWatchdog(evt.runId);
      }
      if (phase === "start") {
        if (!canUpdateActivityStatus) {
          return;
        }
        setActivityStatus("running");
      }
      if (phase === "finishing") {
        notePostFinalizingRun(evt.runId);
        if (!canUpdateActivityStatus) {
          return;
        }
        clearStreamingWatchdog();
        setActivityStatus("finishing context");
      }
      let forceRender = false;
      if (phase === "end") {
        postFinalizingRuns.delete(evt.runId);
        if (!canUpdateActivityStatus) {
          return;
        }
        setActivityStatus("idle");
        forceRender = true;
      }
      if (phase === "error") {
        postFinalizingRuns.delete(evt.runId);
        if (!canUpdateActivityStatus) {
          return;
        }
        const isTerminalLifecycleError = typeof evt.data?.endedAt === "number";
        if (isTerminalLifecycleError && (isActiveRun || isPendingRun)) {
          const errorMessage =
            typeof evt.data?.error === "string"
              ? evt.data.error
              : typeof evt.data?.errorMessage === "string"
                ? evt.data.errorMessage
                : "unknown";
          scheduleTerminalLifecycleError(evt.runId, errorMessage);
          setActivityStatus("error");
        } else {
          setActivityStatus("error");
        }
        forceRender = true;
      }
      tui.requestRender(forceRender);
    }
  };

  const handleBtwEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as BtwEvent;
    syncSessionKey();
    if (!isSameSessionKey(evt.sessionKey, state.currentSessionKey)) {
      return;
    }
    if (!isMatchingGlobalAgentEvent(evt.sessionKey, evt.agentId)) {
      return;
    }
    if (evt.kind !== "btw") {
      return;
    }
    const question = evt.question.trim();
    const text = evt.text.trim();
    if (!question || !text) {
      return;
    }
    btw.showResult({
      question,
      text,
      isError: evt.isError,
    });
    tui.requestRender();
  };

  const dispose = () => {
    historyReloadGeneration += 1;
    pendingNewSessionRunIds.clear();
    persistedTerminalRunIds.clear();
    historyReloadRunIds.clear();
    historyOwnedReloadRunIds.clear();
    historyDisplayedReloadRunIds.clear();
    liveTerminalErrorMessages.clear();
    queuedHistoryReloadRunIds.clear();
    deferredHistoryRunEvents.clear();
    clearStreamingWatchdog();
    clearPendingTerminalLifecycleErrors();
  };

  const consumeCompletedRunForPendingSend = (runId: string) => {
    if (!completedRuns.has(runId)) {
      return false;
    }
    completedRuns.delete(runId);
    return true;
  };

  // True once any event for this runId has been seen, even before sendChat
  // resolves. Lets the optimistic-submit path know an accepted run already
  // registered so it does not re-arm a draft the abort path would then drop.
  const isRunObserved = (runId: string) => sessionRuns.has(runId);

  return {
    handleChatEvent,
    handleAgentEvent,
    handleBtwEvent,
    handleSessionsChangedEvent,
    pauseStreamingWatchdog,
    reconnectStreamingWatchdog,
    consumeCompletedRunForPendingSend,
    isRunObserved,
    flushPendingHistoryRefreshIfIdle,
    dispose,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
