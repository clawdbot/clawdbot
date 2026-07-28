// Handles TUI keyboard, paste, backend, and command events.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  asString,
  extractTextFromMessage,
  isCommandMessage,
  sanitizeRenderableText,
} from "./tui-formatters.js";
import { createTuiRunLifecycle } from "./tui-run-lifecycle.js";
import { matchesSelectedTuiSession } from "./tui-session-events.js";
import { TuiSessionRunCoordinator } from "./tui-session-run-coordinator.js";
import {
  clearPendingSubmit,
  getPendingSubmitAcceptedRunId,
  hasPendingSubmit,
} from "./tui-submit-state.js";
import type {
  AgentEvent,
  BtwEvent,
  ChatEvent,
  SessionChangedEvent,
  SessionMessageEvent,
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
  const runCoordinator = new TuiSessionRunCoordinator({
    state,
    loadHistory,
    refreshSessionInfo,
    restoreTerminalError: (message) => chatLog.addSystem(message),
    requestRender: (force) => tui.requestRender(force),
    finalizeHistoryOwnedRun: ({ runId, result, previouslyDisplayed }) => {
      // Persisted history owns the final row; retain the previous display fact
      // after a failed rebuild so delayed finals never duplicate or disappear.
      finalizeRun({
        runId,
        wasActiveRun: state.activeChatRunId === runId,
        status: "idle",
        displayedFinal: result.loaded || previouslyDisplayed,
      });
    },
    replayHistoryRunEvent: (event) => handleChatEvent(event),
  });
  const {
    sessionRuns,
    finalizedRuns,
    finalizedRunsWithDisplay,
    pendingNewSessionRunIds,
    persistedTerminalRunIds,
    completedRuns,
    postFinalizingRuns,
    streamAssembler,
  } = runCoordinator;
  const {
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
    pauseStreamingWatchdog,
    reconnectStreamingWatchdog,
    renderTerminalRunError,
    scheduleTerminalLifecycleError,
    syncSessionKey,
    terminateRun,
  } = createTuiRunLifecycle({
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
    streamingWatchdogMs: context.streamingWatchdogMs,
    localMode,
  });

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

  const handleChatEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as ChatEvent;
    syncSessionKey();
    if (!matchesSelectedTuiSession(state, evt)) {
      return;
    }
    const isSequencedGatewayEvent = Number.isSafeInteger(evt.seq) && (evt.seq ?? -1) >= 0;
    if (
      runCoordinator.isRetiredOrphanRun(evt.runId) &&
      !isSequencedGatewayEvent &&
      evt.runId !== getPendingSubmitAcceptedRunId(state)
    ) {
      return;
    }
    if (runCoordinator.isHistoryReloadingRun(evt.runId)) {
      runCoordinator.deferHistoryRunEvent(evt);
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
    // Gateway chat envelopes require a non-negative sequence, even when a
    // legacy peer omits agent lifecycle starts; orphan deltas have none.
    acknowledgeChatRun(evt.runId, {
      protectStream: isSequencedGatewayEvent,
    });
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
        runCoordinator.noteFinalizedRun(evt.runId);
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
      // Determine content from the message and stream, not the user-visible
      // empty placeholder: "(no output)" is also valid assistant text.
      const hasDisplayableAbortedText =
        Boolean(
          extractTextFromMessage(evt.message, { includeThinking: state.showThinking }).trim(),
        ) || streamAssembler.hasDisplayText(evt.runId);
      // Abort envelopes carry the complete buffered reply, including text
      // suppressed by Gateway delta throttling; finalize it before run cleanup.
      const abortedText = streamAssembler.finalize(evt.runId, evt.message, state.showThinking);
      if (hasDisplayableAbortedText) {
        chatLog.finalizeAssistant(abortedText, evt.runId);
      }
      const diagnostic = formatAbortDiagnostic(evt.errorMessage);
      chatLog.addSystem(diagnostic ? `run aborted: ${diagnostic}` : "run aborted");
      terminateRun({ runId: evt.runId, wasActiveRun, status: "aborted" });
      maybeRefreshHistoryForRun(evt.runId, {
        hasDisplayableFinal: hasDisplayableAbortedText,
      });
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

  const queueHistoryReload = (
    runIds?: Iterable<string>,
    historyOwnedRunIds: Iterable<string> = [],
    displayedRunIds: Iterable<string> = [],
  ) => runCoordinator.queueHistoryReload(runIds, historyOwnedRunIds, displayedRunIds);

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
    if (!matchesSelectedTuiSession(state, evt)) {
      return;
    }

    const persistedRunId = evt.clientRunId || evt.runId;
    if (persistedRunId && (evt.phase === "end" || evt.phase === "error")) {
      runCoordinator.notePersistedRun(persistedRunId);
      if (pendingNewSessionRunIds.delete(persistedRunId)) {
        if (evt.phase === "end") {
          const displayedRunIds = finalizedRunsWithDisplay.has(persistedRunId)
            ? [persistedRunId]
            : [];
          queueHistoryReload([persistedRunId], [persistedRunId], displayedRunIds);
        } else {
          void refreshSessionInfo?.();
        }
      }
      flushPendingHistoryRefreshIfIdle();
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
    } else {
      queueHistoryReload();
    }
    tui.requestRender();
  };

  const handleSessionMessageEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as SessionMessageEvent;
    syncSessionKey();
    if (!matchesSelectedTuiSession(state, evt, { requireAliasOwnership: true })) {
      return;
    }

    const currentUpdatedAt = state.sessionInfo.updatedAt;
    const isOlderSnapshot =
      typeof evt.updatedAt === "number" &&
      typeof currentUpdatedAt === "number" &&
      evt.updatedAt < currentUpdatedAt;
    if (!isOlderSnapshot) {
      if (typeof evt.sessionId === "string") {
        state.currentSessionId = evt.sessionId;
      }
      if (typeof evt.updatedAt === "number" || evt.updatedAt === null) {
        state.sessionInfo.updatedAt = evt.updatedAt;
      }
    }

    if (runCoordinator.deferSessionMessageRefresh()) {
      void refreshSessionInfo?.();
      return;
    }
    flushPendingHistoryRefreshIfIdle();
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
      evt.stream === "lifecycle" &&
      asString(evt.data?.phase, "") === "start" &&
      !finalizedRuns.has(evt.runId) &&
      !(isLocalBtwRunId?.(evt.runId) ?? false) &&
      matchesSelectedTuiSession(state, evt)
    ) {
      // Lifecycle start distinguishes another genuine live run from the
      // bounded orphan-delta pool while the current run owns the status bar.
      runCoordinator.noteSessionRun(evt.runId, { protectStream: true });
      // Mirror handleChatEvent: side-question (btw) runs never claim the active
      // slot, so a concurrent btw run cannot hijack the main activity indicator.
      if (isUntrackedRun && !state.activeChatRunId) {
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
        runCoordinator.noteSessionRun(evt.runId, { protectStream: true });
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
        runCoordinator.notePostFinalizingRun(evt.runId);
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
    if (!matchesSelectedTuiSession(state, evt)) {
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

  const reconcileHistoryAfterGap = () => {
    const { runIds, displayedRunIds } = collectTrackedSessionRunIds();
    if (runIds.size === 0) {
      runCoordinator.queueHistoryReload();
      return;
    }
    // A dropped final cannot distinguish a finished run from a still-streaming
    // one; authoritative history must either finalize it or restore it.
    runCoordinator.queueGapHistoryReload(runIds, displayedRunIds);
  };

  return {
    handleChatEvent,
    handleAgentEvent,
    handleBtwEvent,
    handleSessionsChangedEvent,
    handleSessionMessageEvent,
    pauseStreamingWatchdog,
    reconnectStreamingWatchdog,
    consumeCompletedRunForPendingSend,
    isRunObserved,
    reconcileHistoryAfterGap,
    flushPendingHistoryRefreshIfIdle,
    dispose,
  };
}
