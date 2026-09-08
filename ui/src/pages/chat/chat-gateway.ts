import {
  hasSessionProjectionAcceptedFinal,
  isSessionProjectionErrorMessage,
  reduceSessionProjectionRunEvent,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import { accumulatedStreamText } from "../../lib/chat/chat-types.ts";
import { isAssistantHeartbeatAckForDisplay } from "../../lib/chat/heartbeat-display.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import {
  isHiddenAssistantStreamText,
  isSilentReplyStream,
  shouldHideAssistantChatMessage,
} from "../../lib/chat/message-visibility.ts";
// Control UI page module reconciles Chat Gateway events into Chat state.
import { isUiGlobalSessionKey, resolveUiDefaultAgentId } from "../../lib/sessions/session-key.ts";
import { chatScopedEventSessionMatches } from "./chat-history-state.ts";
import { materializeVisibleAssistantStreamMessages } from "./chat-history-stream.ts";
import type { ChatEventPayload } from "./chat-history.ts";
import { reconcileChatRunStartup } from "./chat-run-startup.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { transcriptRunId } from "./chat-thread-run-identity.ts";
import {
  getChatSessionProjection,
  publishChatSessionProjectionMessages,
  readChatSessionProjectionScope,
  setChatRunOwner,
  publishChatSessionProjection,
} from "./history-merge.ts";
import {
  adoptStartedChatRun,
  reconcileChatRunLifecycle,
  setChatRunError,
} from "./run-lifecycle.ts";
import { appendChatMessageToCache } from "./session-message-cache.ts";
import {
  latestStreamBoundaryRunId,
  reconcileTerminalStreamBoundary,
} from "./stream-causal-boundary.ts";
import {
  appendTerminalAssistantMessage,
  clearToolStreamSegments,
  terminalMessageReplacesVisibleStream,
} from "./stream-reconciliation.ts";
import {
  discardStreamSegmentIndexes,
  reconcilePersistedAssistantStream,
} from "./stream-segment-pruning.ts";
import {
  authoritativeHistoryAppliedForRun,
  normalizeFinalAssistantMessage,
  rememberLiveTerminalRun,
} from "./terminal-message-identity.ts";

export type { ChatEventPayload } from "./chat-history.ts";

function chatEventSessionMatches(state: ChatState, payload: ChatEventPayload): boolean {
  return chatScopedEventSessionMatches(state, payload.sessionKey, payload.agentId);
}

function isPendingLocalChatRun(state: ChatState, runId: string): boolean {
  return state.chatQueue.some((item) => item.sendRunId === runId && item.sendState === "sending");
}

function resolveDeltaChatStreamText(
  currentStream: string | null,
  payload: ChatEventPayload,
): string | null {
  const snapshot = payload.message == null ? null : extractText(payload.message);
  if (typeof payload.deltaText === "string") {
    if (payload.replace === true) {
      return payload.deltaText;
    }
    if (currentStream === null) {
      return typeof snapshot === "string" ? snapshot : payload.deltaText;
    }
    if (typeof snapshot === "string") {
      const prefixLength = snapshot.length - payload.deltaText.length;
      if (
        prefixLength !== currentStream.length ||
        snapshot.slice(0, prefixLength) !== currentStream
      ) {
        return snapshot;
      }
    }
    return `${currentStream}${payload.deltaText}`;
  }
  return typeof snapshot === "string" ? snapshot : null;
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  const candidate = asRecord(message);
  return candidate?.role === "assistant" && Array.isArray(candidate.content) ? candidate : null;
}

function formatGatewayErrorDetail(payload: ChatEventPayload): string | null {
  const detail = payload.errorDetail;
  if (!detail || detail.providerRuntimeFailureKind !== "auth_refresh") {
    return null;
  }
  const lines = [
    detail.provider ? `Provider: ${detail.provider}` : undefined,
    detail.httpStatus ? `HTTP status: ${detail.httpStatus}` : undefined,
    detail.failoverReason ? `Reason: ${detail.failoverReason}` : undefined,
    detail.providerErrorType ? `Type: ${detail.providerErrorType}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join("\n") : null;
}

function resolveGatewayErrorText(
  payload: ChatEventPayload,
  message: Record<string, unknown> | null,
): string {
  const errorText = payload.errorMessage?.trim();
  if (errorText) {
    const summary =
      errorText.startsWith("⚠️") || errorText.startsWith("Error:")
        ? errorText
        : `Error: ${errorText}`;
    const detail = formatGatewayErrorDetail(payload);
    return detail ? `${summary}\n\n${detail}` : summary;
  }
  const messageText = message ? extractText(message)?.trim() : null;
  return messageText || "chat error";
}

function appendCachedChatMessage(
  state: ChatState,
  sessionKey: string,
  message: unknown,
  eventClaim: object,
  agentId?: string,
) {
  if (!state.chatMessagesBySession) {
    return;
  }
  appendChatMessageToCache(
    state.chatMessagesBySession,
    state,
    { sessionKey, agentId },
    message,
    eventClaim,
  );
}

function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  const normalizedFinalMessage =
    payload.state === "final" ? normalizeFinalAssistantMessage(payload.message) : null;
  const hadActiveRunBeforeEvent = state.chatRunId !== null;
  const sessionMatches = chatEventSessionMatches(state, payload);
  const activeRunMatches =
    state.chatRunId !== null &&
    typeof payload.runId === "string" &&
    payload.runId === state.chatRunId;
  const authoritativeTerminalMatches = Boolean(
    payload.runId && authoritativeHistoryAppliedForRun(state, payload.runId) && sessionMatches,
  );
  if (!sessionMatches) {
    if (payload.state === "final") {
      const finalMessage = normalizedFinalMessage;
      if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
        const cacheAgentId = isUiGlobalSessionKey(payload.sessionKey)
          ? (payload.agentId ?? resolveUiDefaultAgentId(state))
          : payload.agentId;
        appendCachedChatMessage(state, payload.sessionKey, finalMessage, payload, cacheAgentId);
      }
    }
    return null;
  }
  const scope = readChatSessionProjectionScope(state);
  const publishVisibleTerminal = (
    message: Record<string, unknown>,
    visibleMessages: unknown[],
    runId: string | null | undefined,
    afterSequence?: number | null,
  ): void => {
    const event = payload as ChatEventPayload & { messageId?: unknown; messageSeq?: unknown };
    publishChatSessionProjectionMessages(state, visibleMessages, {
      scope,
      event: {
        type: "messagePersisted",
        message,
        envelope: {
          afterSequence,
          ...(runId ? { runId } : {}),
          ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
          ...(event.messageSeq === undefined ? {} : { messageSeq: event.messageSeq }),
        },
      },
    });
  };
  const projectedRun =
    payload.runId && payload.state !== "status"
      ? reduceSessionProjectionRunEvent(
          getChatSessionProjection(state, scope),
          normalizedFinalMessage ? { ...payload, message: normalizedFinalMessage } : payload,
          scope,
        )
      : null;
  if (projectedRun) {
    publishChatSessionProjection(state, projectedRun.projection);
  }
  const terminalRunId = payload.runId ?? state.chatRunId;
  const reconcileOwnedTerminalRun = () => {
    const terminalStatus = projectedRun?.currentRun?.status;
    if (
      !payload.runId ||
      payload.runId !== state.chatRunId ||
      !terminalStatus ||
      terminalStatus === "streaming"
    ) {
      return;
    }
    clearToolStreamSegments(state);
    const sessionKeys = sessionMatches ? [state.sessionKey, payload.sessionKey] : [];
    if (terminalStatus === "yielded") {
      reconcileChatRunLifecycle(state, {
        yielded: true,
        runId: terminalRunId,
        sessionKey: state.sessionKey,
        sessionKeys,
        clearLocalRun: true,
        clearChatStream: true,
      });
      return;
    }
    const sessionStatus =
      terminalStatus === "completed"
        ? ("done" as const)
        : terminalStatus === "aborted"
          ? ("killed" as const)
          : terminalStatus === "timeout"
            ? ("timeout" as const)
            : ("failed" as const);
    reconcileChatRunLifecycle(state, {
      outcome: terminalStatus === "completed" ? "done" : "interrupted",
      sessionStatus,
      errorMessage: payload.errorMessage?.trim()
        ? resolveGatewayErrorText(payload, null)
        : undefined,
      runId: terminalRunId,
      sessionKey: state.sessionKey,
      sessionKeys,
      clearLocalRun: true,
      clearChatStream: true,
      armLocalTerminalReconcile: hadActiveRunBeforeEvent && activeRunMatches,
    });
  };
  const previousTerminalRun = projectedRun?.previousRun;
  if (
    previousTerminalRun &&
    previousTerminalRun.status !== "streaming" &&
    projectedRun.currentRun?.status !== "streaming"
  ) {
    if (payload.state === "delta") {
      return null;
    }
    if (payload.state === "error" || payload.state === "aborted") {
      const pendingRunId = state.chatQueue.find(
        (item) => item.sendState === "sending" && item.sendRunId,
      )?.sendRunId;
      const diagnosticOwnerRunId =
        state.chatRunId ?? pendingRunId ?? state.lastLocalTerminalReconcile?.runId;
      if (
        diagnosticOwnerRunId === payload.runId &&
        payload.errorMessage?.trim() &&
        projectedRun.currentRun?.errorMessage !== previousTerminalRun.errorMessage
      ) {
        // Late diagnostics belong to the active, pending, or latest locally terminal run;
        // publishing them over a newer response falsely marks the new run failed.
        setChatRunError(
          state,
          resolveGatewayErrorText(payload, null),
          payload.runId,
          payload.errorDetail?.providerRuntimeFailureKind === "auth_refresh"
            ? "auth_refresh"
            : undefined,
        );
      }
      if (payload.state === "error") {
        reconcileOwnedTerminalRun();
        return "error";
      }
    }
    const incomingFinal = normalizedFinalMessage;
    if (
      payload.state === "aborted" ||
      (payload.state === "final" &&
        (!incomingFinal ||
          shouldHideAssistantChatMessage(incomingFinal) ||
          hasSessionProjectionAcceptedFinal(previousTerminalRun, incomingFinal)))
    ) {
      reconcileOwnedTerminalRun();
      return payload.state;
    }
  }
  if (
    !state.chatRunId &&
    (!previousTerminalRun ||
      previousTerminalRun.status === "streaming" ||
      projectedRun?.currentRun?.status === "streaming") &&
    sessionMatches &&
    typeof payload.runId === "string" &&
    (payload.state !== "status" || isPendingLocalChatRun(state, payload.runId))
  ) {
    if (payload.state === "status") {
      adoptStartedChatRun(state, payload.runId, Date.now());
    } else {
      state.chatRunId = payload.runId;
      setChatRunOwner(state, payload.runId);
      state.chatRunError = null;
      state.chatStreamStartedAt ??= Date.now();
    }
  }

  // Terminal events for the active client run carry runId; missing-runId events are unowned.
  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      const finalMessage = normalizedFinalMessage;
      if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
        publishVisibleTerminal(finalMessage, [...state.chatMessages, finalMessage], payload.runId);
        return null;
      }
      return "final";
    }
    return null;
  }

  const terminalAfterBoundaryRunId = latestStreamBoundaryRunId(state);
  const materializeVisibleStream = (
    materializeOpts: Parameters<typeof materializeVisibleAssistantStreamMessages>[2] = {},
  ) =>
    materializeVisibleAssistantStreamMessages(state.chatMessages, state, {
      ...materializeOpts,
    });
  if (payload.state === "status") {
    if (!payload.runId || payload.runId !== state.chatRunId) {
      return null;
    }
    const status = payload.retry
      ? typeof payload.seq === "number" && {
          phase: "retrying" as const,
          seq: payload.seq,
          message: t("chat.startupStatus.retrying", {
            attempt: String(payload.retry.attempt),
            maxAttempts: String(payload.retry.maxAttempts),
          }),
        }
      : payload.phase && {
          phase: payload.phase,
          ...(payload.seq === undefined ? {} : { seq: payload.seq }),
        };
    if (status) {
      reconcileChatRunStartup(state, {
        state: "status",
        runId: payload.runId,
        ...status,
      });
    }
    return payload.state;
  }

  if (payload.state === "delta") {
    if (payload.runId && payload.runId === state.chatRunId) {
      reconcileChatRunStartup(state, { state: "activity", runId: payload.runId });
    }
    const cumulativeText =
      state.chatStream ?? accumulatedStreamText(state.chatStreamSegments ?? []);
    const next = resolveDeltaChatStreamText(cumulativeText, payload);
    if (
      typeof next === "string" &&
      !isSilentReplyStream(next) &&
      !isAssistantHeartbeatAckForDisplay(payload.message)
    ) {
      state.chatStream = next;
      reconcilePersistedAssistantStream(state);
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizedFinalMessage;
    if (authoritativeTerminalMatches) {
      // History already owns this run's terminal message. Discard the live
      // projection; terminal cleanup below clears its remaining stream.
    } else {
      const boundary = finalMessage
        ? reconcileTerminalStreamBoundary(finalMessage, state)
        : { kind: "none" as const };
      if (boundary.kind === "split") {
        // The tail follows a known transcript boundary; it cannot adopt the saved prefix.
        discardStreamSegmentIndexes(state, boundary.replacedSegmentIndexes);
        let visibleMessages = materializeVisibleStream({ includeCurrent: false });
        if (boundary.tailMessage && !shouldHideAssistantChatMessage(boundary.tailMessage)) {
          const liveTail = rememberLiveTerminalRun(
            boundary.tailMessage,
            terminalRunId,
            boundary.afterBoundaryRunId,
          );
          // A retired commentary item keeps its own identity even when the answer
          // repeats its text. The sequence fence reconciles only the later answer.
          visibleMessages = appendTerminalAssistantMessage(visibleMessages, liveTail, {
            preserveKeyedCommentary: boundary.preserveKeyedCommentary,
          });
          publishVisibleTerminal(
            boundary.tailMessage,
            visibleMessages,
            terminalRunId,
            boundary.afterSequence,
          );
        } else {
          publishChatSessionProjectionMessages(state, visibleMessages, { scope });
        }
      } else if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
        const visibleMessages = materializeVisibleStream();
        const liveFinal = rememberLiveTerminalRun(
          finalMessage,
          terminalRunId,
          terminalAfterBoundaryRunId,
        );
        publishVisibleTerminal(
          finalMessage,
          appendTerminalAssistantMessage(visibleMessages, liveFinal),
          terminalRunId,
        );
      } else {
        publishChatSessionProjectionMessages(state, materializeVisibleStream(), { scope });
      }
    }
    reconcileOwnedTerminalRun();
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage && !shouldHideAssistantChatMessage(normalizedMessage)) {
      const visibleMessages = materializeVisibleStream({
        replacementMessages: [normalizedMessage],
        includeCurrent: false,
      });
      const liveAborted = rememberLiveTerminalRun(
        normalizedMessage,
        terminalRunId,
        terminalAfterBoundaryRunId,
        "aborted",
      );
      publishVisibleTerminal(
        normalizedMessage,
        appendTerminalAssistantMessage(visibleMessages, liveAborted),
        terminalRunId,
      );
    } else {
      publishChatSessionProjectionMessages(state, materializeVisibleStream(), { scope });
    }
    if (payload.errorMessage?.trim()) {
      setChatRunError(
        state,
        resolveGatewayErrorText(payload, null),
        payload.runId,
        payload.errorDetail?.providerRuntimeFailureKind === "auth_refresh"
          ? "auth_refresh"
          : undefined,
      );
    }
    reconcileOwnedTerminalRun();
  } else if (payload.state === "error") {
    const payloadMessage = normalizeFinalAssistantMessage(payload.message);
    const visiblePayloadMessage =
      payloadMessage && !shouldHideAssistantChatMessage(payloadMessage) ? payloadMessage : null;
    const projectedErrorMessage = Boolean(
      visiblePayloadMessage &&
      isSessionProjectionErrorMessage(visiblePayloadMessage, payload.errorMessage),
    );
    if (hadActiveRunBeforeEvent) {
      if (visiblePayloadMessage && !projectedErrorMessage) {
        const replacesVisibleStream = terminalMessageReplacesVisibleStream(
          visiblePayloadMessage,
          state,
          {
            isHiddenStreamText: isHiddenAssistantStreamText,
            persistCommentary: state.settings?.chatPersistCommentary !== false,
          },
        );
        const visibleMessages = materializeVisibleStream({
          includeCurrent: !replacesVisibleStream,
        });
        const liveError = rememberLiveTerminalRun(
          visiblePayloadMessage,
          terminalRunId,
          terminalAfterBoundaryRunId,
          projectedRun?.currentRun?.status === "timeout" ? "timeout" : "error",
        );
        publishVisibleTerminal(
          visiblePayloadMessage,
          replacesVisibleStream
            ? appendTerminalAssistantMessage(visibleMessages, liveError)
            : [...visibleMessages, liveError],
          terminalRunId,
        );
      } else {
        publishChatSessionProjectionMessages(
          state,
          materializeVisibleStream({ includeCurrent: true }),
          { scope },
        );
        const materialized = state.chatMessages.findLast(
          (message) => transcriptRunId(message) === terminalRunId,
        );
        rememberLiveTerminalRun(
          materialized,
          terminalRunId,
          terminalAfterBoundaryRunId,
          projectedRun?.currentRun?.status === "timeout" ? "timeout" : "error",
        );
      }
    }
    // The shared Gateway projection owns timeout classification; preserve it
    // when publishing selected-session and sidebar terminal status.
    reconcileOwnedTerminalRun();
    setChatRunError(
      state,
      resolveGatewayErrorText(payload, projectedErrorMessage ? visiblePayloadMessage : null),
      payload.runId,
      payload.errorDetail?.providerRuntimeFailureKind === "auth_refresh"
        ? "auth_refresh"
        : undefined,
    );
  }
  if (payload.state !== "delta") {
    // Terminal materialization transfers ownership into chatMessages; retaining
    // the stream segments would render the same run output a second time.
    clearToolStreamSegments(state);
  }
  return payload.state;
}

export function handleChatGatewayEvent(state: ChatState, payload?: ChatEventPayload) {
  return handleChatEvent(state, payload);
}
