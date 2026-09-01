import {
  hasSessionProjectionAcceptedFinal,
  reduceSessionProjectionRunEvent,
} from "@openclaw/gateway-client/browser";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
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
  rememberLiveTerminalRun,
} from "./terminal-message-identity.ts";

export type { ChatEventPayload } from "./chat-history.ts";

type AssistantMessageNormalizationOptions = {
  roleRequirement: "required" | "optional";
  roleCaseSensitive?: boolean;
  requireContentArray?: boolean;
  allowTextField?: boolean;
};

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

function normalizeAssistantMessage(
  message: unknown,
  options: AssistantMessageNormalizationOptions,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  const roleValue = candidate.role;
  if (typeof roleValue === "string") {
    const role = options.roleCaseSensitive ? roleValue : normalizeLowercaseStringOrEmpty(roleValue);
    if (role !== "assistant") {
      return null;
    }
  } else if (options.roleRequirement === "required") {
    return null;
  }

  if (options.requireContentArray) {
    return Array.isArray(candidate.content) ? candidate : null;
  }
  if (!("content" in candidate) && !(options.allowTextField && "text" in candidate)) {
    return null;
  }
  return candidate;
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "required",
    roleCaseSensitive: true,
    requireContentArray: true,
  });
}

function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  const normalized = normalizeAssistantMessage(message, {
    roleRequirement: "optional",
    allowTextField: true,
  });
  if (!normalized) {
    return null;
  }
  const assistant =
    typeof normalized.role === "string" ? normalized : { ...normalized, role: "assistant" };
  // Older final envelopes carry their visible reply in `text`. Canonicalize
  // before reducing so replay identity includes the delivered content.
  return !Object.hasOwn(assistant, "content") && typeof assistant.text === "string"
    ? { ...assistant, content: [{ type: "text", text: assistant.text }] }
    : assistant;
}

function normalizeChatErrorComparisonText(text: string): string {
  return text
    .replace(/^⚠️\s*/u, "")
    .replace(/^Error:\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function resolveGatewayErrorText(
  payload: ChatEventPayload,
  message: Record<string, unknown> | null,
): string {
  const errorText = payload.errorMessage?.trim();
  if (errorText) {
    return errorText.startsWith("⚠️") || errorText.startsWith("Error:")
      ? errorText
      : `Error: ${errorText}`;
  }
  const messageText = message ? extractText(message)?.trim() : null;
  return messageText || "chat error";
}

function payloadMessageIsErrorProjection(
  payload: ChatEventPayload,
  message: Record<string, unknown>,
): boolean {
  const messageText = extractText(message)?.trim();
  if (!messageText) {
    return false;
  }
  const errorText = payload.errorMessage?.trim();
  if (!errorText) {
    return false;
  }
  return (
    normalizeChatErrorComparisonText(messageText) === normalizeChatErrorComparisonText(errorText)
  );
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
    retainSupersededMessages = false,
  ): void => {
    const event = payload as ChatEventPayload & { messageId?: unknown; messageSeq?: unknown };
    publishChatSessionProjectionMessages(state, visibleMessages, {
      scope,
      retainSupersededMessages,
      event: {
        type: "messagePersisted",
        message,
        envelope: {
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
      runId: terminalRunId,
      sessionKey: state.sessionKey,
      sessionKeys,
      clearLocalRun: true,
      clearChatStream: true,
      armLocalTerminalReconcile: hadActiveRunBeforeEvent && activeRunMatches,
    });
  };
  const previousTerminalRun = projectedRun?.previousRun;
  if (previousTerminalRun && previousTerminalRun.status !== "streaming") {
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
        setChatRunError(state, resolveGatewayErrorText(payload, null), payload.runId);
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
    (!previousTerminalRun || previousTerminalRun.status === "streaming") &&
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
    if (payload.phase) {
      reconcileChatRunStartup(state, {
        state: "status",
        runId: payload.runId,
        phase: payload.phase,
        ...(payload.seq === undefined ? {} : { seq: payload.seq }),
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
        // Same-run assistant rows share one cumulative reducer identity. Keep the
        // authoritative prefix stable and project the complete terminal tail after it.
        discardStreamSegmentIndexes(state, boundary.replacedSegmentIndexes);
        let visibleMessages = materializeVisibleStream({ includeCurrent: false });
        if (boundary.tailMessage && !shouldHideAssistantChatMessage(boundary.tailMessage)) {
          visibleMessages = appendTerminalAssistantMessage(
            visibleMessages,
            rememberLiveTerminalRun(
              boundary.tailMessage,
              terminalRunId,
              boundary.afterBoundaryRunId,
            ),
          );
          publishVisibleTerminal(boundary.tailMessage, visibleMessages, terminalRunId, true);
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
      setChatRunError(state, resolveGatewayErrorText(payload, null), payload.runId);
    }
    reconcileOwnedTerminalRun();
  } else if (payload.state === "error") {
    const payloadMessage = normalizeFinalAssistantMessage(payload.message);
    const visiblePayloadMessage =
      payloadMessage && !shouldHideAssistantChatMessage(payloadMessage) ? payloadMessage : null;
    const projectedErrorMessage = Boolean(
      visiblePayloadMessage && payloadMessageIsErrorProjection(payload, visiblePayloadMessage),
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
