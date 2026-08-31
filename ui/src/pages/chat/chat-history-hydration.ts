import { GatewayRequestError } from "../../api/gateway.ts";
import {
  isHiddenAssistantStreamText,
  isVisibleChatHistoryMessage,
  shouldHideAssistantChatMessage,
  visibleChatHistoryMessages,
} from "../../lib/chat/message-visibility.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { requestSharedHistory } from "./chat-history-request.ts";
import {
  type ChatHistoryResult,
  isHistoryCursor,
  resolveChatHistoryPagination,
  historySessionId,
  reconcileHistoryTail,
  commitCurrentChatHistorySnapshot,
  clearHistoryCursor,
} from "./chat-history-snapshot.ts";
import {
  chatHistoryRequests,
  beginHistoryRequest,
  ownsHistoryRequest,
  acceptsHistoryResult,
  resetChatHistoryProjection,
  setChatError,
} from "./chat-history-state.ts";
import {
  materializeVisibleAssistantStreamMessages,
  persistsChatCommentary,
  readRunProjections,
  applyHistoryRun,
} from "./chat-history-stream.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { reconcileChatRunStartup } from "./chat-run-startup.ts";
import type { ChatState } from "./chat-state-contract.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
  setChatSessionProjection,
} from "./history-merge.ts";
import {
  controlUiNowMs,
  recordControlUiPerformanceEvent,
  roundedControlUiDurationMs,
} from "./performance.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { rolloverChatStream } from "./stream-causal-boundary.ts";
import {
  currentLiveToolCallIds,
  hasVisibleStreamParts,
  historyReplacedVisibleStream,
  maybeResetToolStream,
  visibleCurrentAssistantStreamTail,
} from "./stream-reconciliation.ts";
import {
  pruneHistoryReplacedStreamSegments,
  prunePersistedToolStreamMessages,
} from "./stream-segment-pruning.ts";
import { reconcileAuthoritativeTerminalHistory } from "./terminal-message-identity.ts";
import { persistedCurrentToolStreamIds } from "./tool-stream-identity.ts";

function recordChatHistoryTiming(
  state: ChatState,
  phase: "start" | "applied" | "stream-reset" | "stale" | "error",
  startedAtMs: number,
  extra: Record<string, unknown> = {},
) {
  recordControlUiPerformanceEvent(
    // SAFETY: real chat panes carry optional performance fields; minimal hosts may omit them.
    state as ChatState & Parameters<typeof recordControlUiPerformanceEvent>[0],
    "control-ui.chat.history",
    {
      phase,
      durationMs: roundedControlUiDurationMs(controlUiNowMs() - startedAtMs),
      sessionKey: state.sessionKey,
      activeRunId: state.chatRunId,
      ...extra,
    },
    { console: false, maxBufferedEventsForType: 30 },
  );
}

export async function hydrateChatHistory(
  state: ChatState,
  client: NonNullable<ChatState["client"]>,
  connectionEpoch: number,
  sessionKey: string,
  requestAgentId: string | undefined,
  method: "chat.history" | "chat.startup",
  deltaCursor: string | undefined,
  inputRunIds: string[],
  requestKeyPrefix: string,
): Promise<ChatHistoryResult | undefined> {
  const ownership = beginHistoryRequest(state, client, connectionEpoch, sessionKey, requestAgentId);
  const startedAtMs = controlUiNowMs();
  const previousMessages = state.chatMessages;
  const previousRunProjections = readRunProjections(state, sessionKey, requestAgentId);
  const previousPagination = state.chatHistoryPagination;
  const previousSessionId = state.currentSessionId ?? null;
  const previousDisplayedLeafEntryId = state.chatDisplayedLeafEntryId;
  const previousRunId = state.chatRunId;
  recordChatHistoryTiming(state, "start", startedAtMs, {
    requestSessionKey: sessionKey,
    requestAgentId,
    method,
    previousRunId,
  });
  // Any pending input-history snapshot becomes invalid once we start reloading transcript state.
  state.resetChatInputHistoryNavigation?.();
  state.chatLoading = true;
  setChatError(state, null);
  try {
    const requestModeKey = deltaCursor === undefined ? "page" : `cursor:${deltaCursor}`;
    const requestKey = `${requestKeyPrefix}${requestModeKey}`;
    let response = await requestSharedHistory(
      client,
      requestKey,
      method,
      sessionKey,
      requestAgentId,
      state,
      () => acceptsHistoryResult(state, ownership),
      deltaCursor,
      state.sessions?.canonicalListRevision,
      inputRunIds,
    );
    if (!acceptsHistoryResult(state, ownership)) {
      recordChatHistoryTiming(state, "stale", startedAtMs, {
        requestSessionKey: sessionKey,
        requestAgentId,
        previousRunId,
        reason: "apply-version",
      });
      return undefined;
    }
    if (isHistoryCursor(response) && response.kind === "reset") {
      clearHistoryCursor(state, sessionKey, requestAgentId);
      const pageRequestKey = `${requestKeyPrefix}page`;
      response = await requestSharedHistory(
        client,
        pageRequestKey,
        method,
        sessionKey,
        requestAgentId,
        state,
        () => acceptsHistoryResult(state, ownership),
        undefined,
        state.sessions?.canonicalListRevision,
        inputRunIds,
      );
      if (!acceptsHistoryResult(state, ownership)) {
        recordChatHistoryTiming(state, "stale", startedAtMs, {
          requestSessionKey: sessionKey,
          requestAgentId,
          previousRunId,
          reason: "reset-fallback-version",
        });
        return undefined;
      }
    }
    if (isHistoryCursor(response) && response.kind === "delta") {
      const runProjectionsBeforeApply = readRunProjections(state, sessionKey, requestAgentId);
      const activeStreamBeforeApply = state.chatRunId ? state.chatStream : null;
      const runActive = isSessionRunActive(response.sessionInfo);
      for (const payload of response.messages) {
        applySessionMessagePayload(state, payload, runActive, { kind: "history-delta" });
      }
      const historyProjection = getChatSessionProjection(state, state.chatMessages);
      if (Object.hasOwn(response.sessionInfo, "activeLeafEntryId")) {
        state.chatDisplayedLeafEntryId = response.sessionInfo.activeLeafEntryId?.trim() || null;
      }
      state.currentSessionId = response.sessionInfo.sessionId?.trim() || previousSessionId;
      // An accepted delta advances the same transcript generation, not a branch replacement.
      // Carry ownership across its leaf advance; reseeding loses attributed pending sends and runs.
      setChatSessionProjection(state, {
        ...historyProjection,
        scope: { ...historyProjection.scope, ...readChatSessionProjectionScope(state) },
      });
      applyChatPendingInputs(state, response.pendingInputs, {
        consumptions:
          !previousSessionId || previousSessionId === state.currentSessionId
            ? response.inputConsumptions
            : undefined,
      });
      state.chatThinkingLevel = response.sessionInfo.thinkingLevel ?? null;
      state.chatQueueModeOverride = response.sessionInfo.queueMode;
      state.chatEffectiveQueueMode = response.sessionInfo.effectiveQueueMode;
      applyHistoryRun({
        state,
        run: response.inFlightRun,
        sessionInfo: response.sessionInfo,
        previousRunProjections,
        runProjectionsBeforeApply,
        currentRunProjections: historyProjection.runs,
        resetStream: !state.chatRunId || state.chatRunId === previousRunId,
        activeStreamBeforeReset: activeStreamBeforeApply,
      });
      commitCurrentChatHistorySnapshot(state, response.deltaCursor ?? null);
      recordChatHistoryTiming(state, "applied", startedAtMs, {
        requestSessionKey: sessionKey,
        requestAgentId,
        previousRunId,
        messageCount: response.messages.length,
        visibleMessageCount: response.messages.length,
        resetStream: false,
      });
      return {
        messages: state.chatMessages,
        deltaCursor: response.deltaCursor,
        pendingInputs: response.pendingInputs,
        inputConsumptions: response.inputConsumptions,
        sessionInfo: response.sessionInfo,
        ...(response.inFlightRun ? { inFlightRun: response.inFlightRun } : {}),
        ...(response.metadata ? { metadata: response.metadata } : {}),
        sourceCanonicalListRevision: response.sourceCanonicalListRevision,
      };
    }
    if (isHistoryCursor(response)) {
      throw new Error("chat history page request returned a cursor reset");
    }
    const res = response;
    // Fence concurrent run lifecycle before applying the response. A remount
    // may replace the map itself, so compare its canonical run entries.
    const runProjectionsBeforeApply = readRunProjections(state, sessionKey, requestAgentId);
    const messages = Array.isArray(res.messages) ? res.messages : [];
    const nextPagination = resolveChatHistoryPagination(res);
    const nextSessionId = historySessionId(res);
    const visibleMessages = visibleChatHistoryMessages(messages);
    const previousTerminalMessages = reconcileAuthoritativeTerminalHistory({
      host: state,
      previousMessages,
      sessionKey,
      visibleMessages,
    });
    const nextDisplayedLeafEntryId = Object.hasOwn(res.sessionInfo ?? {}, "activeLeafEntryId")
      ? res.sessionInfo?.activeLeafEntryId?.trim() || null
      : (previousDisplayedLeafEntryId ?? null);
    const retainsTranscriptIdentity =
      (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId) &&
      (previousDisplayedLeafEntryId === undefined ||
        previousDisplayedLeafEntryId === nextDisplayedLeafEntryId);
    const reconciledHistory = reconcileHistoryTail({
      nextMessages: visibleMessages,
      nextPagination,
      nextSessionId,
      previousMessages: retainsTranscriptIdentity ? previousTerminalMessages : [],
      previousPagination,
      previousSessionId,
    });
    const authoritativeMessages = reconciledHistory?.messages ?? visibleMessages;
    const scope = readChatSessionProjectionScope(state, {
      sessionKey,
      agentId: requestAgentId,
      sessionId: nextSessionId,
      ...(Object.hasOwn(res.sessionInfo ?? {}, "activeLeafEntryId")
        ? { activeLeafEntryId: nextDisplayedLeafEntryId }
        : {}),
    });
    // Only the pane-owned reducer proves which live and pending rows survive;
    // terminal-renderer cleanup must not reclassify them as history. A new
    // session or leaf starts empty.
    const historyProjection = reduceChatSessionProjection(
      state,
      {
        type: "snapshotLoaded",
        messages: authoritativeMessages,
        options: { shouldIncludeMessage: isVisibleChatHistoryMessage },
      },
      {
        scope,
        messages: retainsTranscriptIdentity ? state.chatMessages : [],
        runActive:
          res.sessionInfo &&
          (typeof res.sessionInfo.hasActiveRun === "boolean" ||
            res.sessionInfo.status !== undefined)
            ? isSessionRunActive(res.sessionInfo)
            : undefined,
      },
    );
    if (Object.hasOwn(res.sessionInfo ?? {}, "activeLeafEntryId")) {
      state.chatDisplayedLeafEntryId = nextDisplayedLeafEntryId;
    }
    state.chatHistoryPagination = reconciledHistory?.pagination ?? nextPagination;
    state.currentSessionId = nextSessionId;
    applyChatPendingInputs(state, res.pendingInputs, {
      consumptions:
        !previousSessionId || previousSessionId === nextSessionId
          ? res.inputConsumptions
          : undefined,
    });
    commitCurrentChatHistorySnapshot(state, res.deltaCursor ?? null);
    if (
      state.reconnectResumeSessionId &&
      state.reconnectResumeSessionId !== state.currentSessionId
    ) {
      state.reconnectResumeSessionId = null;
    }
    state.chatThinkingLevel = res.sessionInfo?.thinkingLevel ?? res.thinkingLevel ?? null;
    state.chatVerboseLevel = res.verboseLevel ?? null;
    state.chatQueueModeOverride = res.sessionInfo?.queueMode;
    state.chatEffectiveQueueMode = res.sessionInfo?.effectiveQueueMode;
    const activeStreamBeforeReset = state.chatRunId ? state.chatStream : null;
    const resetStream = !state.chatRunId || state.chatRunId === previousRunId;
    if (resetStream) {
      const streamReconciliation = {
        persistCommentary: state.chatRunId ? true : persistsChatCommentary(state),
        isHiddenAssistantMessage: shouldHideAssistantChatMessage,
        isHiddenStreamText: isHiddenAssistantStreamText,
      };
      const hasVisibleStream = hasVisibleStreamParts(state, streamReconciliation);
      const historyReplacedStream = historyReplacedVisibleStream(
        state.chatMessages,
        state,
        streamReconciliation,
      );
      pruneHistoryReplacedStreamSegments(state.chatMessages, state, streamReconciliation);
      const liveToolIds = currentLiveToolCallIds(state);
      if (state.chatRunId && (hasVisibleStream || liveToolIds.length > 0)) {
        reconcileChatRunStartup(state, { state: "activity", runId: state.chatRunId });
      }
      const persistedToolStreamIds = persistedCurrentToolStreamIds(state.chatMessages, state);
      const historyReplacedToolStream =
        liveToolIds.length > 0 && liveToolIds.every((id) => persistedToolStreamIds.has(id));
      const historyReplacedSomeToolStream = persistedToolStreamIds.size > 0;
      const liveToolStreamReplaced = liveToolIds.length === 0 || historyReplacedToolStream;
      if (!hasVisibleStream || historyReplacedStream) {
        if (state.chatRunId && historyReplacedStream) {
          rolloverChatStream(state, { runId: state.chatRunId, persisted: true });
        }
        if (liveToolStreamReplaced) {
          maybeResetToolStream(state, { preserveStreamSegments: state.chatRunId !== null });
        } else {
          prunePersistedToolStreamMessages(state, persistedToolStreamIds);
        }
        if (!state.chatRunId) {
          state.chatStream = null;
          state.chatStreamStartedAt = null;
        }
        recordChatHistoryTiming(state, "stream-reset", startedAtMs, {
          requestSessionKey: sessionKey,
          requestAgentId,
          previousRunId,
          messageCount: messages.length,
          visibleMessageCount: visibleMessages.length,
        });
      } else if (!state.chatRunId) {
        state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state);
        maybeResetToolStream(state);
        state.chatStream = null;
        state.chatStreamStartedAt = null;
      } else if (historyReplacedSomeToolStream) {
        state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state, {
          includeCurrent: false,
          requirePersistedTool: !historyReplacedToolStream,
          persistCommentary: true,
        });
        if (!visibleCurrentAssistantStreamTail(state, streamReconciliation.isHiddenStreamText)) {
          state.chatStreamStartedAt = null;
        }
        pruneHistoryReplacedStreamSegments(state.chatMessages, state, streamReconciliation);
        if (historyReplacedToolStream) {
          maybeResetToolStream(state, { preserveStreamSegments: true });
        } else {
          prunePersistedToolStreamMessages(state, persistedToolStreamIds);
        }
      }
    }

    applyHistoryRun({
      state,
      run: res.inFlightRun,
      sessionInfo: res.sessionInfo,
      previousRunProjections,
      runProjectionsBeforeApply,
      currentRunProjections: historyProjection.runs,
      resetStream,
      activeStreamBeforeReset,
    });

    recordChatHistoryTiming(state, "applied", startedAtMs, {
      requestSessionKey: sessionKey,
      requestAgentId,
      previousRunId,
      messageCount: messages.length,
      visibleMessageCount: visibleMessages.length,
      resetStream,
    });
    return res;
  } catch (err) {
    if (!acceptsHistoryResult(state, ownership)) {
      recordChatHistoryTiming(state, "stale", startedAtMs, {
        requestSessionKey: sessionKey,
        requestAgentId,
        previousRunId,
        reason: "error-version",
      });
      return undefined;
    }
    recordChatHistoryTiming(state, "error", startedAtMs, {
      requestSessionKey: sessionKey,
      requestAgentId,
      previousRunId,
    });
    const missingReadScope = isMissingOperatorReadScopeError(err);
    if (missingReadScope) {
      resetChatHistoryProjection(state, requestAgentId);
      state.chatThinkingLevel = null;
      state.chatVerboseLevel = null;
    }
    chatHistoryRequests(state).historyLoad = {
      phase: "failed",
      sessionKey,
      requestAgentId,
      startup: method === "chat.startup",
      message: missingReadScope
        ? formatMissingOperatorReadScopeMessage("existing chat history")
        : formatUiError(err),
      retryable: err instanceof GatewayRequestError && err.retryable,
    };
    state.requestUpdate?.();
  } finally {
    if (ownsHistoryRequest(state, ownership)) {
      state.chatLoading = false;
    }
  }
  return undefined;
}
