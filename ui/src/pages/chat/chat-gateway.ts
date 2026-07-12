import { isAssistantHeartbeatAckForDisplay } from "../../lib/chat/heartbeat-display.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { parseChatSideResult, type ChatSideResult } from "../../lib/chat/side-result.ts";
// Control UI page module reconciles Chat Gateway events into Chat state.
import { isUiGlobalSessionKey, resolveUiDefaultAgentId } from "../../lib/sessions/session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";
import {
  chatScopedEventSessionMatches,
  isHiddenAssistantStreamText,
  isSilentReplyStream,
  materializeVisibleAssistantStreamMessages,
  shouldHideAssistantChatMessage,
  type ChatEventPayload,
  type ChatState,
} from "./chat-history.ts";
import { clearPendingQueueItemsForRun } from "./chat-queue.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { appendChatMessageToCache } from "./session-message-cache.ts";
import {
  appendTerminalAssistantMessage,
  clearToolStreamSegments,
  hasVisibleStreamParts,
} from "./stream-reconciliation.ts";

export type { ChatEventPayload, ChatState } from "./chat-history.ts";

type AssistantMessageNormalizationOptions = {
  roleRequirement: "required" | "optional";
  roleCaseSensitive?: boolean;
  requireContentArray?: boolean;
  allowTextField?: boolean;
};

function setChatError(state: ChatState, error: string | null) {
  state.lastError = error;
  state.chatError = error;
}

function chatEventSessionMatches(state: ChatState, payload: ChatEventPayload): boolean {
  return chatScopedEventSessionMatches(state, payload.sessionKey, payload.agentId);
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
  return normalizeAssistantMessage(message, {
    roleRequirement: "optional",
    allowTextField: true,
  });
}

function buildErrorAssistantMessage(payload: ChatEventPayload): Record<string, unknown> | null {
  const normalized = normalizeFinalAssistantMessage(payload.message);
  if (normalized && !shouldHideAssistantChatMessage(normalized)) {
    return normalized;
  }
  const error = payload.errorMessage?.trim();
  if (!error) {
    return null;
  }
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: error.startsWith("⚠️") || error.startsWith("Error:") ? error : `Error: ${error}`,
      },
    ],
    timestamp: Date.now(),
  };
}

function appendCachedChatMessage(
  state: ChatState,
  sessionKey: string,
  message: unknown,
  agentId?: string,
) {
  if (!state.chatMessagesBySession) {
    return;
  }
  appendChatMessageToCache(state.chatMessagesBySession, state, { sessionKey, agentId }, message);
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  const hadActiveRunBeforeEvent = state.chatRunId !== null;
  const sessionMatches = chatEventSessionMatches(state, payload);
  const activeRunMatches =
    state.chatRunId !== null &&
    typeof payload.runId === "string" &&
    payload.runId === state.chatRunId;
  if (!sessionMatches && !activeRunMatches) {
    if (payload.state === "final") {
      const finalMessage = normalizeFinalAssistantMessage(payload.message);
      if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
        const cacheAgentId = isUiGlobalSessionKey(payload.sessionKey)
          ? (payload.agentId ?? resolveUiDefaultAgentId(state))
          : payload.agentId;
        appendCachedChatMessage(state, payload.sessionKey, finalMessage, cacheAgentId);
      }
    }
    return null;
  }
  if (!state.chatRunId && sessionMatches && typeof payload.runId === "string") {
    state.chatRunId = payload.runId;
    state.chatStreamStartedAt ??= Date.now();
  }

  // Terminal events for the active client run carry runId; missing-runId events are unowned.
  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      const finalMessage = normalizeFinalAssistantMessage(payload.message);
      if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
        state.chatMessages = [...state.chatMessages, finalMessage];
        return null;
      }
      return "final";
    }
    return null;
  }

  const terminalRunId = payload.runId ?? state.chatRunId;
  const reconcileTerminalRun = (
    outcome: "done" | "interrupted",
    sessionStatus: "done" | "failed" | "killed",
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

  if (payload.state === "delta") {
    const next = resolveDeltaChatStreamText(state.chatStream, payload);
    if (
      typeof next === "string" &&
      !isSilentReplyStream(next) &&
      !isAssistantHeartbeatAckForDisplay(payload.message)
    ) {
      state.chatStream = next;
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizeFinalAssistantMessage(payload.message);
    if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
      if (
        hasVisibleStreamParts(state, {
          includeCurrent: false,
          isHiddenStreamText: isHiddenAssistantStreamText,
        })
      ) {
        state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state, {
          includeCurrent: false,
        });
        clearToolStreamSegments(state);
      }
      state.chatMessages = appendTerminalAssistantMessage(state.chatMessages, finalMessage);
    } else {
      state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state);
    }
    reconcileTerminalRun("done", "done");
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage && !shouldHideAssistantChatMessage(normalizedMessage)) {
      state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state, {
        replacementMessages: [normalizedMessage],
        includeCurrent: false,
      });
      state.chatMessages = appendTerminalAssistantMessage(state.chatMessages, normalizedMessage);
    } else {
      state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state);
    }
    reconcileTerminalRun("interrupted", "killed");
  } else if (payload.state === "error") {
    const payloadMessage = hadActiveRunBeforeEvent
      ? normalizeFinalAssistantMessage(payload.message)
      : null;
    const visiblePayloadMessage =
      payloadMessage && !shouldHideAssistantChatMessage(payloadMessage) ? payloadMessage : null;
    if (visiblePayloadMessage) {
      state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state, {
        replacementMessages: [visiblePayloadMessage],
      });
      state.chatMessages = appendTerminalAssistantMessage(
        state.chatMessages,
        visiblePayloadMessage,
      );
    } else {
      const errorMessage = hadActiveRunBeforeEvent ? buildErrorAssistantMessage(payload) : null;
      if (hadActiveRunBeforeEvent) {
        state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state);
      }
      if (errorMessage) {
        state.chatMessages = appendTerminalAssistantMessage(state.chatMessages, errorMessage);
      }
    }
    reconcileTerminalRun("interrupted", "failed");
    setChatError(state, payload.errorMessage ?? "chat error");
  }
  return payload.state;
}

export function handleChatGatewayEvent(state: ChatState, payload?: ChatEventPayload) {
  // A BTW run that fails before seeding context terminates with a plain chat
  // event and never emits chat.side_result. Convert the failure into an error
  // side-result card and swallow the event: detached BTW runs must not reach
  // normal chat handling, where an idle pane would adopt them into the
  // transcript. Successful runs clear pending via the side_result handler
  // before their terminal chat event arrives.
  if (
    isTerminalChatState(payload?.state) &&
    typeof payload?.runId === "string" &&
    state.chatSideResultPending?.runId === payload.runId
  ) {
    appendChatSideChatTurn(state, {
      kind: "btw",
      runId: payload.runId,
      sessionKey: payload.sessionKey ?? state.sessionKey,
      question: state.chatSideResultPending.question,
      text: extractBtwFailureText(payload) ?? "The side question ended without a result.",
      isError: true,
      ts: Date.now(),
    });
    state.chatSideResultPending = null;
    return null;
  }
  if (
    isTerminalChatState(payload?.state) &&
    typeof payload?.runId === "string" &&
    state.chatSideResultTerminalRuns?.has(payload.runId) === true
  ) {
    state.chatSideResultTerminalRuns.delete(payload.runId);
    return null;
  }
  const activeRunIdBeforeEvent = state.chatRunId;
  const result = handleChatEvent(state, payload);
  if (
    isTerminalChatState(result) &&
    !isEventForDifferentActiveRun(payload, activeRunIdBeforeEvent)
  ) {
    clearPendingQueueItemsForRun(state, payload?.runId);
  }
  return result;
}

export function handleChatSideResultGatewayEvent(state: ChatState, payload: unknown): boolean {
  const sideResult = parseChatSideResult(payload);
  if (!sideResult) {
    return false;
  }
  if (!chatScopedEventSessionMatches(state, sideResult.sessionKey, sideResult.agentId)) {
    return false;
  }
  // Runs retired before display (superseded by a newer question or dismissed)
  // enter chatSideResultTerminalRuns via retirePendingChatSideQuestion before
  // their side_result can arrive; live runs only enter the set below. A
  // retired run's late result must not replace the current card, and its
  // entry stays so the trailing terminal chat event is still swallowed.
  if (state.chatSideResultTerminalRuns?.has(sideResult.runId)) {
    return true;
  }
  // A same-session result from another run (e.g. a split pane) must not
  // replace this pane's live pending card — displaying it would also let the
  // dismiss button retire the hidden pending run. Record it so its trailing
  // terminal chat event is still swallowed here.
  const pending = state.chatSideResultPending;
  if (pending?.runId && pending.runId !== sideResult.runId) {
    state.chatSideResultTerminalRuns?.add(sideResult.runId);
    return true;
  }
  // Follow-up commands embed prior-turn context; the server echoes that whole
  // blob as the question. The correlated pending record holds the user's
  // typed question, so prefer it for display.
  const question = pending?.runId === sideResult.runId ? pending.question : sideResult.question;
  appendChatSideChatTurn(state, { ...sideResult, question });
  state.chatSideResultPending = null;
  state.chatSideResultTerminalRuns?.add(sideResult.runId);
  return true;
}

/** An arriving answer appends a turn and reopens a panel hidden via X/Escape. */
function appendChatSideChatTurn(state: ChatState, turn: ChatSideResult) {
  state.chatSideChatTurns = [...(state.chatSideChatTurns ?? []), turn];
  state.chatSideChatHidden = false;
}

function extractBtwFailureText(payload: ChatEventPayload): string | null {
  if (typeof payload.errorMessage === "string" && payload.errorMessage.trim()) {
    return payload.errorMessage;
  }
  const message = payload.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const text = blocks
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? (block as { text?: unknown }).text
        : null,
    )
    .filter((entry): entry is string => typeof entry === "string")
    .join("\n")
    .trim();
  return text || null;
}
