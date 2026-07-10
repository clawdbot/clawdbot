// Control UI module implements app chat behavior.
import { isNonTerminalAgentRunStatus } from "../../../../src/shared/agent-run-status.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayHelloOk,
} from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { setLastActiveSessionKey } from "../../app/settings.ts";
import type {
  ChatAttachment,
  ChatQueueItem,
  ChatQueueSkillWorkshopRevision,
} from "../../lib/chat/chat-types.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";
import {
  scopedAgentIdForSession,
  visibleSessionMatches,
  type SessionCapability,
  type SessionRefreshTarget,
} from "../../lib/sessions/index.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  discardChatAttachmentDataUrls,
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  dispatchChatSlashCommand,
  type ChatCommandHost,
  type ChatCommandResetOptions,
  shouldQueueLocalSlashCommand,
} from "./chat-commands.ts";
import { loadChatHistory, type ChatState } from "./chat-history.ts";
import {
  enqueueChatMessage,
  excludeComposerAttachments,
  persistQueuedMessagesForSession,
  readChatQueueForSession,
  removeQueuedMessageWithoutReleasing,
  removeVisibleOrScopedQueuedMessageWithoutReleasing,
  updateQueuedMessage,
  updateQueuedMessageForSession,
} from "./chat-queue.ts";
import type {
  ChatSendAck,
  ChatSendAckServerTiming,
  ChatSendTimingEntry,
} from "./chat-send-contract.ts";
import {
  chatSendAckServerTimingEventFields,
  recordChatSendTiming,
  registerChatSendTiming,
  schedulePendingSendPaintTiming,
  updateChatSendAckTiming,
} from "./chat-send-timing.ts";
import { getPendingChatPickerPatch, refreshChatSessionListForTarget } from "./chat-session.ts";
import {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  removeStoredChatComposerQueueItem,
} from "./composer-persistence.ts";
import { formatConnectError } from "./connect-error.ts";
import {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  navigateChatInputHistory,
  recordNonTranscriptInputHistory,
  resetChatInputHistoryNavigation,
  type ChatInputHistoryKeyInput,
  type ChatInputHistoryKeyResult,
  type ChatInputHistoryState,
} from "./input-history.ts";
import { controlUiNowMs, roundedControlUiDurationMs } from "./performance.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";
import {
  handleAbortChat,
  isChatBusy,
  isChatStopCommand,
  reconcileChatRunLifecycle,
} from "./run-lifecycle.ts";
import { scheduleChatScroll, resetChatScroll } from "./scroll.ts";
import { resetToolStream } from "./tool-stream.ts";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

export type ChatHost = ChatInputHistoryState &
  ChatCommandHost & {
    sessions: SessionCapability;
    client: GatewayBrowserClient | null;
    chatStream: string | null;
    connected: boolean;
    chatAttachments: ChatAttachment[];
    chatQueue: ChatQueueItem[];
    chatQueueBySession?: Record<string, ChatQueueItem[]>;
    chatRunId: string | null;
    chatSending: boolean;
    lastError?: string | null;
    chatError?: string | null;
    hello: GatewayHelloOk | null;
    renderLifecycle?: RenderLifecycle;
    requestUpdate?: () => void;
    refreshSessionsAfterChat: Map<string, SessionRefreshTarget>;
    chatSubmitGuards?: Map<string, Promise<void>>;
    drainQueueAfterSend?: boolean;
    chatSendTimingsByRun?: Map<string, ChatSendTimingEntry>;
    eventLogBuffer?: unknown[];
    assistantAgentId?: string | null;
    agentsList?: ChatAgentsListSnapshot | null;
    /** Selected message to reply to (right-click / keyboard shortcut). */
    chatReplyTarget?: { messageId: string; text: string; senderLabel?: string | null } | null;
  };

type ChatAgentsListSnapshot = Partial<Omit<AgentsListResult, "agents">> & {
  agents?: AgentsListResult["agents"];
};

function setChatError(
  host: { lastError?: string | null; chatError?: string | null },
  error: string | null,
) {
  host.lastError = error;
  host.chatError = error;
}

function sendResetSlashCommand(
  host: ChatHost,
  message: string,
  opts: ChatCommandResetOptions,
): Promise<void> {
  return sendChatMessageNow(host, message, {
    refreshSessions: true,
    previousDraft: opts.previousDraft,
    restoreDraft: opts.restoreDraft,
  }).then(() => undefined);
}

type AcceptedChatSendAck = ChatSendAck & { status: "started" | "in_flight" | "ok" };
type TerminalFailureChatSendAck = ChatSendAck & { status: "timeout" | "error" };

function isAcceptedChatSendAck(ack: ChatSendAck | null): ack is AcceptedChatSendAck {
  return ack != null && (ack.status === "ok" || isNonTerminalAgentRunStatus(ack.status));
}

function isTerminalFailureChatSendAck(ack: ChatSendAck | null): ack is TerminalFailureChatSendAck {
  return ack?.status === "timeout" || ack?.status === "error";
}

function formatTerminalChatSendAckError(
  ack: TerminalFailureChatSendAck,
  context: "chat" | "detached" | "steer",
): string {
  if (ack.status === "error") {
    if (context === "steer") {
      return "Steer failed before it reached the run; try again.";
    }
    return "Chat failed before the run started; try again.";
  }
  if (context === "detached") {
    return "The active run ended before the detached message was accepted.";
  }
  if (context === "steer") {
    return "The active run ended before the steer message was accepted.";
  }
  return "The run ended before the message was accepted.";
}

type ChatSendOptions = {
  confirmReset?: boolean;
  restoreDraft?: boolean;
  skillWorkshopRevision?: ChatQueueSkillWorkshopRevision;
};

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

function buildApiAttachments(attachments?: ChatAttachment[]) {
  const hasAttachments = attachments && attachments.length > 0;
  return hasAttachments
    ? attachments
        .map((att) => {
          const dataUrl = getChatAttachmentDataUrl(att);
          const parsed = dataUrl ? dataUrlToBase64(dataUrl) : null;
          if (!parsed) {
            return null;
          }
          return {
            type: parsed.mimeType.startsWith("image/") ? "image" : "file",
            mimeType: parsed.mimeType,
            fileName: att.fileName,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;
}

function normalizeAckTimingValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export type {
  ChatSendAck,
  ChatSendAckServerTiming,
  ChatSendAckStatus,
} from "./chat-send-contract.ts";

function normalizeChatSendAckServerTiming(value: unknown): ChatSendAckServerTiming | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const receivedToAckMs = normalizeAckTimingValue(record.receivedToAckMs);
  const loadSessionMs = normalizeAckTimingValue(record.loadSessionMs);
  const prepareAttachmentsMs = normalizeAckTimingValue(record.prepareAttachmentsMs);
  const timing: ChatSendAckServerTiming = {
    ...(receivedToAckMs !== undefined ? { receivedToAckMs } : {}),
    ...(loadSessionMs !== undefined ? { loadSessionMs } : {}),
    ...(prepareAttachmentsMs !== undefined ? { prepareAttachmentsMs } : {}),
  };
  return Object.keys(timing).length > 0 ? timing : undefined;
}

function normalizeChatSendAck(payload: unknown, fallbackRunId: string): ChatSendAck {
  if (!payload || typeof payload !== "object") {
    return { runId: fallbackRunId, status: "started" };
  }
  const record = payload as Record<string, unknown>;
  const runId =
    typeof record.runId === "string" && record.runId.trim() ? record.runId.trim() : fallbackRunId;
  const status = record.status;
  const serverTiming = normalizeChatSendAckServerTiming(record.serverTiming);
  return {
    runId,
    status:
      status === "in_flight" || status === "ok" || status === "timeout" || status === "error"
        ? status
        : "started",
    ...(serverTiming ? { serverTiming } : {}),
  };
}

export async function requestChatSend(
  state: ChatState,
  params: {
    message: string;
    attachments?: ChatAttachment[];
    runId: string;
    sessionKey?: string;
    agentId?: string;
  },
): Promise<ChatSendAck> {
  const routing = resolveChatSendRouting(state, params);
  const controlUiReconnectResume = Boolean(
    routing.sessionId && state.reconnectResumeSessionId === routing.sessionId,
  );
  const payload = await state.client!.request("chat.send", {
    sessionKey: routing.sessionKey,
    ...(isUiGlobalSessionKey(routing.sessionKey) && routing.selectedAgentId
      ? { agentId: routing.selectedAgentId }
      : {}),
    ...(routing.sessionId ? { sessionId: routing.sessionId } : {}),
    ...(controlUiReconnectResume ? { __controlUiReconnectResume: true } : {}),
    message: params.message,
    deliver: false,
    idempotencyKey: params.runId,
    attachments: buildApiAttachments(params.attachments),
  });
  if (controlUiReconnectResume) {
    state.reconnectResumeSessionId = null;
  }
  return normalizeChatSendAck(payload, params.runId);
}

function resolveChatSendRouting(
  state: ChatState,
  params: {
    sessionKey?: string;
    agentId?: string;
  },
): { selectedAgentId?: string; sessionId?: string; sessionKey: string } {
  const sessionKey = params.sessionKey ?? state.sessionKey;
  const selectedAgentId = params.agentId
    ? normalizeAgentId(params.agentId)
    : resolveUiSelectedSessionAgentId(state);
  const currentSessionId = state.currentSessionId;
  const canReuseCurrentSessionId =
    sessionKey === state.sessionKey &&
    (!isUiGlobalSessionKey(sessionKey) ||
      (selectedAgentId !== undefined &&
        selectedAgentId === resolveUiSelectedSessionAgentId(state)));
  const sessionId =
    canReuseCurrentSessionId && typeof currentSessionId === "string" && currentSessionId.trim()
      ? currentSessionId.trim()
      : undefined;
  return {
    sessionKey,
    ...(selectedAgentId ? { selectedAgentId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

export async function requestSkillWorkshopRevisionChatSend(
  state: ChatState,
  params: {
    proposalId: string;
    instructions: string;
    runId: string;
    sessionKey?: string;
    agentId?: string;
    targetAgentId?: string;
  },
): Promise<ChatSendAck> {
  const routing = resolveChatSendRouting(state, {
    sessionKey: params.sessionKey,
    agentId: params.targetAgentId,
  });
  const payload = await state.client!.request("skills.proposals.requestRevision", {
    ...(params.agentId ? { agentId: normalizeAgentId(params.agentId) } : {}),
    ...(routing.selectedAgentId ? { targetAgentId: routing.selectedAgentId } : {}),
    proposalId: params.proposalId,
    instructions: params.instructions,
    sessionKey: routing.sessionKey,
    ...(routing.sessionId ? { sessionId: routing.sessionId } : {}),
    idempotencyKey: params.runId,
  });
  return normalizeChatSendAck(payload, params.runId);
}

function appendUserChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
  timestamp = Date.now(),
) {
  const entry = {
    role: "user" as const,
    content: buildUserChatMessageContentBlocks(message, attachments),
    timestamp,
  };
  state.chatMessages = [...state.chatMessages, entry];
  return entry;
}

async function sendChatMessageWithGeneratedRunId(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<ChatSendAck | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }
  setChatError(state, null);
  const runId = generateUUID();
  try {
    return await requestChatSend(state, { message: msg, attachments, runId });
  } catch (err) {
    setChatError(state, formatConnectError(err));
    return null;
  }
}

export async function sendDetachedChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<ChatSendAck | null> {
  return sendChatMessageWithGeneratedRunId(state, message, attachments);
}

export async function sendSteerChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<ChatSendAck | null> {
  return sendChatMessageWithGeneratedRunId(state, message, attachments);
}

export {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  navigateChatInputHistory,
  resetChatInputHistoryNavigation,
};
export type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult };

function isChatResetCommand(text: string) {
  const parsed = parseSlashCommand(text);
  if (!parsed || (parsed.command.key !== "new" && parsed.command.key !== "reset")) {
    return false;
  }
  if (parsed.command.key === "new") {
    return true;
  }
  if (/^soft(?:\s|$)/.test(normalizeLowercaseStringOrEmpty(parsed.args))) {
    return false;
  }
  return true;
}

function confirmChatResetCommand(text: string) {
  if (!isChatResetCommand(text)) {
    return true;
  }
  if (typeof globalThis.confirm !== "function") {
    return false;
  }
  return globalThis.confirm("Start a new session? This will reset the current chat.");
}

function isBtwCommand(text: string) {
  return /^\/(?:btw|side)(?::|\s|$)/i.test(text.trim());
}

function enqueuePendingSendMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
  submittedAtMs = controlUiNowMs(),
  sendState: ChatQueueItem["sendState"] = host.connected && host.client
    ? "sending"
    : "waiting-reconnect",
  skillWorkshopRevision?: ChatQueueSkillWorkshopRevision,
): ChatQueueItem | null {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return null;
  }
  const pending: ChatQueueItem = {
    id: generateUUID(),
    text: trimmed,
    createdAt: Date.now(),
    attachments: hasAttachments ? attachments : undefined,
    refreshSessions,
    sendAttempts: 0,
    sendRunId: generateUUID(),
    sendState,
    sendSubmittedAtMs: submittedAtMs,
    sessionKey: host.sessionKey,
    agentId: scopedAgentIdForSession(host, host.sessionKey),
    ...(skillWorkshopRevision ? { skillWorkshopRevision } : {}),
  };
  host.chatQueue = [...host.chatQueue, pending];
  recordChatSendTiming(host, pending, "pending-visible", submittedAtMs);
  if (sendState === "waiting-model" || sendState === "waiting-reconnect") {
    recordChatSendTiming(host, pending, sendState, submittedAtMs);
  }
  schedulePendingSendPaintTiming(host, pending, submittedAtMs);
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0], true, false, {
    source: "manual",
  });
  return pending;
}

function isRecoverableChatSendError(err: unknown, formattedError: string): boolean {
  if (err instanceof GatewayRequestError) {
    return err.retryable;
  }
  return /gateway (?:not connected|closed)|websocket|disconnected/i.test(formattedError);
}

function restoreComposerAfterFailedSend(
  host: ChatHost,
  opts: {
    previousAttachments?: ChatAttachment[];
    previousDraft?: string;
  },
) {
  if (opts.previousDraft != null && !host.chatMessage.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (opts.previousAttachments?.length && host.chatAttachments.length === 0) {
    host.chatAttachments = opts.previousAttachments;
  }
}

function cancelPendingSendBeforeRequest(
  host: ChatHost,
  queued: ChatQueueItem,
  opts: {
    previousAttachments?: ChatAttachment[];
    previousDraft?: string;
    restoreComposer?: boolean;
  },
) {
  const removed = removeVisibleOrScopedQueuedMessageWithoutReleasing(
    host,
    queued.id,
    queued.sessionKey,
  );
  const restoreComposer = opts.restoreComposer !== false && removed != null;
  const willRestoreDraft =
    restoreComposer && opts.previousDraft != null && !host.chatMessage.trim();
  const willRestoreAttachments = Boolean(
    restoreComposer &&
    opts.previousAttachments?.length &&
    host.chatAttachments.length === 0 &&
    (willRestoreDraft || !host.chatMessage.trim()),
  );
  if (restoreComposer) {
    if (willRestoreDraft) {
      host.chatMessage = opts.previousDraft ?? "";
    }
    if (willRestoreAttachments) {
      host.chatAttachments = opts.previousAttachments ?? [];
    }
  }
  if (removed?.sessionKey) {
    removeStoredChatComposerQueueItem(host, removed.sessionKey, removed.id);
  }
  if (removed && !willRestoreAttachments) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  }
}

type QueuedChatSendResult = "sent" | "pending" | "failed";

function ensureQueuedSendState(
  host: ChatHost,
  item: ChatQueueItem,
  fallbackSessionKey = host.sessionKey,
): ChatQueueItem {
  if (item.sendRunId && item.sendState) {
    return item;
  }
  const sessionKey = item.sessionKey ?? fallbackSessionKey;
  const agentId = item.agentId ?? scopedAgentIdForSession(host, sessionKey);
  const prepared: ChatQueueItem = {
    ...item,
    sendAttempts: item.sendAttempts ?? 0,
    sendRunId: item.sendRunId ?? generateUUID(),
    sendState: host.connected && host.client ? "sending" : "waiting-reconnect",
    sessionKey,
    agentId,
  };
  updateQueuedMessageForSession(host, sessionKey, item.id, () => prepared);
  return prepared;
}

async function sendQueuedChatMessage(
  host: ChatHost,
  id: string,
  opts?: {
    allowBackgroundSession?: boolean;
    previousAttachments?: ChatAttachment[];
    previousDraft?: string;
  },
  queuedSessionKey = host.sessionKey,
): Promise<QueuedChatSendResult> {
  let queued = readChatQueueForSession(host, queuedSessionKey).find((item) => item.id === id);
  if (!queued || queued.pendingRunId || queued.localCommandName) {
    return "failed";
  }
  const settingsKey = queued.sessionKey ?? queuedSessionKey;
  const pendingSettings = getPendingChatPickerPatch(host, settingsKey, queued.agentId);
  if (pendingSettings) {
    // Final admission gate for retries/reconnect replays and picker patches
    // that start after the composer-level snapshot.
    updateQueuedMessageForSession(host, settingsKey, id, (item) => ({
      ...item,
      sendError: undefined,
      sendState: "waiting-model",
    }));
    host.requestUpdate?.();
    if (!(await waitForPendingChatSettings(host, settingsKey, pendingSettings, queued.agentId))) {
      const canRestoreComposer =
        opts?.previousDraft !== undefined &&
        !host.chatMessage.trim() &&
        host.chatAttachments.length === 0;
      if (
        canRestoreComposer &&
        host.sessionKey === settingsKey &&
        visibleSessionMatches(host, settingsKey, queued.agentId)
      ) {
        cancelPendingSendBeforeRequest(host, queued, {
          previousDraft: opts.previousDraft,
          previousAttachments: opts.previousAttachments,
        });
      } else {
        updateQueuedMessageForSession(host, settingsKey, id, (item) => ({
          ...item,
          sendError: INTERRUPTED_SETTINGS_WAIT_ERROR,
          sendState: "failed",
        }));
        persistQueuedMessagesForSession(host, settingsKey);
      }
      host.requestUpdate?.();
      return "failed";
    }
    queued = readChatQueueForSession(host, settingsKey).find((item) => item.id === id);
    if (!queued) {
      return "failed";
    }
  }
  // Foreground admission stays on the exact queue route because global and
  // agent-main aliases can point at distinct stores.
  const sessionVisible =
    host.sessionKey === settingsKey && visibleSessionMatches(host, settingsKey, queued.agentId);
  const foregroundBlocked =
    !opts?.allowBackgroundSession && (!sessionVisible || Boolean(host.chatRunId));
  if (host.chatSending || foregroundBlocked) {
    // Reconnect replay may bypass an inactive route/run, never another request
    // using the shared chatSending admission state.
    updateQueuedMessageForSession(host, settingsKey, id, (item) => ({
      ...item,
      sendError: undefined,
      sendState: opts?.allowBackgroundSession ? "waiting-reconnect" : undefined,
    }));
    persistQueuedMessagesForSession(host, settingsKey);
    if (host.chatSending) {
      host.drainQueueAfterSend = true;
    }
    if (sessionVisible) {
      recordChatSendTiming(host, queued, "queued-busy", queued.sendSubmittedAtMs);
    }
    return "pending";
  }
  const prepared = ensureQueuedSendState(host, queued, queuedSessionKey);
  const message = prepared.text.trim();
  const attachments = prepared.attachments ?? [];
  const hasAttachments = attachments.length > 0;
  if (!message && !hasAttachments) {
    removeQueuedMessageWithoutReleasing(host, id, prepared.sessionKey ?? host.sessionKey);
    return "sent";
  }
  if (prepared.skillWorkshopRevision && hasAttachments) {
    updateQueuedMessageForSession(host, prepared.sessionKey ?? host.sessionKey, id, (item) => ({
      ...item,
      sendError: "Skill Workshop revision requests do not support attachments.",
      sendState: "failed",
    }));
    return "failed";
  }
  const sessionKey = prepared.sessionKey ?? host.sessionKey;
  if (!host.connected || !host.client) {
    updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
      ...item,
      sendState: "waiting-reconnect",
      sendError: undefined,
    }));
    return "pending";
  }

  const runId = prepared.sendRunId ?? generateUUID();
  const startedAt = Date.now();
  const requestStartedAtMs = controlUiNowMs();
  const sendingItem =
    updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
      ...item,
      sendAttempts: (item.sendAttempts ?? 0) + 1,
      sendError: undefined,
      sendRunId: runId,
      sendState: "sending",
      sendRequestStartedAtMs: requestStartedAtMs,
      sessionKey,
      agentId: prepared.agentId,
    })) ?? prepared;
  registerChatSendTiming(host, sendingItem, runId, requestStartedAtMs);
  recordChatSendTiming(host, sendingItem, "request-start", sendingItem.sendSubmittedAtMs);
  host.chatSending = true;
  const isVisibleSession = () => visibleSessionMatches(host, sessionKey, prepared.agentId);
  if (isVisibleSession()) {
    resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
    resetChatScroll(host as unknown as Parameters<typeof resetChatScroll>[0]);
    setChatError(host, null);
    reconcileChatRunLifecycle(host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
      clearRunStatus: true,
    });
  }

  try {
    const ack = prepared.skillWorkshopRevision
      ? await requestSkillWorkshopRevisionChatSend(host as unknown as ChatState, {
          proposalId: prepared.skillWorkshopRevision.proposalId,
          ...(prepared.skillWorkshopRevision.agentId
            ? { agentId: prepared.skillWorkshopRevision.agentId }
            : {}),
          ...(prepared.agentId ? { targetAgentId: prepared.agentId } : {}),
          instructions: message,
          runId,
          sessionKey,
        })
      : await requestChatSend(host as unknown as ChatState, {
          message,
          attachments: hasAttachments ? attachments : undefined,
          runId,
          sessionKey,
          agentId: prepared.agentId,
        });
    updateChatSendAckTiming(host, runId, ack, sendingItem, requestStartedAtMs);
    recordChatSendTiming(host, sendingItem, "ack", sendingItem.sendSubmittedAtMs, {
      ackStatus: ack.status,
      requestDurationMs: roundedControlUiDurationMs(controlUiNowMs() - requestStartedAtMs),
      ...chatSendAckServerTimingEventFields(ack),
    });
    if (isTerminalFailureChatSendAck(ack)) {
      const error = formatTerminalChatSendAckError(ack, "chat");
      updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
        ...item,
        sendError: error,
        sendState: "failed",
      }));
      if (isVisibleSession()) {
        reconcileChatRunLifecycle(
          host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
          {
            outcome: "interrupted",
            sessionStatus: ack.status === "error" ? "failed" : "killed",
            runId: ack.runId,
            sessionKey,
            clearLocalRun: true,
            clearChatStream: true,
            clearToolStream: true,
            clearSideResultTerminalRuns: true,
            publishRunStatus: false,
            armLocalTerminalReconcile: ack.runId === runId,
          },
        );
        setChatError(host, error);
        restoreComposerAfterFailedSend(host, opts ?? {});
      }
      recordChatSendTiming(host, sendingItem, "failed", sendingItem.sendSubmittedAtMs, {
        error,
        ackStatus: ack.status,
      });
      return "failed";
    }
    removeQueuedMessageWithoutReleasing(host, id, sessionKey);
    if (isVisibleSession()) {
      appendUserChatMessage(
        host as unknown as ChatState,
        message,
        hasAttachments ? attachments : undefined,
        startedAt,
      );
      if (ack.status === "ok") {
        reconcileChatRunLifecycle(
          host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
          {
            outcome: "done",
            sessionStatus: "done",
            runId: ack.runId,
            sessionKey,
            clearLocalRun: true,
            clearChatStream: true,
            clearToolStream: true,
            clearSideResultTerminalRuns: true,
            publishRunStatus: false,
            armLocalTerminalReconcile: true,
          },
        );
        void loadChatHistory(host as unknown as ChatState);
      } else if (isNonTerminalAgentRunStatus(ack.status)) {
        const hasAlreadyAdoptedRunStream =
          host.chatRunId === ack.runId && typeof host.chatStream === "string";
        host.chatRunId = ack.runId;
        // Gateway can deliver the first delta before the chat.send ACK resolves.
        // Preserve that adopted stream; resetting here makes first replies vanish
        // until a later delta or final event arrives.
        if (!hasAlreadyAdoptedRunStream) {
          host.chatStream = "";
          (host as ChatHost & { chatStreamStartedAt?: number | null }).chatStreamStartedAt =
            startedAt;
        }
      } else {
        reconcileChatRunLifecycle(
          host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
          {
            outcome: "interrupted",
            sessionStatus: ack.status === "error" ? "failed" : "killed",
            runId: ack.runId,
            sessionKey,
            clearLocalRun: true,
            clearChatStream: true,
            clearToolStream: true,
            clearSideResultTerminalRuns: true,
            publishRunStatus: false,
            armLocalTerminalReconcile: ack.runId === runId,
          },
        );
      }
    }
    if (prepared.refreshSessions) {
      const refreshTarget = {
        sessionKey,
        agentId: prepared.agentId,
      };
      if (ack.status === "ok") {
        void refreshChatSessionListForTarget(host, refreshTarget);
      } else if (isNonTerminalAgentRunStatus(ack.status)) {
        host.refreshSessionsAfterChat.set(ack.runId, refreshTarget);
      }
    }
    discardChatAttachmentDataUrls(excludeComposerAttachments(host, attachments));
    return "sent";
  } catch (err) {
    const error = formatConnectError(err);
    if (isRecoverableChatSendError(err, error)) {
      updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
        ...item,
        sendError: error,
        sendState: "waiting-reconnect",
      }));
      if (isVisibleSession()) {
        setChatError(host, "Message will send when the Gateway reconnects.");
      }
      recordChatSendTiming(host, prepared, "waiting-reconnect", prepared.sendSubmittedAtMs, {
        error,
      });
      return "pending";
    }
    updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
      ...item,
      sendError: error,
      sendState: "failed",
    }));
    if (isVisibleSession()) {
      setChatError(host, error);
      restoreComposerAfterFailedSend(host, opts ?? {});
    }
    recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, { error });
    return "failed";
  } finally {
    host.chatSending = false;
    if (host.drainQueueAfterSend) {
      host.drainQueueAfterSend = false;
      void retryReconnectableQueuedChatSends(host);
    }
  }
}

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    queueItemId?: string;
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
    refreshSessions?: boolean;
    submittedAtMs?: number;
  },
) {
  const queued =
    opts?.queueItemId != null
      ? (host.chatQueue.find((item) => item.id === opts.queueItemId) ?? null)
      : enqueuePendingSendMessage(
          host,
          message,
          opts?.attachments,
          opts?.refreshSessions,
          opts?.submittedAtMs,
        );
  if (!queued) {
    return false;
  }
  const queuedSessionKey = queued.sessionKey ?? host.sessionKey;
  const result = await sendQueuedChatMessage(host, queued.id, {
    previousDraft: opts?.previousDraft,
    previousAttachments: opts?.previousAttachments,
  });
  const ok = result === "sent";
  if (ok && host.sessionKey === queuedSessionKey) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      queuedSessionKey,
    );
    resetChatInputHistoryNavigation(host);
  }
  if (
    ok &&
    host.sessionKey === queuedSessionKey &&
    opts?.restoreDraft &&
    opts.previousDraft?.trim()
  ) {
    host.chatMessage = opts.previousDraft;
  }
  if (
    ok &&
    host.sessionKey === queuedSessionKey &&
    opts?.restoreAttachments &&
    opts.previousAttachments?.length
  ) {
    host.chatAttachments = opts.previousAttachments;
  }
  // Force scroll after sending to ensure viewport is at bottom for incoming stream
  if (host.sessionKey === queuedSessionKey) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0], true);
  }
  if (ok && host.sessionKey === queuedSessionKey && !host.chatRunId) {
    void flushChatQueue(host);
  }
  return ok;
}

function attachmentSubmitSignature(attachment: ChatAttachment): string {
  const dataUrl = getChatAttachmentDataUrl(attachment);
  return JSON.stringify([
    attachment.id,
    attachment.mimeType,
    attachment.fileName ?? "",
    attachment.sizeBytes ?? 0,
    dataUrl?.length ?? 0,
    dataUrl?.slice(0, 64) ?? "",
  ]);
}

function chatSubmitKey(
  host: ChatHost,
  kind: "detached" | "local" | "message",
  message: string,
  attachments: ChatAttachment[],
  skillWorkshopRevision?: ChatQueueSkillWorkshopRevision,
): string {
  return JSON.stringify([
    kind,
    host.sessionKey,
    message.trim(),
    skillWorkshopRevision?.proposalId ?? "",
    skillWorkshopRevision?.agentId ?? "",
    attachments.map(attachmentSubmitSignature),
  ]);
}

async function withChatSubmitGuard<T>(
  host: ChatHost,
  key: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  const guards = (host.chatSubmitGuards ??= new Map<string, Promise<void>>());
  if (guards.has(key)) {
    return undefined;
  }
  let releaseGuard!: () => void;
  const guard = new Promise<void>((resolve) => {
    releaseGuard = resolve;
  });
  guards.set(key, guard);
  try {
    return await run();
  } finally {
    releaseGuard();
    if (guards.get(key) === guard) {
      guards.delete(key);
    }
  }
}

async function waitForPendingChatSettings(
  host: ChatHost,
  sessionKey: string,
  initialPending: Promise<boolean>,
  agentId?: string,
): Promise<boolean> {
  let pending = initialPending;
  while (await pending) {
    const nextPending = getPendingChatPickerPatch(host, sessionKey, agentId);
    if (!nextPending || nextPending === pending) {
      return true;
    }
    pending = nextPending;
  }
  return false;
}

function clearSubmittedComposerState(
  host: ChatHost,
  submittedDraft: string,
  submittedAttachments: ChatAttachment[],
): {
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
} {
  const attachmentsUnchanged =
    host.chatAttachments.length === submittedAttachments.length &&
    host.chatAttachments.every(
      (attachment, index) =>
        attachmentSubmitSignature(attachment) ===
        attachmentSubmitSignature(submittedAttachments[index]),
    );
  const clearedDraft = host.chatMessage === submittedDraft && attachmentsUnchanged;
  const clearedAttachments = clearedDraft;
  if (clearedDraft) {
    host.chatMessage = "";
  }
  if (clearedAttachments) {
    host.chatAttachments = [];
  }
  if (clearedDraft || clearedAttachments) {
    resetChatInputHistoryNavigation(host);
  }
  return {
    previousAttachments: clearedAttachments ? submittedAttachments : undefined,
    previousDraft: clearedDraft ? submittedDraft : undefined,
  };
}

function snapshotChatAttachments(attachments: readonly ChatAttachment[]): ChatAttachment[] {
  return attachments.map((attachment) => {
    const dataUrl = getChatAttachmentDataUrl(attachment);
    return {
      ...attachment,
      ...(dataUrl ? { dataUrl } : {}),
    };
  });
}

async function sendDetachedCommandMessage(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
  },
) {
  const ack = await sendDetachedChatMessage(
    host as unknown as ChatState,
    message,
    opts?.attachments,
  );
  const ok = isAcceptedChatSendAck(ack);
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  if (isTerminalFailureChatSendAck(ack)) {
    setChatError(host, formatTerminalChatSendAckError(ack, "detached"));
  }
  if (ok) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, opts?.attachments));
  }
  return ok;
}

export async function steerQueuedChatMessage(host: ChatHost, id: string) {
  if (!host.connected || !host.chatRunId) {
    return;
  }
  const activeRunId = host.chatRunId;
  const item = host.chatQueue.find(
    (entry) => entry.id === id && !entry.pendingRunId && !entry.localCommandName,
  );
  if (!item) {
    return;
  }
  const message = item.text.trim();
  const attachments = item.attachments ?? [];
  const hasAttachments = attachments.length > 0;
  if (!message && !hasAttachments) {
    return;
  }

  host.chatQueue = host.chatQueue.map((entry) =>
    entry.id === id ? { ...entry, kind: "steered", pendingRunId: activeRunId } : entry,
  );
  const ack = await sendSteerChatMessage(
    host as unknown as ChatState,
    message,
    hasAttachments ? attachments : undefined,
  );
  if (!ack || isTerminalFailureChatSendAck(ack)) {
    host.chatQueue = host.chatQueue.map((entry) => (entry.id === id ? item : entry));
    if (isTerminalFailureChatSendAck(ack)) {
      setChatError(host, formatTerminalChatSendAckError(ack, "steer"));
    }
    return;
  }
  if (ack.status === "ok") {
    removeQueuedMessageWithoutReleasing(host, id, host.sessionKey);
  }
  releaseChatAttachmentPayloads(attachments);
  setLastActiveSessionKey(
    host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
    host.sessionKey,
  );
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
}

async function flushChatQueue(host: ChatHost) {
  if (!host.connected || isChatBusy(host)) {
    return;
  }
  const nextIndex = host.chatQueue.findIndex(
    (item) =>
      !item.pendingRunId &&
      item.sendState !== "sending" &&
      item.sendState !== "waiting-model" &&
      item.sendState !== "failed" &&
      (item.sessionKey == null || item.sessionKey === host.sessionKey),
  );
  if (nextIndex < 0) {
    return;
  }
  const next = host.chatQueue[nextIndex];
  let ok = false;
  try {
    if (next.localCommandName) {
      host.chatQueue = host.chatQueue.filter((_, index) => index !== nextIndex);
      await dispatchChatSlashCommand(host, next.localCommandName, next.localCommandArgs ?? "", {
        sendResetMessage: (message, resetOpts) => sendResetSlashCommand(host, message, resetOpts),
      });
      ok = true;
    } else {
      ok = await sendChatMessageNow(host, next.text, {
        queueItemId: next.id,
        attachments: next.attachments,
        refreshSessions: next.refreshSessions,
      });
    }
  } catch (err) {
    setChatError(host, String(err));
  }
  if (!ok && next.localCommandName) {
    host.chatQueue = [next, ...host.chatQueue];
  } else if (ok && host.chatQueue.length > 0) {
    // Continue draining — local commands don't block on server response
    void flushChatQueue(host);
  }
}

export async function retryReconnectableQueuedChatSends(host: ChatHost) {
  if (!host.connected || !host.client || host.chatSending) {
    return;
  }
  const sessionKeys = [
    host.sessionKey,
    ...Object.keys(host.chatQueueBySession ?? {}).filter(
      (sessionKey) => sessionKey !== host.sessionKey,
    ),
  ];
  for (const sessionKey of sessionKeys) {
    const item = readChatQueueForSession(host, sessionKey).find(
      (entry) =>
        entry.sendRunId &&
        entry.sendState === "waiting-reconnect" &&
        !entry.pendingRunId &&
        !entry.localCommandName,
    );
    if (!item) {
      continue;
    }
    await sendQueuedChatMessage(host, item.id, { allowBackgroundSession: true }, sessionKey);
    if (host.chatRunId) {
      return;
    }
  }
  if (!host.chatRunId) {
    void flushChatQueue(host);
  }
}

export async function retryQueuedChatMessage(host: ChatHost, id: string) {
  const item = host.chatQueue.find((entry) => entry.id === id);
  if (
    !item ||
    item.localCommandName ||
    item.pendingRunId ||
    item.sendState === "sending" ||
    item.sendState === "waiting-model"
  ) {
    return;
  }
  updateQueuedMessage(host, id, (entry) => ({
    ...entry,
    sendError: undefined,
    sendState: host.connected && host.client ? "sending" : "waiting-reconnect",
  }));
  await sendQueuedChatMessage(host, id);
  if (!host.chatRunId) {
    void flushChatQueue(host);
  }
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: ChatSendOptions,
) {
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  const submittedAtMs = controlUiNowMs();
  const submittedSessionKey = host.sessionKey;
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? snapshotChatAttachments(attachments) : [];
  const hasAttachments = attachmentsToSend.length > 0;
  const skillWorkshopRevision = opts?.skillWorkshopRevision;
  const shouldInterpretChatCommands = !skillWorkshopRevision;

  if (!message && !hasAttachments) {
    return;
  }

  if (messageOverride != null && opts?.confirmReset && !confirmChatResetCommand(message)) {
    return;
  }

  if (shouldInterpretChatCommands) {
    if (isChatStopCommand(message)) {
      if (messageOverride == null) {
        recordNonTranscriptInputHistory(host, message);
      }
      await handleAbortChat(host);
      return;
    }

    const parsed = parseSlashCommand(message);
    // The backend resolves /approve before active-run admission. Send it now so
    // the approval command cannot queue behind the run that is waiting for it.
    const shouldSendDetachedCommand =
      isBtwCommand(message) || (parsed?.command.key === "approve" && isChatBusy(host));
    if (shouldSendDetachedCommand) {
      const submitKey = chatSubmitKey(host, "detached", message, attachmentsToSend);
      await withChatSubmitGuard(host, submitKey, async () => {
        const pendingSettings = getPendingChatPickerPatch(host, submittedSessionKey);
        if (
          pendingSettings &&
          !(await waitForPendingChatSettings(host, submittedSessionKey, pendingSettings))
        ) {
          return;
        }
        if (host.sessionKey !== submittedSessionKey) {
          return;
        }
        const cleared =
          messageOverride == null
            ? clearSubmittedComposerState(host, previousDraft, attachmentsToSend)
            : {};
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, message);
        }
        await sendDetachedCommandMessage(host, message, {
          previousDraft: cleared.previousDraft,
          attachments: hasAttachments ? attachmentsToSend : undefined,
          previousAttachments: cleared.previousAttachments,
        });
      });
      return;
    }

    // Intercept local slash commands (/status, /model, /compact, etc.)
    if (parsed?.command.executeLocal) {
      if (isChatBusy(host) && shouldQueueLocalSlashCommand(parsed.command.key)) {
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, message);
          host.chatMessage = "";
          host.chatAttachments = [];
          resetChatInputHistoryNavigation(host);
        }
        enqueueChatMessage(host, message, undefined, isChatResetCommand(message), {
          args: parsed.args,
          name: parsed.command.key,
        });
        return;
      }
      const waitsForPicker = parsed.command.key === "redirect";
      const dispatchLocalCommand = async () => {
        if (waitsForPicker) {
          const pendingSettings = getPendingChatPickerPatch(host, submittedSessionKey);
          if (
            pendingSettings &&
            !(await waitForPendingChatSettings(host, submittedSessionKey, pendingSettings))
          ) {
            return;
          }
          if (host.sessionKey !== submittedSessionKey) {
            return;
          }
        }
        let prevDraft = messageOverride == null ? previousDraft : undefined;
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, message);
          if (waitsForPicker) {
            prevDraft = clearSubmittedComposerState(
              host,
              previousDraft,
              attachmentsToSend,
            ).previousDraft;
          } else {
            host.chatMessage = "";
            host.chatAttachments = [];
            resetChatInputHistoryNavigation(host);
          }
        }
        await dispatchChatSlashCommand(host, parsed.command.key, parsed.args, {
          previousDraft: prevDraft,
          restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
          sendResetMessage: (resetMessage, resetOpts) =>
            sendResetSlashCommand(host, resetMessage, resetOpts),
        });
      };
      if (waitsForPicker) {
        const submitKey = chatSubmitKey(host, "local", message, attachmentsToSend);
        await withChatSubmitGuard(host, submitKey, dispatchLocalCommand);
      } else {
        await dispatchLocalCommand();
      }
      return;
    }
  }

  const replyTarget = host.chatReplyTarget;
  const effectiveMessage = replyTarget ? prependReplyQuote(message, replyTarget) : message;

  const refreshSessions = shouldInterpretChatCommands && isChatResetCommand(message);
  const submitKey = chatSubmitKey(
    host,
    "message",
    effectiveMessage,
    attachmentsToSend,
    skillWorkshopRevision,
  );
  await withChatSubmitGuard(host, submitKey, async () => {
    if (host.sessionKey !== submittedSessionKey) {
      return;
    }
    const cleared =
      messageOverride == null
        ? clearSubmittedComposerState(host, previousDraft, attachmentsToSend)
        : {};
    if (messageOverride == null) {
      recordNonTranscriptInputHistory(host, message);
    }

    const waitingForSettings = getPendingChatPickerPatch(host, submittedSessionKey) !== undefined;
    const queued = enqueuePendingSendMessage(
      host,
      effectiveMessage,
      hasAttachments ? attachmentsToSend : undefined,
      refreshSessions,
      submittedAtMs,
      waitingForSettings ? "waiting-model" : undefined,
      skillWorkshopRevision,
    );
    if (!queued) {
      return;
    }

    const accepted = await sendChatMessageNow(host, effectiveMessage, {
      queueItemId: queued.id,
      previousDraft: cleared.previousDraft,
      restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
      attachments: hasAttachments ? attachmentsToSend : undefined,
      previousAttachments: cleared.previousAttachments,
      restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
      refreshSessions,
      submittedAtMs,
    });
    if (
      accepted &&
      replyTarget &&
      host.chatReplyTarget?.messageId === replyTarget.messageId &&
      host.sessionKey === submittedSessionKey
    ) {
      host.chatReplyTarget = null;
    }
  });
}

function prependReplyQuote(
  message: string,
  replyTarget: NonNullable<ChatHost["chatReplyTarget"]>,
): string {
  const label = escapeMarkdownInline(replyTarget.senderLabel ?? "User");
  const text = replyTarget.text.trim();
  if (!text.includes("\n")) {
    return `> **${label}:** ${text}\n\n${message}`;
  }
  const quoted = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> **${label}:**\n${quoted}\n\n${message}`;
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
}

export const flushChatQueueForEvent = flushChatQueue;
