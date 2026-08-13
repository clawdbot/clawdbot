import {
  hasSessionProjectionAcceptedFinal,
  reduceSessionProjectionRunEvent,
} from "@openclaw/gateway-client/browser";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isAssistantHeartbeatAckForDisplay } from "../../lib/chat/heartbeat-display.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
// Control UI page module reconciles Chat Gateway events into Chat state.
import { isUiGlobalSessionKey, resolveUiDefaultAgentId } from "../../lib/sessions/session-key.ts";
import {
  chatScopedEventSessionMatches,
  isHiddenAssistantStreamText,
  isSilentReplyStream,
  materializeVisibleAssistantStreamMessages,
  shouldHideAssistantChatMessage,
  type ChatEventPayload,
  type ChatState,
} from "./chat-history.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
  setChatSessionProjection,
} from "./history-merge.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { appendChatMessageToCache } from "./session-message-cache.ts";
import { retireSteeredChipsForTerminalRun } from "./steer-lifecycle.ts";
import {
  appendTerminalAssistantMessage,
  clearToolStreamSegments,
  hasVisibleStreamParts,
  streamReconciliationStartIndex,
  terminalMessageReplacesVisibleStream,
} from "./stream-reconciliation.ts";
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

function setChatRunError(state: ChatState, summary: string) {
  state.chatRunError = { summary };
}

function chatEventSessionMatches(state: ChatState, payload: ChatEventPayload): boolean {
  return chatScopedEventSessionMatches(state, payload.sessionKey, payload.agentId);
}

function isPendingLocalChatRun(state: ChatState, runId: string): boolean {
  return state.chatQueue.some((item) => item.sendRunId === runId && item.sendState === "sending");
}

function isTerminalChatState(value: unknown): boolean {
  return value === "final" || value === "aborted" || value === "error";
}

function isEventForDifferentActiveRun(
  payload: ChatEventPayload | undefined,
  activeRunId: string | null,
): boolean {
  return Boolean(activeRunId && payload && payload.runId !== activeRunId);
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

function stripChatErrorMarker(text: string): string {
  return text.replace(/^⚠️\s*/u, "");
}

function normalizeChatErrorComparisonText(text: string): string {
  return stripChatErrorMarker(text)
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
      ? stripChatErrorMarker(errorText)
      : `Error: ${errorText}`;
  }
  const messageText = message ? extractText(message)?.trim() : null;
  return messageText ? stripChatErrorMarker(messageText) : "chat error";
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

function handleChatEvent(
  state: ChatState,
  payload?: ChatEventPayload,
  opts?: { keyedStreamStartIndex?: number },
) {
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
    payload.runId &&
    authoritativeHistoryAppliedForRun(state, payload.runId) &&
    chatEventSessionMatches(state, payload),
  );
  if (!sessionMatches && !activeRunMatches) {
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
  const publishVisibleFinal = (
    message: Record<string, unknown>,
    visibleMessages: unknown[],
    runId: string | null | undefined,
  ): void => {
    const event = payload as ChatEventPayload & { messageId?: unknown; messageSeq?: unknown };
    reduceChatSessionProjection(
      state,
      {
        type: "messagePersisted",
        message,
        envelope: {
          ...(runId ? { runId } : {}),
          ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
          ...(event.messageSeq === undefined ? {} : { messageSeq: event.messageSeq }),
        },
      },
      { scope, messages: visibleMessages.slice(0, -1) },
    );
  };
  const projectedRun =
    payload.runId && payload.state !== "status"
      ? reduceSessionProjectionRunEvent(
          getChatSessionProjection(state, state.chatMessages, scope),
          normalizedFinalMessage ? { ...payload, message: normalizedFinalMessage } : payload,
          scope,
        )
      : null;
  if (projectedRun) {
    setChatSessionProjection(state, projectedRun.projection);
  }
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
        setChatRunError(state, resolveGatewayErrorText(payload, null));
      }
      if (payload.state === "error") {
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
      return payload.state;
    }
  }
  if (
    !state.chatRunId &&
    sessionMatches &&
    typeof payload.runId === "string" &&
    (payload.state !== "status" || isPendingLocalChatRun(state, payload.runId))
  ) {
    state.chatRunId = payload.runId;
    state.chatRunError = null;
    state.chatStreamStartedAt ??= Date.now();
  }

  // Terminal events for the active client run carry runId; missing-runId events are unowned.
  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      const finalMessage = normalizedFinalMessage;
      if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
        publishVisibleFinal(finalMessage, [...state.chatMessages, finalMessage], payload.runId);
        return null;
      }
      return "final";
    }
    return null;
  }

  const terminalRunId = payload.runId ?? state.chatRunId;
  const materializeVisibleStream = (
    materializeOpts: Parameters<typeof materializeVisibleAssistantStreamMessages>[2] = {},
  ) =>
    materializeVisibleAssistantStreamMessages(state.chatMessages, state, {
      ...materializeOpts,
      keyedStartIndex: opts?.keyedStreamStartIndex,
    });
  const reconcileTerminalRun = (
    outcome: "done" | "interrupted",
    sessionStatus: "done" | "failed" | "killed" | "timeout",
  ) =>
    reconcileChatRunLifecycle(state as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
      outcome,
      sessionStatus,
      runId: terminalRunId,
      sessionKey: state.sessionKey,
      sessionKeys: sessionMatches ? [state.sessionKey, payload.sessionKey] : [],
      clearLocalRun: true,
      clearChatStream: true,
      armLocalTerminalReconcile: hadActiveRunBeforeEvent && activeRunMatches,
    });

  if (payload.state === "status") {
    if (!payload.runId || payload.runId !== state.chatRunId) {
      return null;
    }
    if (
      payload.phase &&
      !(state.chatRunStartup?.state === "activity" && state.chatRunStartup.runId === payload.runId)
    ) {
      state.chatRunStartup = { state: "status", runId: payload.runId, phase: payload.phase };
    }
    return payload.state;
  }

  if (payload.state === "delta") {
    if (payload.runId && payload.runId === state.chatRunId) {
      state.chatRunStartup = { state: "activity", runId: payload.runId };
    }
    const next = resolveDeltaChatStreamText(state.chatStream, payload);
    if (
      typeof next === "string" &&
      !isSilentReplyStream(next) &&
      !isAssistantHeartbeatAckForDisplay(payload.message)
    ) {
      state.chatStream = next;
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizedFinalMessage;
    if (authoritativeTerminalMatches) {
      // History already owns this run's terminal message. Discard the live
      // projection; reconcileTerminalRun below clears its remaining stream.
      clearToolStreamSegments(state);
    } else if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
      if (
        hasVisibleStreamParts(state, {
          includeCurrent: false,
          isHiddenStreamText: isHiddenAssistantStreamText,
        })
      ) {
        state.chatMessages = materializeVisibleStream({ includeCurrent: false });
        clearToolStreamSegments(state);
      }
      const liveFinal = rememberLiveTerminalRun(finalMessage, terminalRunId);
      publishVisibleFinal(
        finalMessage,
        appendTerminalAssistantMessage(state.chatMessages, liveFinal),
        terminalRunId,
      );
    } else {
      state.chatMessages = materializeVisibleStream();
    }
    if (payload.yielded === true && payload.stopReason === "end_turn") {
      reconcileChatRunLifecycle(
        state as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
        {
          yielded: true,
          runId: terminalRunId,
          sessionKey: state.sessionKey,
          sessionKeys: sessionMatches ? [state.sessionKey, payload.sessionKey] : [],
          clearLocalRun: true,
          clearChatStream: true,
        },
      );
    } else {
      reconcileTerminalRun("done", "done");
    }
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage && !shouldHideAssistantChatMessage(normalizedMessage)) {
      state.chatMessages = materializeVisibleStream({
        replacementMessages: [normalizedMessage],
        includeCurrent: false,
      });
      state.chatMessages = appendTerminalAssistantMessage(state.chatMessages, normalizedMessage);
    } else {
      state.chatMessages = materializeVisibleStream();
    }
    if (payload.errorMessage?.trim()) {
      setChatRunError(state, resolveGatewayErrorText(payload, null));
    }
    reconcileTerminalRun("interrupted", "killed");
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
        if (replacesVisibleStream) {
          if (
            hasVisibleStreamParts(state, {
              includeCurrent: false,
              isHiddenStreamText: isHiddenAssistantStreamText,
            })
          ) {
            state.chatMessages = materializeVisibleStream({ includeCurrent: false });
            clearToolStreamSegments(state);
          }
          state.chatMessages = appendTerminalAssistantMessage(
            state.chatMessages,
            visiblePayloadMessage,
          );
        } else {
          state.chatMessages = materializeVisibleStream({ includeCurrent: true });
          clearToolStreamSegments(state);
          state.chatMessages = [...state.chatMessages, visiblePayloadMessage];
        }
      } else {
        state.chatMessages = materializeVisibleStream({ includeCurrent: true });
      }
    }
    // The shared Gateway projection owns timeout classification; preserve it
    // when publishing selected-session and sidebar terminal status.
    reconcileTerminalRun(
      "interrupted",
      projectedRun?.currentRun?.status === "timeout" ? "timeout" : "failed",
    );
    setChatRunError(
      state,
      resolveGatewayErrorText(payload, projectedErrorMessage ? visiblePayloadMessage : null),
    );
  }
  return payload.state;
}

export function handleChatGatewayEvent(state: ChatState, payload?: ChatEventPayload) {
  const activeRunIdBeforeEvent = state.chatRunId;
  let terminalKeyedStreamStartIndex: number | undefined;
  if (
    isTerminalChatState(payload?.state) &&
    payload !== undefined &&
    // Unkeyed events must also carry a real run id: with no active run,
    // `undefined === undefined` would let sessionless internal-run terminals
    // (e.g. companion answers) materialize into the open main thread.
    (chatEventSessionMatches(state, payload) ||
      (typeof payload.runId === "string" && payload.runId === activeRunIdBeforeEvent)) &&
    !isEventForDifferentActiveRun(payload, activeRunIdBeforeEvent)
  ) {
    // The active stream belongs to the user boundary that preceded any steer
    // chip retired below. Preserve that boundary through terminal materialization.
    const localOnlySteerBoundary = streamReconciliationStartIndex(state.chatMessages);
    // A steered chip can be the only local copy while transcript persistence lags.
    // Materialize it before the terminal assistant so user/assistant order stays stable.
    const firstPersistedSteerIndex = retireSteeredChipsForTerminalRun(state, payload?.runId);
    terminalKeyedStreamStartIndex =
      firstPersistedSteerIndex === undefined
        ? localOnlySteerBoundary
        : streamReconciliationStartIndex(state.chatMessages, firstPersistedSteerIndex);
  }
  const result = handleChatEvent(state, payload, {
    keyedStreamStartIndex: terminalKeyedStreamStartIndex,
  });
  return result;
}
