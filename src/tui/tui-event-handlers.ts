// Handles TUI keyboard, paste, backend, and command events.
import {
  hasSessionProjectionAcceptedFinal,
  reduceSessionProjectionRunEvent,
  type SessionProjectionRunStatus,
} from "../../packages/gateway-client/src/session-projection.js";
import {
  formatPrimitiveString,
  extractTextFromMessage,
  extractTuiAbortedText,
  formatTuiAbortDiagnostic,
  isCommandMarkedMessage,
} from "./tui-formatters.js";
import { createTuiRunLifecycle } from "./tui-run-lifecycle.js";
import { matchesSelectedTuiSession, readTuiSessionUserMessage } from "./tui-session-events.js";
import {
  getTuiSessionProjection,
  hasDisplayableTuiSessionFinal,
  isIdentityOnlyTuiSessionInvalidation,
  projectTuiSessionMessage,
  projectTuiSessionFinal,
  readTuiSessionProjectionScope,
  reduceTuiSessionProjection,
} from "./tui-session-projection.js";
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
  addLiveUser: (
    text: string,
    options: { messageId: string; runId?: string; sendId?: string },
  ) => void;
  startTool: (toolCallId: string, toolName: string, args: unknown, runId?: string) => void;
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

type EventHandlerTui = { requestRender: (force?: boolean) => void };

type EventHandlerBtwPresenter = {
  showResult: (params: { question: string; text: string; isError?: boolean }) => void;
  clear: () => void;
};

function isFailedTuiRunStatus(status: SessionProjectionRunStatus | undefined): boolean {
  return status === "aborted" || status === "error" || status === "timeout";
}

type EventHandlerContext = {
  chatLog: EventHandlerChatLog;
  btw: EventHandlerBtwPresenter;
  tui: EventHandlerTui;
  state: TuiStateAccess;
  setActivityStatus: (text: string) => void;
  refreshSessionInfo?: () => Promise<void>;
  loadHistory: () => Promise<TuiHistoryLoadResult>;
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

  const handleChatEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as ChatEvent;
    syncSessionKey();
    if (!matchesSelectedTuiSession(state, evt)) {
      return;
    }
    if (runCoordinator.isHistoryTerminalDiagnosticRun(evt.runId)) {
      return;
    }
    const isSequencedGatewayEvent = Number.isSafeInteger(evt.seq) && (evt.seq ?? -1) >= 0;
    const isOwnedLocalPendingRun =
      localMode && state.pendingSubmit?.runId === evt.runId && isLocalRunId?.(evt.runId) === true;
    if (
      runCoordinator.isRetiredOrphanRun(evt.runId) &&
      !isSequencedGatewayEvent &&
      !isOwnedLocalPendingRun &&
      evt.runId !== getPendingSubmitAcceptedRunId(state)
    ) {
      return;
    }
    if (runCoordinator.isHistoryReloadingRun(evt.runId)) {
      runCoordinator.deferHistoryRunEvent(evt);
      return;
    }
    const reducedRun = reduceSessionProjectionRunEvent(
      getTuiSessionProjection(state),
      evt,
      readTuiSessionProjectionScope(state),
    );
    if (!reducedRun) {
      return;
    }
    const previousProjectedRun = reducedRun.previousRun;
    state.sessionProjection = reducedRun.projection;
    if (evt.state === "final" && isFailedTuiRunStatus(previousProjectedRun?.status)) {
      const hasRecoverableFinalText =
        Boolean(extractTuiAbortedText(evt.message, state.showThinking).trim()) ||
        streamAssembler.hasDisplayText(evt.runId);
      if (!hasRecoverableFinalText) {
        // The shared projection keeps failure precedence while allowing a real
        // recovered reply. Attachment fallback alone cannot turn failure into completion.
        clearStaleStreamingIfNoTrackedRunRemains();
        return;
      }
    }
    if (evt.state === "aborted" && previousProjectedRun?.status === "aborted") {
      clearStaleStreamingIfNoTrackedRunRemains();
      return;
    }
    if (finalizedRuns.has(evt.runId)) {
      if (evt.state === "delta") {
        return;
      }
      if (evt.state === "error" && finalizedRunsWithDisplay.has(evt.runId)) {
        const lateError = evt.errorMessage?.trim();
        if (
          lateError &&
          !runCoordinator.liveTerminalErrorMessages.has(evt.runId) &&
          state.sessionProjection.runs[evt.runId]?.errorMessage === lateError
        ) {
          // A completed reply remains authoritative; a later provider failure
          // is one diagnostic and must not clear a newer run or replay the reply.
          renderTerminalRunError({ runId: evt.runId, errorMessage: lateError });
          tui.requestRender(true);
          return;
        }
        clearStaleStreamingIfNoTrackedRunRemains();
        return;
      }
      if (evt.state === "final") {
        const hasLateDisplayableFinal =
          hasDisplayableTuiSessionFinal(evt, state.showThinking) &&
          (!finalizedRunsWithDisplay.has(evt.runId) ||
            !hasSessionProjectionAcceptedFinal(previousProjectedRun, evt.message));
        if (!hasLateDisplayableFinal) {
          clearStaleStreamingIfNoTrackedRunRemains();
          return;
        }
      }
    }
    // Gateway events are sequenced; early embedded events are trustworthy only
    // when their exact provisional run belongs to the selected local viewport.
    acknowledgeChatRun(evt.runId, {
      protectStream: isSequencedGatewayEvent || isOwnedLocalPendingRun,
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
      if (isCommandMarkedMessage(evt.message)) {
        maybeRefreshHistoryForRun(evt.runId, { wasPendingChatRun: isPendingChatRun });
        const text = extractTextFromMessage(evt.message);
        if (text) {
          chatLog.addSystem(text);
        }
        finalizeRun({ runId: evt.runId, wasActiveRun, status: "idle", displayedFinal: true });
        tui.requestRender(true);
        return;
      }
      const terminalStopReason = state.sessionProjection.runs[evt.runId]?.stopReason;

      const hasStreamedText = streamAssembler.hasDisplayText(evt.runId);
      const finalText = streamAssembler.finalize(
        evt.runId,
        evt.message,
        state.showThinking,
        evt.errorMessage,
      );
      const suppressEmptyExternalPlaceholder =
        finalText === "(no output)" && !isLocalRunId?.(evt.runId);
      if (!suppressEmptyExternalPlaceholder) {
        projectTuiSessionFinal(state, evt, finalText, hasStreamedText);
      }
      // Skip history reload for displayable output: loadHistory() rebuilds from
      // server data that may not contain the final yet, making it vanish (#87922).
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
        status: terminalStopReason === "error" ? "error" : "idle",
        displayedFinal: !suppressEmptyExternalPlaceholder,
      });
    }
    if (evt.state === "aborted") {
      forgetLocalBtwRunId?.(evt.runId);
      const wasActiveRun = state.activeChatRunId === evt.runId;
      // Determine content from the message and stream, not the user-visible
      // fallbacks: attachment-only aborts remain cancellation diagnostics.
      const hasDisplayableAbortedText =
        Boolean(extractTuiAbortedText(evt.message, state.showThinking).trim()) ||
        streamAssembler.hasDisplayText(evt.runId);
      // Abort envelopes carry the complete buffered reply, including text
      // suppressed by Gateway delta throttling; finalize it before run cleanup.
      const abortedText = streamAssembler.finalize(evt.runId, evt.message, state.showThinking);
      if (hasDisplayableAbortedText) {
        chatLog.finalizeAssistant(abortedText, evt.runId);
      }
      const diagnostic = formatTuiAbortDiagnostic(evt.errorMessage);
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

  const handleSessionsChangedEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as SessionChangedEvent;
    syncSessionKey();
    if (!matchesSelectedTuiSession(state, evt, { requireAliasOwnership: true })) {
      return;
    }

    if (evt.phase === "message") {
      const matchesCurrentSessionId =
        typeof evt.sessionId !== "string" ||
        !state.currentSessionId ||
        evt.sessionId === state.currentSessionId;
      if (!matchesCurrentSessionId || !isIdentityOnlyTuiSessionInvalidation(evt)) {
        return;
      }
      // Legacy atomic batches expose no replayable message identity. Refresh
      // their authoritative history without resetting the current run or stream.
      void runCoordinator.queueHistoryReload();
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
          void runCoordinator.queueHistoryReload(
            [persistedRunId],
            [persistedRunId],
            displayedRunIds,
          );
        } else {
          void refreshSessionInfo?.();
        }
      }
      flushPendingHistoryRefreshIfIdle();
      return;
    }
    if (evt.reason !== "new" && evt.reason !== "reset") {
      return clearStaleStreamingIfNoTrackedRunRemains(evt);
    }

    const nextSessionId = typeof evt.sessionId === "string" ? evt.sessionId : null;
    const replacesKnownSession =
      state.currentSessionId !== null &&
      nextSessionId !== null &&
      state.currentSessionId !== nextSessionId;
    if (evt.reason === "new" && !replacesKnownSession) {
      const { runIds, displayedRunIds } = runCoordinator.collectTrackedSessionRunIds();
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
        void runCoordinator.queueHistoryReload(persistedRunIds, persistedRunIds, displayedRunIds);
        tui.requestRender();
        return;
      }
    }

    const { runIds, finalizedRunIds, displayedRunIds } =
      runCoordinator.collectTrackedSessionRunIds();
    state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
    // Reduce the old epoch before adopting its replacement ID; otherwise the
    // canonical reducer correctly rejects the reset as a foreign session.
    reduceTuiSessionProjection(state, {
      type: "sessionReset",
      scope: readTuiSessionProjectionScope(state),
    });
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
    getTuiSessionProjection(state);
    const selection = { sessionKey: state.currentSessionKey, agentId: state.currentAgentId };
    const generation = state.sessionGeneration;
    const historyReload = runCoordinator.queueHistoryReload(
      runIds.size > 0 ? runIds : undefined,
      finalizedRunIds,
      displayedRunIds,
    );
    // The reset event can retire its own RPC acknowledgement. Its authoritative
    // receipt belongs after the last queued history rebuild, which clears chat.
    void historyReload.then((current) => {
      if (
        current &&
        evt.reason === "reset" &&
        generation === state.sessionGeneration &&
        matchesSelectedTuiSession(state, selection) &&
        selection.agentId === state.currentAgentId
      ) {
        chatLog.addSystem(`session ${state.currentSessionKey} reset`);
        tui.requestRender();
      }
    });
    tui.requestRender();
  };

  const handleSessionMessageEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as SessionMessageEvent;
    syncSessionKey();
    const currentUpdatedAt = state.sessionInfo.updatedAt;
    const priorSession =
      evt.sessionId && state.currentSessionId && evt.sessionId !== state.currentSessionId;
    const isOlderSnapshot =
      typeof evt.updatedAt === "number" && evt.updatedAt < (currentUpdatedAt ?? evt.updatedAt);
    if (
      !matchesSelectedTuiSession(state, evt, { requireAliasOwnership: true }) ||
      (priorSession &&
        (typeof evt.updatedAt !== "number" ||
          (typeof currentUpdatedAt === "number" && evt.updatedAt <= currentUpdatedAt)))
    ) {
      return;
    }

    const unboundDisplayedRunIds = [...finalizedRunsWithDisplay.keys()].filter(
      (runId) => !persistedTerminalRunIds.has(runId),
    );
    const authoritativeRunId = projectTuiSessionMessage(state, evt, unboundDisplayedRunIds);
    if (authoritativeRunId) {
      runCoordinator.notePersistedRun(authoritativeRunId);
    }
    const liveUserMessage = readTuiSessionUserMessage(evt);
    if (liveUserMessage) {
      chatLog.addLiveUser(liveUserMessage.text, liveUserMessage);
      tui.requestRender();
    }

    if (!isOlderSnapshot) {
      if (typeof evt.sessionId === "string") {
        state.currentSessionId = evt.sessionId;
        getTuiSessionProjection(state);
      }
      if (typeof evt.updatedAt === "number" || evt.updatedAt === null) {
        state.sessionInfo.updatedAt = evt.updatedAt;
      }
    }

    if (runCoordinator.routeSessionMessageRefresh(Boolean(liveUserMessage || authoritativeRunId))) {
      void refreshSessionInfo?.();
    }
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
      formatPrimitiveString(evt.data?.phase, "") === "start" &&
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
      const phase = formatPrimitiveString(data.phase, "");
      const toolCallId = formatPrimitiveString(data.toolCallId, "");
      const toolName = formatPrimitiveString(data.name, "tool");
      if (!toolCallId) {
        return;
      }
      if (phase === "start") {
        chatLog.startTool(toolCallId, toolName, data.args, evt.runId);
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
      let forceRender = phase === "end";
      if (phase === "end") {
        postFinalizingRuns.delete(evt.runId);
        if (!canUpdateActivityStatus) {
          return;
        }
        if (!localMode || !isLocalRunId?.(evt.runId) || finalizedRuns.has(evt.runId)) {
          setActivityStatus("idle"); // Local chat.final proves post-turn maintenance finished.
        }
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
        }
        setActivityStatus("error");
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
    if (
      evt.kind !== "btw" ||
      !matchesSelectedTuiSession(state, evt) ||
      (localMode && (!evt.runId || !isLocalBtwRunId?.(evt.runId)))
    ) {
      return;
    }
    const [question, text] = [evt.question.trim(), evt.text.trim()];
    if (!question || !text) {
      return;
    }
    btw.showResult({ question, text, isError: evt.isError });
    tui.requestRender();
  };

  const reconcileHistoryAfterGap = () => {
    reduceTuiSessionProjection(state, {
      type: "transportGap",
      scope: readTuiSessionProjectionScope(state),
    });
    const { runIds, displayedRunIds } = runCoordinator.collectTrackedSessionRunIds();
    if (runIds.size === 0) {
      void runCoordinator.queueHistoryReload();
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
    consumeCompletedRunForPendingSend: (runId: string) => completedRuns.delete(runId),
    // Events can register before sendChat resolves; do not re-arm their draft.
    isRunObserved: (runId: string) => sessionRuns.has(runId),
    captureHistoryRunMembership: () => runCoordinator.captureHistoryRunMembership(),
    reconcileHistoryAfterGap,
    flushPendingHistoryRefreshIfIdle,
    dispose,
  };
}
