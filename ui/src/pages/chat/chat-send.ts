// Control UI module implements app chat behavior.
import { shouldForwardModelCommandToServer } from "../../../../src/auto-reply/commands-registry.shared.js";
import type { QueueMode } from "../../../../src/auto-reply/reply/queue/types.js";
import { isNonTerminalAgentRunStatus } from "../../../../src/shared/agent-run-status.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayHelloOk,
} from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import {
  normalizeChatFollowUpModeOverride,
  setLastActiveSessionKey,
  type ChatFollowUpMode,
} from "../../app/settings.ts";
import type {
  ChatAttachment,
  ChatQueueItem,
  ChatQueueSkillWorkshopRevision,
} from "../../lib/chat/chat-types.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import type { ControlUiFollowUpMode } from "../../lib/chat/follow-up-mode.ts";
import { extractSideQuestionDisplayText } from "../../lib/chat/side-question.ts";
import {
  retirePendingChatSideQuestion,
  type ChatSideResultPending,
} from "../../lib/chat/side-result.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
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
import { buildChatApiAttachments } from "./attachment-api.ts";
import {
  discardChatAttachmentDataUrls,
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  confirmConversationResetForCurrentSession,
  dispatchChatSlashCommand,
  type ChatCommandHost,
  type ChatCommandResetOptions,
  shouldQueueLocalSlashCommand,
} from "./chat-commands.ts";
import { loadChatHistory, type ChatHistoryResult, type ChatState } from "./chat-history.ts";
import {
  admitQueuedMessageForSession,
  enqueueChatMessage,
  excludeComposerAttachments,
  isVolatileQueuedMessage,
  readQueuedMessageById,
  removeQueuedMessageWithoutReleasing,
  removeVisibleOrScopedQueuedMessageWithoutReleasing,
  syncChatQueueFromStoredOutbox,
  updateQueuedMessage,
  updateQueuedMessageForSession,
  updateVolatileQueuedMessage,
} from "./chat-queue.ts";
import type { ChatRunStartupState } from "./chat-run-startup.ts";
import {
  isTerminalFailureChatSendAck,
  type ChatSendAck,
  type ChatSendAckServerTiming,
  type ChatSendTimingEntry,
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
  listStoredChatOutboxes,
  storedChatOutboxScopeKey,
  type StoredChatOutbox,
  type StoredChatOutboxScope,
} from "./composer-persistence.ts";
import { formatConnectError } from "./connect-error.ts";
import {
  recordNonTranscriptInputHistory,
  resetChatInputHistoryNavigation,
  type ChatInputHistoryState,
} from "./input-history.ts";
import { controlUiNowMs, roundedControlUiDurationMs } from "./performance.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";
import {
  handleAbortChat,
  hasAbortableSessionRun,
  isChatBusy,
  isChatStopCommand,
  reconcileChatRunLifecycle,
} from "./run-lifecycle.ts";
import { scheduleChatScroll, resetChatScroll } from "./scroll.ts";
import {
  formatTerminalChatSendAckError,
  chatMessagesContainQueuedSend,
  OFFLINE_QUEUE_STORAGE_ERROR,
  sendQueuedChatMessageWithQueueMode as sendQueuedChatMessageWithQueueModeLifecycle,
  steerQueuedChatMessage as steerQueuedChatMessageLifecycle,
  type SteerSendDependencies,
} from "./steer-lifecycle.ts";
import { isInflightSteer } from "./steered-chip.ts";
import { resetToolStream } from "./tool-stream.ts";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

export type ChatHost = ChatInputHistoryState &
  ChatCommandHost & {
    sessions: SessionCapability;
    client: GatewayBrowserClient | null;
    chatStream: string | null;
    connected: boolean;
    connectionEpoch?: number;
    chatAttachments: ChatAttachment[];
    chatQueue: ChatQueueItem[];
    chatQueueByScope?: Record<string, ChatQueueItem[]>;
    chatRunId: string | null;
    chatRunStartup?: ChatRunStartupState | null;
    chatRunUsageById?: Map<string, number>;
    chatSending: boolean;
    chatSendingScopeKey?: string | null;
    chatRunError?: { summary: string } | null;
    lastError?: string | null;
    chatError?: string | null;
    hello: GatewayHelloOk | null;
    renderLifecycle?: RenderLifecycle;
    requestUpdate?: () => void;
    refreshSessionsAfterChat: Map<string, SessionRefreshTarget>;
    chatSubmitGuards?: Map<string, Promise<void>>;
    chatSendTimingsByRun?: Map<string, ChatSendTimingEntry>;
    eventLogBuffer?: unknown[];
    assistantAgentId?: string | null;
    agentsList?: ChatAgentsListSnapshot | null;
    settings?: { chatFollowUpMode?: ChatFollowUpMode };
    /** Prepared from the browser override and current Gateway effective queue mode. */
    chatFollowUpMode?: ControlUiFollowUpMode;
    /** Selected message to reply to (right-click / keyboard shortcut). */
    chatReplyTarget?: {
      messageId: string;
      text: string;
      senderLabel?: string | null;
      sourceMessageId?: string | null;
    } | null;
    /** Placeholder for an in-flight /btw side question awaiting chat.side_result. */
    chatSideResultPending?: ChatSideResultPending | null;
    /** Retired/handled BTW run ids whose late events must not reach the transcript. */
    chatSideResultTerminalRuns?: Set<string>;
    /** Side-chat panel closed via X/Escape; a new question reopens it. */
    chatSideChatHidden?: boolean;
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
    routingSessionKey: host.sessionKey,
  }).then(() => undefined);
}

type ChatSendOptions = {
  confirmReset?: boolean;
  restoreDraft?: boolean;
  skillWorkshopRevision?: ChatQueueSkillWorkshopRevision;
  /** Side-chat follow-ups embed prior-turn context in the /btw command; the
   * pending turn must display the user's typed question instead. */
  sideQuestionDisplayText?: string;
  /** Lets the side-chat panel restore its typed follow-up when the detached
   * send is not accepted (the panel input is not a managed draft). */
  onSideQuestionSendRejected?: () => void;
  /** Lets request-scoped UI actions recover when their local slash command
   * fails before the Gateway accepts it. */
  onLocalCommandSendRejected?: () => void;
};

function normalizeAckTimingValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

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

async function requestChatSend(
  state: ChatState,
  params: {
    message: string;
    attachments?: ChatAttachment[];
    runId: string;
    sessionKey?: string;
    agentId?: string;
    queueMode?: QueueMode;
    replyToId?: string;
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
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    ...(params.queueMode ? { queueMode: params.queueMode } : {}),
    idempotencyKey: params.runId,
    attachments: buildChatApiAttachments(params.attachments),
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

async function requestSkillWorkshopRevisionChatSend(
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

async function sendChatMessageWithGeneratedRunId(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
  options: {
    canApplyError?: () => boolean;
    queueMode?: QueueMode;
    runId?: string;
  } = {},
): Promise<ChatSendAck | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }
  const canApplyError = options.canApplyError ?? (() => true);
  if (canApplyError()) {
    setChatError(state, null);
  }
  const runId = options.runId ?? generateUUID();
  try {
    return await requestChatSend(state, {
      message: msg,
      attachments,
      runId,
      ...(options.queueMode ? { queueMode: options.queueMode } : {}),
    });
  } catch (err) {
    if (canApplyError()) {
      setChatError(state, formatConnectError(err));
    }
    return null;
  }
}

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

function isBtwCommand(text: string) {
  return /^\/(?:btw|side)(?::|\s|$)/i.test(text.trim());
}

function enqueuePendingSendMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
  submittedAtMs = controlUiNowMs(),
  sendState?: ChatQueueItem["sendState"],
  skillWorkshopRevision?: ChatQueueSkillWorkshopRevision,
  replyToId?: string,
): ChatQueueItem | null {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return null;
  }
  const sender = resolveCurrentUserIdentity(host.hello, host.client?.instanceId);
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
    ...(sender ? { sender } : {}),
    ...(skillWorkshopRevision ? { skillWorkshopRevision } : {}),
    ...(replyToId ? { replyToId } : {}),
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

type PendingComposerSnapshot = {
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
};

function pendingComposerRestorePlan(host: ChatHost, snapshot: PendingComposerSnapshot) {
  const willRestoreDraft = snapshot.previousDraft != null && !host.chatMessage.trim();
  const willRestoreAttachments = Boolean(
    snapshot.previousAttachments?.length &&
    host.chatAttachments.length === 0 &&
    (willRestoreDraft || !host.chatMessage.trim()),
  );
  return {
    complete:
      (!snapshot.previousDraft?.trim() || willRestoreDraft) &&
      (!snapshot.previousAttachments?.length || willRestoreAttachments),
    willRestoreAttachments,
    willRestoreDraft,
  };
}

function cancelPendingSendBeforeRequest(
  host: ChatHost,
  queued: ChatQueueItem,
  opts: PendingComposerSnapshot & {
    restoreComposer?: boolean;
  },
) {
  const removed = removeVisibleOrScopedQueuedMessageWithoutReleasing(
    host,
    queued.id,
    queued.sessionKey,
  );
  const restoreComposer = opts.restoreComposer !== false && removed != null;
  const restorePlan = pendingComposerRestorePlan(host, opts);
  const willRestoreDraft = restoreComposer && restorePlan.willRestoreDraft;
  const willRestoreAttachments = restoreComposer && restorePlan.willRestoreAttachments;
  if (restoreComposer) {
    if (willRestoreDraft) {
      host.chatMessage = opts.previousDraft ?? "";
    }
    if (willRestoreAttachments) {
      host.chatAttachments = opts.previousAttachments ?? [];
    }
  }
  if (removed && !willRestoreAttachments) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  }
}

type QueuedChatSendResult = "sent" | "pending" | "failed";
type QueuedChatStorageMode = "durable" | "memory";
type QueuedChatSendOptions = {
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
  routingSessionKey?: string;
  storageMode?: QueuedChatStorageMode;
};

function reconnectSafeQueuedSendState(
  host: Pick<ChatHost, "client" | "connected">,
): "waiting-idle" | "waiting-reconnect" {
  return host.connected && host.client ? "waiting-idle" : "waiting-reconnect";
}

function updateQueuedSendItem(
  host: ChatHost,
  storageMode: QueuedChatStorageMode,
  sessionKey: string,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
): ChatQueueItem | null {
  return storageMode === "memory"
    ? updateVolatileQueuedMessage(host, id, update)
    : updateQueuedMessageForSession(host, sessionKey, id, update);
}

function canSendVolatileQueueItem(
  host: ChatHost,
  item: ChatQueueItem,
  routingSessionKey = item.sessionKey ?? host.sessionKey,
): boolean {
  return (
    host.connected &&
    Boolean(host.client) &&
    !isChatBusy(host) &&
    !getPendingChatPickerPatch(host, routingSessionKey, item.agentId) &&
    host.sessionKey === routingSessionKey &&
    visibleSessionMatches(host, routingSessionKey, item.agentId) &&
    host.chatQueue[0]?.id === item.id
  );
}

const UNCONFIRMED_CHAT_SEND_ERROR =
  "Delivery could not be confirmed after reconnect. Check the conversation before retrying.";
const UNCERTAIN_CLEAR_SUCCESSOR_ERROR =
  "A preceding /clear may have completed. Review the current conversation before retrying.";
const STORED_OUTBOX_RETRY_DEFAULT_MS = 500;
const STORED_OUTBOX_RETRY_MIN_MS = 100;
const STORED_OUTBOX_RETRY_MAX_MS = 30_000;

function finishScopedChatSending(host: ChatHost, scope: StoredChatOutboxScope): void {
  if (host.chatSendingScopeKey !== storedChatOutboxScopeKey(scope)) {
    return;
  }
  host.chatSendingScopeKey = null;
  host.chatSending = false;
}

function retryableGatewayDelayMs(err: unknown): number | null {
  if (!(err instanceof GatewayRequestError) || !err.retryable) {
    return null;
  }
  const requested = err.retryAfterMs ?? STORED_OUTBOX_RETRY_DEFAULT_MS;
  return Math.min(Math.max(requested, STORED_OUTBOX_RETRY_MIN_MS), STORED_OUTBOX_RETRY_MAX_MS);
}

async function sendQueuedChatMessage(
  host: ChatHost,
  id: string,
  opts?: QueuedChatSendOptions,
  queuedSessionKey = host.sessionKey,
): Promise<QueuedChatSendResult> {
  const storageMode = opts?.storageMode ?? "durable";
  let queued = readQueuedMessageById(host, id);
  if (!queued || queued.pendingRunId || queued.localCommandName) {
    return "failed";
  }
  // Foreground sends keep the submitted route for picker admission. Durable
  // storage may canonicalize an agent-main alias to its global outbox scope.
  const queueSessionKey = queued.sessionKey ?? queuedSessionKey;
  const pickerSessionKey = opts?.routingSessionKey ?? queueSessionKey;
  const pendingSettings = getPendingChatPickerPatch(host, pickerSessionKey, queued.agentId);
  if (pendingSettings) {
    // Final admission gate for retries/reconnect replays and picker patches
    // that start after the composer-level snapshot.
    updateQueuedSendItem(host, storageMode, queueSessionKey, id, (item) => ({
      ...item,
      sendError: undefined,
      sendState: "waiting-model",
    }));
    host.requestUpdate?.();
    if (
      !(await waitForPendingChatSettings(host, pickerSessionKey, pendingSettings, queued.agentId))
    ) {
      const canRestoreComposer =
        opts?.previousDraft !== undefined &&
        !host.chatMessage.trim() &&
        host.chatAttachments.length === 0;
      if (
        canRestoreComposer &&
        host.sessionKey === pickerSessionKey &&
        visibleSessionMatches(host, pickerSessionKey, queued.agentId)
      ) {
        cancelPendingSendBeforeRequest(host, queued, {
          previousDraft: opts.previousDraft,
          previousAttachments: opts.previousAttachments,
        });
      } else {
        updateQueuedSendItem(host, storageMode, queueSessionKey, id, (item) => ({
          ...item,
          sendError: INTERRUPTED_SETTINGS_WAIT_ERROR,
          sendState: "failed",
        }));
      }
      host.requestUpdate?.();
      return "failed";
    }
    queued = readQueuedMessageById(host, id);
    if (!queued) {
      return "failed";
    }
  }
  if (
    opts?.routingSessionKey &&
    (host.sessionKey !== opts.routingSessionKey ||
      !visibleSessionMatches(host, opts.routingSessionKey, queued.agentId))
  ) {
    const parked = updateQueuedSendItem(host, storageMode, queueSessionKey, id, (item) => ({
      ...item,
      sendError: undefined,
      sendState: host.connected && host.client ? "waiting-idle" : "waiting-reconnect",
    }));
    if (!parked) {
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    }
    return "pending";
  }
  const queuedForRoute = opts?.routingSessionKey
    ? { ...queued, sessionKey: opts.routingSessionKey }
    : queued;
  let prepared: ChatQueueItem | null = queuedForRoute;
  if (!prepared.sendRunId || !prepared.sendState) {
    const sessionKey = prepared.sessionKey ?? queuedSessionKey;
    const next: ChatQueueItem = {
      ...prepared,
      sendAttempts: prepared.sendAttempts ?? 0,
      sendRunId: prepared.sendRunId ?? generateUUID(),
      sendState: host.connected && host.client ? "sending" : "waiting-reconnect",
      sessionKey,
      agentId: prepared.agentId ?? scopedAgentIdForSession(host, sessionKey),
    };
    prepared = updateQueuedSendItem(host, storageMode, sessionKey, prepared.id, () => next);
  }
  if (!prepared) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return "pending";
  }
  const message = prepared.text.trim();
  const attachments = prepared.attachments ?? [];
  const hasAttachments = attachments.length > 0;
  if (!message && !hasAttachments) {
    removeQueuedMessageWithoutReleasing(host, id, prepared.sessionKey ?? host.sessionKey);
    return "sent";
  }
  if (prepared.skillWorkshopRevision && hasAttachments) {
    updateQueuedSendItem(host, storageMode, prepared.sessionKey ?? host.sessionKey, id, (item) => ({
      ...item,
      sendError: "Skill Workshop revision requests do not support attachments.",
      sendState: "failed",
    }));
    return "failed";
  }
  const sessionKey = prepared.sessionKey ?? host.sessionKey;
  if (!host.connected || !host.client) {
    const waiting = updateQueuedSendItem(host, storageMode, sessionKey, id, (item) => ({
      ...item,
      sendState: "waiting-reconnect",
      sendError: undefined,
    }));
    if (!waiting) {
      const hasComposerSnapshot =
        opts?.previousDraft !== undefined || opts?.previousAttachments !== undefined;
      const canRestoreComposer =
        hasComposerSnapshot && pendingComposerRestorePlan(host, opts ?? {}).complete;
      if (canRestoreComposer) {
        cancelPendingSendBeforeRequest(host, waiting ?? prepared, {
          previousDraft: opts?.previousDraft,
          previousAttachments: opts?.previousAttachments,
        });
      } else {
        updateQueuedSendItem(host, storageMode, sessionKey, id, (item) => ({
          ...item,
          sendError: OFFLINE_QUEUE_STORAGE_ERROR,
          sendState: "failed",
        }));
      }
      if (visibleSessionMatches(host, sessionKey, prepared.agentId)) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      }
      return canRestoreComposer ? "failed" : "pending";
    }
    return "pending";
  }

  const runId = prepared.sendRunId ?? generateUUID();
  const startedAt = Date.now();
  const requestStartedAtMs = controlUiNowMs();
  const sendingItem = updateQueuedSendItem(host, storageMode, sessionKey, id, (item) => ({
    ...item,
    sendAttempts: (item.sendAttempts ?? 0) + 1,
    sendError: undefined,
    sendRunId: runId,
    sendState: "sending",
    sendRequestStartedAtMs: requestStartedAtMs,
    sessionKey,
    agentId: prepared.agentId,
  }));
  if (!sendingItem) {
    if (visibleSessionMatches(host, sessionKey, prepared.agentId)) {
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    }
    return "pending";
  }
  registerChatSendTiming(host, sendingItem, runId, requestStartedAtMs);
  recordChatSendTiming(host, sendingItem, "request-start", sendingItem.sendSubmittedAtMs);
  const sendingScope: StoredChatOutboxScope = {
    sessionKey,
    ...(prepared.agentId ? { agentId: prepared.agentId } : {}),
  };
  if (visibleSessionMatches(host, sendingScope.sessionKey, sendingScope.agentId)) {
    host.chatSendingScopeKey = storedChatOutboxScopeKey(sendingScope);
    host.chatSending = true;
  }
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
          ...(prepared.replyToId ? { replyToId: prepared.replyToId } : {}),
        });
    updateChatSendAckTiming(host, runId, ack, sendingItem, requestStartedAtMs);
    recordChatSendTiming(host, sendingItem, "ack", sendingItem.sendSubmittedAtMs, {
      ackStatus: ack.status,
      requestDurationMs: roundedControlUiDurationMs(controlUiNowMs() - requestStartedAtMs),
      ...chatSendAckServerTimingEventFields(ack),
    });
    if (isTerminalFailureChatSendAck(ack)) {
      const error = formatTerminalChatSendAckError(ack, "chat");
      updateQueuedSendItem(host, storageMode, sessionKey, id, (item) => ({
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
    const retireOnAck = ack.status === "ok" || storageMode === "memory";
    if (retireOnAck) {
      removeQueuedMessageWithoutReleasing(host, id, sessionKey);
    }
    if (isVisibleSession()) {
      if (retireOnAck) {
        host.chatMessages = [
          ...host.chatMessages,
          {
            role: "user",
            content: buildUserChatMessageContentBlocks(
              message,
              hasAttachments ? attachments : undefined,
            ),
            timestamp: startedAt,
          },
        ];
      }
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
        const hasAlreadyAdoptedRun = host.chatRunId === ack.runId;
        const hasAlreadyAdoptedRunStream =
          hasAlreadyAdoptedRun && typeof host.chatStream === "string";
        host.chatRunId = ack.runId;
        if (!hasAlreadyAdoptedRun) {
          host.chatRunStartup = null;
        }
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
    return retireOnAck ? "sent" : "pending";
  } catch (err) {
    finishScopedChatSending(host, sendingScope);
    const error = formatConnectError(err);
    const recoverable =
      err instanceof GatewayRequestError
        ? err.retryable
        : /gateway (?:not connected|closed)|websocket|disconnected/i.test(error);
    if (recoverable) {
      const failedBeforeTransport =
        err instanceof Error &&
        !(err instanceof GatewayRequestError) &&
        err.message === "gateway not connected";
      const retryDelayMs = retryableGatewayDelayMs(err);
      const safelyRejected = failedBeforeTransport || retryDelayMs !== null;
      if (storageMode === "memory") {
        const hasComposerSnapshot =
          opts?.previousDraft !== undefined || opts?.previousAttachments !== undefined;
        const canRestoreSafely =
          hasComposerSnapshot &&
          safelyRejected &&
          pendingComposerRestorePlan(host, opts ?? {}).complete;
        if (canRestoreSafely) {
          cancelPendingSendBeforeRequest(host, prepared, {
            previousDraft: opts?.previousDraft,
            previousAttachments: opts?.previousAttachments,
          });
        } else {
          updateQueuedSendItem(host, storageMode, sessionKey, id, (item) => ({
            ...item,
            ...(safelyRejected
              ? {
                  sendAttempts: queued.sendAttempts,
                  sendRequestStartedAtMs: queued.sendRequestStartedAtMs,
                }
              : {}),
            sendError: safelyRejected ? error : UNCONFIRMED_CHAT_SEND_ERROR,
            sendState: safelyRejected ? "failed" : "unconfirmed",
          }));
        }
        if (isVisibleSession()) {
          setChatError(host, canRestoreSafely ? error : OFFLINE_QUEUE_STORAGE_ERROR);
        }
        recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, {
          error: canRestoreSafely ? error : OFFLINE_QUEUE_STORAGE_ERROR,
        });
        return canRestoreSafely ? "failed" : "pending";
      }
      const waiting = updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
        ...item,
        ...(safelyRejected
          ? {
              sendAttempts: queued.sendAttempts,
              sendRequestStartedAtMs: queued.sendRequestStartedAtMs,
            }
          : {}),
        sendError: error,
        sendState: "waiting-reconnect",
      }));
      if (!waiting) {
        const hasComposerSnapshot =
          opts?.previousDraft !== undefined || opts?.previousAttachments !== undefined;
        const canRestorePreTransport =
          hasComposerSnapshot &&
          failedBeforeTransport &&
          pendingComposerRestorePlan(host, opts ?? {}).complete;
        if (canRestorePreTransport) {
          cancelPendingSendBeforeRequest(host, waiting ?? prepared, {
            previousDraft: opts?.previousDraft,
            previousAttachments: opts?.previousAttachments,
          });
        } else {
          // The request may have reached the Gateway. Retain its run id so a
          // manual retry remains idempotent even when this tab cannot persist it.
          updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
            ...item,
            sendError: OFFLINE_QUEUE_STORAGE_ERROR,
            sendState: "failed",
          }));
        }
        if (isVisibleSession()) {
          setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        }
        recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, {
          error: OFFLINE_QUEUE_STORAGE_ERROR,
        });
        return canRestorePreTransport ? "failed" : "pending";
      }
      if (isVisibleSession()) {
        setChatError(
          host,
          retryDelayMs === null
            ? "Message will send when the Gateway reconnects."
            : "The Gateway asked us to retry this message shortly.",
        );
      }
      if (retryDelayMs !== null) {
        scheduleStoredChatOutboxRetry(
          host,
          { sessionKey, agentId: prepared.agentId },
          retryDelayMs,
        );
      }
      recordChatSendTiming(host, prepared, "waiting-reconnect", prepared.sendSubmittedAtMs, {
        error,
      });
      return "pending";
    }
    updateQueuedSendItem(host, storageMode, sessionKey, id, (item) => ({
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
    finishScopedChatSending(host, sendingScope);
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
    routingSessionKey?: string;
    storageMode?: QueuedChatStorageMode;
    submittedAtMs?: number;
  },
): Promise<QueuedChatSendResult> {
  const queued =
    opts?.queueItemId != null
      ? (host.chatQueue.find((item) => item.id === opts.queueItemId) ?? null)
      : enqueuePendingSendMessage(
          host,
          message,
          opts?.attachments,
          opts?.refreshSessions,
          opts?.submittedAtMs,
          reconnectSafeQueuedSendState(host),
        );
  if (!queued) {
    return "failed";
  }
  const queuedSessionKey = queued.sessionKey ?? host.sessionKey;
  if (opts?.queueItemId == null && !admitQueuedMessageForSession(host, queuedSessionKey, queued)) {
    cancelPendingSendBeforeRequest(host, queued, {
      previousDraft: opts?.previousDraft,
      previousAttachments: opts?.previousAttachments,
    });
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return "failed";
  }
  const storageMode = opts?.storageMode ?? "durable";
  let result: QueuedChatSendResult;
  if (storageMode === "memory") {
    result = await sendQueuedChatMessage(
      host,
      queued.id,
      {
        previousDraft: opts?.previousDraft,
        previousAttachments: opts?.previousAttachments,
        routingSessionKey: opts?.routingSessionKey ?? queuedSessionKey,
        storageMode,
      },
      queuedSessionKey,
    );
  } else {
    const queuedOutbox = listStoredChatOutboxes(host).find((outbox) =>
      outbox.queue.some((item) => item.id === queued.id),
    );
    if (!queuedOutbox) {
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      return "pending";
    }
    await scheduleStoredChatOutboxDrain(host, queuedOutbox, queued.id, {
      previousDraft: opts?.previousDraft,
      previousAttachments: opts?.previousAttachments,
      routingSessionKey: opts?.routingSessionKey ?? queuedSessionKey,
    });
    const storedItem = listStoredChatOutboxes(host)
      .flatMap((outbox) => outbox.queue)
      .find((item) => item.id === queued.id);
    result = !storedItem ? "sent" : storedItem.sendState === "failed" ? "failed" : "pending";
  }
  const sent = result === "sent";
  if (sent && host.sessionKey === queuedSessionKey) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      queuedSessionKey,
    );
    resetChatInputHistoryNavigation(host);
  }
  if (
    sent &&
    host.sessionKey === queuedSessionKey &&
    opts?.restoreDraft &&
    opts.previousDraft?.trim()
  ) {
    host.chatMessage = opts.previousDraft;
  }
  if (
    sent &&
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
  if (sent && host.sessionKey === queuedSessionKey && !host.chatRunId) {
    void flushChatQueue(host);
  }
  return result;
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
    host.chatAttachments.every((attachment, index) => {
      const submitted = submittedAttachments[index];
      return (
        submitted !== undefined &&
        attachmentSubmitSignature(attachment) === attachmentSubmitSignature(submitted)
      );
    });
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
    runId?: string;
  },
) {
  const ack = await sendChatMessageWithGeneratedRunId(
    host as unknown as ChatState,
    message,
    opts?.attachments,
    { runId: opts?.runId },
  );
  const ok = ack?.status === "ok" || ack?.status === "started" || ack?.status === "in_flight";
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
  return ack;
}

const steerSendDependencies: SteerSendDependencies = {
  loadChatHistory: (host) => void loadChatHistory(host as unknown as ChatState),
  resumeRestoredOutbox: (host, itemId) => {
    const restoredOutbox = listStoredChatOutboxes(host).find((outbox) =>
      outbox.queue.some((item) => item.id === itemId),
    );
    if (!host.chatRunId && restoredOutbox) {
      void scheduleStoredChatOutboxDrain(host as ChatHost, restoredOutbox);
    }
  },
  sendChatMessage: (host, message, attachments, options) =>
    sendChatMessageWithGeneratedRunId(host as unknown as ChatState, message, attachments, options),
};

export function steerQueuedChatMessage(host: ChatHost, id: string) {
  return steerQueuedChatMessageLifecycle(host, id, steerSendDependencies);
}

type StoredChatOutboxDrainResult = "blocked" | "empty";
type StoredChatOutboxDrainLane = {
  freshAdmissions: Set<string>;
  host: ChatHost;
  pendingOptions: Map<string, QueuedChatSendOptions>;
  promise: Promise<void>;
  rerun: boolean;
};

const storedChatOutboxDrainLanesByClient = new WeakMap<
  GatewayBrowserClient,
  Map<string, StoredChatOutboxDrainLane>
>();
const storedChatOutboxRetryTimersByClient = new WeakMap<
  GatewayBrowserClient,
  Map<string, ReturnType<typeof setTimeout>>
>();

function storedChatOutboxClientMap<T>(
  store: WeakMap<GatewayBrowserClient, Map<string, T>>,
  client: GatewayBrowserClient,
): Map<string, T> {
  const existing = store.get(client);
  if (existing) {
    return existing;
  }
  const created = new Map<string, T>();
  store.set(client, created);
  return created;
}

function scheduleStoredChatOutboxRetry(
  host: ChatHost,
  scope: StoredChatOutboxScope,
  delayMs: number,
) {
  const client = host.client;
  if (!host.connected || !client) {
    return;
  }
  const connectionEpoch = host.connectionEpoch;
  const timers = storedChatOutboxClientMap(storedChatOutboxRetryTimersByClient, client);
  const key = storedChatOutboxScopeKey(scope);
  if (timers.has(key)) {
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(key);
    if (host.connected && host.client === client && host.connectionEpoch === connectionEpoch) {
      void scheduleStoredChatOutboxDrain(host, scope);
    }
  }, delayMs);
  timers.set(key, timer);
}

function readStoredChatOutbox(
  host: ChatHost,
  scope: StoredChatOutboxScope,
): StoredChatOutbox | undefined {
  return listStoredChatOutboxes(host).find(
    (outbox) => outbox.sessionKey === scope.sessionKey && outbox.agentId === scope.agentId,
  );
}

function sameQueuedDeliveryVersion(left: ChatQueueItem, right: ChatQueueItem): boolean {
  return (
    left.id === right.id &&
    left.sendRunId === right.sendRunId &&
    left.sendAttempts === right.sendAttempts &&
    left.sendState === right.sendState &&
    left.agentId === right.agentId &&
    left.sessionKey === right.sessionKey
  );
}

async function readCurrentStoredChatHistory(
  host: ChatHost,
  outbox: StoredChatOutbox,
  item: ChatQueueItem,
  client: NonNullable<ChatHost["client"]>,
  connectionEpoch: number | undefined,
): Promise<ChatHistoryResult | "blocked" | "continue"> {
  let history: ChatHistoryResult;
  try {
    history = await client.request<ChatHistoryResult>("chat.history", {
      sessionKey: outbox.sessionKey,
      ...(isUiGlobalSessionKey(outbox.sessionKey) && outbox.agentId
        ? { agentId: outbox.agentId }
        : {}),
      limit: 1000,
    });
  } catch (err) {
    const retryDelayMs = retryableGatewayDelayMs(err);
    if (
      retryDelayMs !== null &&
      host.client === client &&
      host.connectionEpoch === connectionEpoch &&
      host.connected
    ) {
      scheduleStoredChatOutboxRetry(host, outbox, retryDelayMs);
    }
    return "blocked";
  }
  const currentOutbox = readStoredChatOutbox(host, outbox);
  const currentItem = currentOutbox?.queue.find((entry) => entry.id === item.id);
  if (host.client !== client || host.connectionEpoch !== connectionEpoch || !host.connected) {
    return "blocked";
  }
  if (!currentOutbox || !currentItem || !sameQueuedDeliveryVersion(currentItem, item)) {
    return "continue";
  }
  syncChatQueueFromStoredOutbox(host, currentOutbox);
  if (chatMessagesContainQueuedSend(history.messages, item)) {
    const removed = removeQueuedMessageWithoutReleasing(host, item.id, outbox.sessionKey);
    if (!removed) {
      return "blocked";
    }
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
    if (visibleSessionMatches(host, outbox.sessionKey, outbox.agentId)) {
      void loadChatHistory(host as unknown as ChatState);
    }
    return "continue";
  }
  if (
    !history.sessionInfo ||
    history.sessionInfo.hasActiveRun === true ||
    isSessionRunActive(history.sessionInfo)
  ) {
    return "blocked";
  }
  return history;
}

async function reconcileStoredChatOutboxHead(
  host: ChatHost,
  outbox: StoredChatOutbox,
  item: ChatQueueItem,
): Promise<"blocked" | "continue" | "send"> {
  const client = host.client;
  const connectionEpoch = host.connectionEpoch;
  if (!client || !host.connected) {
    return "blocked";
  }
  const history = await readCurrentStoredChatHistory(host, outbox, item, client, connectionEpoch);
  if (history === "blocked" || history === "continue") {
    return history;
  }
  if (visibleSessionMatches(host, outbox.sessionKey, outbox.agentId) && isChatBusy(host)) {
    return "blocked";
  }
  if ((item.sendAttempts ?? 0) > 0) {
    // History messages and active-run metadata are not captured atomically.
    // Re-read after the first idle snapshot before classifying delivery as unknown.
    const verifiedHistory = await readCurrentStoredChatHistory(
      host,
      outbox,
      item,
      client,
      connectionEpoch,
    );
    if (verifiedHistory === "blocked" || verifiedHistory === "continue") {
      return verifiedHistory;
    }
    const parked = updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
      ...entry,
      sendError: UNCONFIRMED_CHAT_SEND_ERROR,
      sendState: "unconfirmed",
    }));
    if (parked && visibleSessionMatches(host, outbox.sessionKey, outbox.agentId)) {
      setChatError(host, UNCONFIRMED_CHAT_SEND_ERROR);
    }
    return "blocked";
  }
  return "send";
}

async function drainStoredChatOutbox(
  lane: StoredChatOutboxDrainLane,
  scope: StoredChatOutboxScope,
): Promise<StoredChatOutboxDrainResult> {
  while (true) {
    const host = lane.host;
    if (!host.connected || !host.client) {
      return "blocked";
    }
    const outbox = readStoredChatOutbox(host, scope);
    if (!outbox) {
      return "empty";
    }
    // Failed non-command rows are skipped; a failed command may have changed
    // session state before reporting an error, so it blocks the drain and
    // preserves FIFO until the user explicitly retries or removes it.
    let item: ChatQueueItem | undefined;
    for (const entry of outbox.queue) {
      if (entry.sendState !== "failed") {
        item = entry;
        break;
      }
      if (entry.localCommandName) {
        break;
      }
    }
    if (!item) {
      return "empty";
    }
    if (item.sendState === "unconfirmed" || item.sendState === "waiting-model") {
      syncChatQueueFromStoredOutbox(host, outbox);
      return "blocked";
    }
    const visible = visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
    if (item.localCommandName) {
      if (!visible || isChatBusy(host)) {
        lane.freshAdmissions.delete(item.id);
        lane.pendingOptions.delete(item.id);
        return "blocked";
      }
      syncChatQueueFromStoredOutbox(host, outbox);
      if (item.localCommandName === "reset") {
        const resetText = item.localCommandArgs ? `/reset ${item.localCommandArgs}` : "/reset";
        const convertResetToMessage = (sendState?: ChatQueueItem["sendState"]) =>
          updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
            ...entry,
            localCommandArgs: undefined,
            localCommandName: undefined,
            refreshSessions: true,
            text: resetText,
            ...(sendState ? { sendState } : {}),
          }));
        const confirmation = await confirmConversationResetForCurrentSession(host, {
          sessionKey: outbox.sessionKey,
          ...(outbox.agentId ? { agentId: outbox.agentId } : {}),
        });
        if (confirmation === "deferred") {
          const approvedDuringRun =
            visibleSessionMatches(host, outbox.sessionKey, outbox.agentId) && host.chatRunId;
          const deferred = approvedDuringRun
            ? convertResetToMessage("waiting-idle")
            : updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
                ...entry,
                sendError: undefined,
                sendState: "waiting-idle",
              }));
          if (!deferred) {
            return "blocked";
          }
          return "blocked";
        }
        if (confirmation === "cancelled") {
          if (!removeQueuedMessageWithoutReleasing(host, item.id, outbox.sessionKey)) {
            return "blocked";
          }
          continue;
        }
        const converted = convertResetToMessage();
        if (!converted) {
          return "blocked";
        }
        continue;
      }
      // This token exists only in the live drain that admitted the row. Consume
      // it before command execution so a manual retry cannot inherit it.
      const freshAdmission = lane.freshAdmissions.delete(item.id);
      lane.pendingOptions.delete(item.id);
      if (!freshAdmission) {
        const reconciled = await reconcileStoredChatOutboxHead(host, outbox, item);
        if (reconciled === "blocked") {
          return "blocked";
        }
        if (reconciled === "continue") {
          continue;
        }
      }
      // Claim in place before executing. This preserves FIFO on command failure
      // and leaves a manual-review marker if the page disappears mid-command.
      const claimed = updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
        ...entry,
        sendError: undefined,
        sendState: "executing-command",
      }));
      if (!claimed) {
        return "blocked";
      }
      const commandClient = host.client;
      const commandConnectionEpoch = host.connectionEpoch;
      const commandScopeIsCurrent = () =>
        host.connected &&
        host.client === commandClient &&
        host.connectionEpoch === commandConnectionEpoch &&
        visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
      try {
        const dispatchResult = await dispatchChatSlashCommand(
          host,
          claimed.localCommandName ?? item.localCommandName,
          claimed.localCommandArgs ?? "",
          {
            sendResetMessage: (message, resetOpts) =>
              sendResetSlashCommand(host, message, resetOpts),
          },
        );
        if (dispatchResult === "deferred") {
          updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
            ...entry,
            sendError: undefined,
            sendState: "waiting-idle",
          }));
          return "blocked";
        }
        if (dispatchResult === "failed") {
          const commandStillCurrent = commandScopeIsCurrent();
          const error =
            (commandStillCurrent ? host.lastError : null) ??
            `Command /${item.localCommandName} failed.`;
          if (
            !updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
              ...entry,
              sendError: error,
              sendState: "failed",
            }))
          ) {
            if (commandStillCurrent) {
              setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
            }
          }
          return "blocked";
        }
        if (dispatchResult === "uncertain") {
          const currentOutbox = readStoredChatOutbox(host, outbox);
          const currentIndex =
            currentOutbox?.queue.findIndex((entry) => entry.id === item.id) ?? -1;
          const successor = currentIndex >= 0 ? currentOutbox?.queue[currentIndex + 1] : undefined;
          if (
            successor &&
            !updateQueuedMessageForSession(
              host,
              outbox.sessionKey,
              successor.id,
              (entry) => ({
                ...entry,
                sendError: UNCERTAIN_CLEAR_SUCCESSOR_ERROR,
                sendState: "unconfirmed",
              }),
              outbox.agentId,
            )
          ) {
            setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
            // If the successor barrier cannot be made durable, keep the
            // claimed clear row. Its persisted executing-command projection
            // is unconfirmed, which safely blocks this lane after reload.
            return "blocked";
          }
        }
        if (!removeQueuedMessageWithoutReleasing(host, item.id, outbox.sessionKey)) {
          if (commandScopeIsCurrent()) {
            setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
          }
          return "blocked";
        }
        if (dispatchResult === "uncertain") {
          // The destructive command itself is consumed. An unconfirmed
          // successor is the durable manual-review barrier for this FIFO lane.
          return "blocked";
        }
        if (commandScopeIsCurrent()) {
          setChatError(host, null);
        }
      } catch (err) {
        const commandStillCurrent = commandScopeIsCurrent();
        if (
          !updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
            ...entry,
            sendError: String(err),
            sendState: "failed",
          }))
        ) {
          if (commandStillCurrent) {
            setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
          }
          return "blocked";
        }
        if (commandStillCurrent) {
          setChatError(host, String(err));
        }
        return "blocked";
      }
      continue;
    }
    if (isUiGlobalSessionKey(outbox.sessionKey) && !outbox.agentId) {
      lane.freshAdmissions.delete(item.id);
      lane.pendingOptions.delete(item.id);
      return "blocked";
    }
    // Consume fresh provenance before any await. A restored or deferred row
    // has no token and must reconcile Gateway history before transport.
    const freshAdmission = lane.freshAdmissions.delete(item.id);
    const pendingOptions = lane.pendingOptions.get(item.id);
    lane.pendingOptions.delete(item.id);
    const needsHistory = !freshAdmission;
    if (needsHistory) {
      const reconciled = await reconcileStoredChatOutboxHead(host, outbox, item);
      if (reconciled === "blocked") {
        return "blocked";
      }
      if (reconciled === "continue") {
        continue;
      }
    }
    if (visible && isChatBusy(host)) {
      syncChatQueueFromStoredOutbox(host, outbox);
      updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
        ...entry,
        sendState: host.connected && host.client ? "waiting-idle" : "waiting-reconnect",
      }));
      return "blocked";
    }
    const currentOutbox = readStoredChatOutbox(host, scope);
    const currentItem = currentOutbox?.queue.find((entry) => entry.id === item.id);
    if (!currentOutbox || !currentItem || !sameQueuedDeliveryVersion(currentItem, item)) {
      continue;
    }
    syncChatQueueFromStoredOutbox(host, currentOutbox);
    const result = await sendQueuedChatMessage(host, item.id, pendingOptions, outbox.sessionKey);
    if (result === "pending") {
      // A pending ACK/reconnect state owns the next wakeup. Any rerun requested
      // while this RPC was in flight is already reflected in the durable queue.
      lane.rerun = false;
      return "blocked";
    }
    if (result === "failed") {
      continue;
    }
  }
}

async function scheduleStoredChatOutboxDrain(
  host: ChatHost,
  scope: StoredChatOutboxScope,
  itemId?: string,
  options?: QueuedChatSendOptions,
): Promise<void> {
  const client = host.client;
  if (!host.connected || !client) {
    return;
  }
  const key = storedChatOutboxScopeKey(scope);
  const retryTimers = storedChatOutboxRetryTimersByClient.get(client);
  const retryTimer = retryTimers?.get(key);
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer);
    retryTimers?.delete(key);
  }
  // Drain ownership follows the live gateway client. A disconnected client can
  // leave an RPC pending, but its lane must never capture a replacement client.
  const lanes = storedChatOutboxClientMap(storedChatOutboxDrainLanesByClient, client);
  const existing = lanes.get(key);
  if (existing) {
    const existingHostOwnsScope =
      existing.host.connected &&
      existing.host.client === client &&
      visibleSessionMatches(existing.host, scope.sessionKey, scope.agentId);
    const candidateOwnsScope = visibleSessionMatches(host, scope.sessionKey, scope.agentId);
    // Local commands need the visible pane's session-bound UI state. Keep that
    // owner while connected; an inactive split pane may still request a rerun.
    if (!existingHostOwnsScope && candidateOwnsScope) {
      existing.host = host;
    } else if (!existing.host.connected || existing.host.client !== client) {
      existing.host = host;
    }
    existing.rerun = true;
    if (itemId && options) {
      existing.pendingOptions.set(itemId, options);
    }
    if (itemId) {
      existing.freshAdmissions.add(itemId);
    }
    await existing.promise;
    return;
  }
  let resolveLane!: () => void;
  let rejectLane!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveLane = resolve;
    rejectLane = reject;
  });
  const lane: StoredChatOutboxDrainLane = {
    freshAdmissions: new Set(itemId ? [itemId] : []),
    host,
    pendingOptions: new Map(itemId && options ? [[itemId, options]] : []),
    promise,
    rerun: false,
  };
  lanes.set(key, lane);
  void (async () => {
    do {
      lane.rerun = false;
      await drainStoredChatOutbox(lane, scope);
    } while (lane.rerun);
  })().then(resolveLane, rejectLane);
  try {
    await lane.promise;
  } finally {
    if (lanes.get(key) === lane) {
      lanes.delete(key);
    }
  }
}

export async function resumeStoredChatOutboxes(host: ChatHost) {
  if (!host.connected || !host.client) {
    return;
  }
  await Promise.allSettled(
    listStoredChatOutboxes(host).map((outbox) => scheduleStoredChatOutboxDrain(host, outbox)),
  );
}

async function flushChatQueue(host: ChatHost) {
  const outbox = listStoredChatOutboxes(host).find((candidate) =>
    visibleSessionMatches(host, candidate.sessionKey, candidate.agentId),
  );
  if (outbox) {
    await scheduleStoredChatOutboxDrain(host, outbox);
  }
}

export async function retryReconnectableQueuedChatSends(host: ChatHost) {
  await resumeStoredChatOutboxes(host);
}

export async function retryQueuedChatMessage(host: ChatHost, id: string) {
  const item = host.chatQueue.find((entry) => entry.id === id);
  if (
    !item ||
    item.pendingRunId ||
    item.sendState === "executing-command" ||
    isInflightSteer(item) ||
    item.sendState === "sending" ||
    item.sendState === "waiting-model"
  ) {
    return;
  }
  let outbox = listStoredChatOutboxes(host).find((candidate) =>
    candidate.queue.some((entry) => entry.id === item.id),
  );
  if (!outbox) {
    const wasVolatile = isVolatileQueuedMessage(host, item.id);
    if (!admitQueuedMessageForSession(host, item.sessionKey ?? host.sessionKey, item)) {
      if (
        wasVolatile &&
        !item.localCommandName &&
        item.sendRunId &&
        (item.sendState === "failed" || item.sendState === "unconfirmed") &&
        canSendVolatileQueueItem(host, item)
      ) {
        const retry = updateVolatileQueuedMessage(host, id, (entry) => ({
          ...entry,
          sendAttempts: 0,
          sendError: undefined,
          sendRunId: entry.sendState === "failed" ? generateUUID() : entry.sendRunId,
          sendState: undefined,
        }));
        if (!retry) {
          setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
          return;
        }
        await sendQueuedChatMessage(
          host,
          retry.id,
          {
            routingSessionKey: retry.sessionKey ?? host.sessionKey,
            storageMode: "memory",
          },
          retry.sessionKey ?? host.sessionKey,
        );
        return;
      }
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      return;
    }
    outbox = listStoredChatOutboxes(host).find((candidate) =>
      candidate.queue.some((entry) => entry.id === item.id),
    );
  }
  if (!outbox) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  const retry = updateQueuedMessage(host, id, (entry) => ({
    ...entry,
    sendAttempts: 0,
    sendError: undefined,
    sendRunId: entry.sendState === "failed" ? generateUUID() : entry.sendRunId,
    sendState: reconnectSafeQueuedSendState(host),
  }));
  if (!retry) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  outbox = listStoredChatOutboxes(host).find((candidate) =>
    candidate.queue.some((entry) => entry.id === retry.id),
  );
  if (!outbox) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  const drain = scheduleStoredChatOutboxDrain(host, outbox);
  if (host.chatSending && host.chatSendingScopeKey === storedChatOutboxScopeKey(outbox)) {
    void drain;
    return;
  }
  await drain;
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

  if (
    messageOverride != null &&
    opts?.confirmReset &&
    isChatResetCommand(message) &&
    (typeof globalThis.confirm !== "function" ||
      !globalThis.confirm("Start a new thread? This will reset the current chat."))
  ) {
    return;
  }

  host.chatRunError = null;

  if (shouldInterpretChatCommands) {
    // Natural words such as "wait" and "exit" are stop aliases only while a
    // run exists. Keep the explicit /stop command available at any time.
    const shouldAbort =
      isChatStopCommand(message) &&
      (message.trim().startsWith("/") || hasAbortableSessionRun(host));
    if (shouldAbort) {
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
      // Covers every non-accepted path — early exits, guard dedupe, and
      // rejected acks — so the side-chat panel can restore its typed
      // follow-up even when no request was sent.
      let detachedSendAccepted = false;
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
        // BTW runs detached and delivers via chat.side_result only; show a
        // pending turn immediately so the send has visible feedback. The run
        // id is generated upfront so the turn is correlatable before the ack
        // returns.
        const btwPending = isBtwCommand(message)
          ? {
              question: opts?.sideQuestionDisplayText ?? extractSideQuestionDisplayText(message),
              ts: Date.now(),
              runId: generateUUID(),
            }
          : null;
        if (btwPending) {
          // The superseded run loses its pending record; retire it so its
          // late side_result/terminal events cannot reach the panel or the
          // transcript. Completed turns stay: the panel is a conversation.
          retirePendingChatSideQuestion(host);
          host.chatSideResultPending = btwPending;
          host.chatSideChatHidden = false;
          host.requestUpdate?.();
        }
        const ack = await sendDetachedCommandMessage(host, message, {
          previousDraft: cleared.previousDraft,
          attachments: hasAttachments ? attachmentsToSend : undefined,
          previousAttachments: cleared.previousAttachments,
          runId: btwPending?.runId,
        });
        detachedSendAccepted =
          ack?.status === "ok" || ack?.status === "started" || ack?.status === "in_flight";
        // Touch only this send's card: a side_result (or a newer question)
        // may already have replaced it while the ack was in flight.
        if (btwPending && host.chatSideResultPending === btwPending && !detachedSendAccepted) {
          host.chatSideResultPending = null;
          host.requestUpdate?.();
        }
      });
      if (!detachedSendAccepted) {
        opts?.onSideQuestionSendRejected?.();
      }
      return;
    }

    // Intercept local slash commands (/status, /model, /compact, etc.)
    const forwardModelCommand =
      parsed?.command.key === "model" && shouldForwardModelCommandToServer(parsed.args);
    if (parsed?.command.executeLocal && !forwardModelCommand) {
      const shouldQueueCommand = shouldQueueLocalSlashCommand(parsed.command.key);
      if (shouldQueueCommand) {
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, message);
          host.chatMessage = "";
          resetChatInputHistoryNavigation(host);
        }
        const queued = enqueueChatMessage(
          host,
          message,
          undefined,
          isChatResetCommand(message),
          {
            args: parsed.args,
            name: parsed.command.key,
          },
          resolveCurrentUserIdentity(host.hello, host.client?.instanceId) ?? undefined,
        );
        if (queued) {
          queued.sendState = reconnectSafeQueuedSendState(host);
        }
        if (!queued) {
          return;
        }
        if (!admitQueuedMessageForSession(host, host.sessionKey, queued)) {
          removeQueuedMessageWithoutReleasing(host, queued.id);
          if (messageOverride == null) {
            host.chatMessage = previousDraft;
            host.chatAttachments = attachmentsToSend;
          }
          setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
          return;
        }
        if (host.connected && host.client && !isChatBusy(host)) {
          const outbox = listStoredChatOutboxes(host).find((candidate) =>
            candidate.queue.some((entry) => entry.id === queued.id),
          );
          if (outbox) {
            await scheduleStoredChatOutboxDrain(host, outbox, queued.id, {
              routingSessionKey: host.sessionKey,
            });
          }
        }
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
        const dispatchResult = await dispatchChatSlashCommand(
          host,
          parsed.command.key,
          parsed.args,
          {
            previousDraft: prevDraft,
            restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
            sendResetMessage: (resetMessage, resetOpts) =>
              sendResetSlashCommand(host, resetMessage, resetOpts),
          },
        );
        if (dispatchResult === "failed") {
          opts?.onLocalCommandSendRejected?.();
        }
        if (
          (dispatchResult === "failed" || dispatchResult === "cancelled") &&
          messageOverride == null
        ) {
          const restorePlan = pendingComposerRestorePlan(host, {
            previousAttachments: attachmentsToSend,
            previousDraft,
          });
          if (restorePlan.willRestoreDraft) {
            host.chatMessage = previousDraft;
          }
          if (restorePlan.willRestoreAttachments) {
            host.chatAttachments = attachmentsToSend;
          }
        }
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
  // Persisted transcript ids ride chat.send as replyToId so the Gateway can
  // hydrate reply context like Discord; synthetic ids fall back to a quote.
  const replyToId = replyTarget?.sourceMessageId?.trim() || undefined;
  const effectiveMessage =
    replyTarget && !replyToId ? prependReplyQuote(message, replyTarget) : message;

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

    const pendingSettings = getPendingChatPickerPatch(host, submittedSessionKey);
    const waitingForSettings = pendingSettings !== undefined;
    const initialSendState: ChatQueueItem["sendState"] = waitingForSettings
      ? "waiting-model"
      : reconnectSafeQueuedSendState(host);
    const queued = enqueuePendingSendMessage(
      host,
      effectiveMessage,
      hasAttachments ? attachmentsToSend : undefined,
      refreshSessions,
      submittedAtMs,
      initialSendState,
      skillWorkshopRevision,
      replyToId,
    );
    if (!queued) {
      return;
    }
    const admittedDurably = admitQueuedMessageForSession(host, submittedSessionKey, queued);
    const canSendFromMemory =
      !admittedDurably &&
      !waitingForSettings &&
      canSendVolatileQueueItem(host, queued, submittedSessionKey);
    if (!admittedDurably && !canSendFromMemory) {
      cancelPendingSendBeforeRequest(host, queued, {
        previousDraft: cleared.previousDraft,
        previousAttachments: cleared.previousAttachments,
      });
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      return;
    }

    if (
      pendingSettings &&
      !(await waitForPendingChatSettings(host, submittedSessionKey, pendingSettings))
    ) {
      const canRestoreComposer =
        cleared.previousDraft !== undefined &&
        !host.chatMessage.trim() &&
        host.chatAttachments.length === 0;
      const submittedScopeVisible =
        host.sessionKey === submittedSessionKey &&
        visibleSessionMatches(host, submittedSessionKey, queued.agentId);
      if (canRestoreComposer && submittedScopeVisible) {
        cancelPendingSendBeforeRequest(host, queued, {
          previousDraft: cleared.previousDraft,
          previousAttachments: cleared.previousAttachments,
        });
      } else {
        updateQueuedMessageForSession(host, submittedSessionKey, queued.id, (item) => ({
          ...item,
          sendError: INTERRUPTED_SETTINGS_WAIT_ERROR,
          sendState: "failed",
        }));
      }
      return;
    }
    if (waitingForSettings) {
      const ready = updateQueuedMessageForSession(host, submittedSessionKey, queued.id, (item) => ({
        ...item,
        sendError: undefined,
        sendState: reconnectSafeQueuedSendState(host),
      }));
      if (!ready) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        return;
      }
    }
    if (
      host.sessionKey !== submittedSessionKey ||
      !visibleSessionMatches(host, submittedSessionKey, queued.agentId)
    ) {
      const parked = updateQueuedMessageForSession(
        host,
        submittedSessionKey,
        queued.id,
        (item) => ({
          ...item,
          sendError: undefined,
          sendState: host.connected && host.client ? "waiting-idle" : "waiting-reconnect",
        }),
      );
      if (!parked) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        return;
      }
      const outbox = listStoredChatOutboxes(host).find((candidate) =>
        candidate.queue.some((item) => item.id === queued.id),
      );
      if (outbox) {
        await scheduleStoredChatOutboxDrain(host, outbox);
      }
      return;
    }

    let sendResult: QueuedChatSendResult;
    if (isChatBusy(host) || hasAbortableSessionRun(host)) {
      const pending = updateQueuedMessage(host, queued.id, (item) => ({
        ...item,
        sendError: undefined,
        sendState: host.connected && host.client ? "waiting-idle" : "waiting-reconnect",
      }));
      if (!pending) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        sendResult = "failed";
      } else {
        recordChatSendTiming(host, pending, "queued-busy", submittedAtMs);
        sendResult = "pending";
        // Inherited policy belongs to the Gateway: preserve steer, followup,
        // collect, and interrupt semantics. Browser-local queueing only applies
        // to an explicit browser override.
        const followUpMode =
          host.chatFollowUpMode ??
          normalizeChatFollowUpModeOverride(host.settings?.chatFollowUpMode);
        if (
          !skillWorkshopRevision &&
          followUpMode !== "queue" &&
          host.connected &&
          hasAbortableSessionRun(host)
        ) {
          void sendQueuedChatMessageWithQueueModeLifecycle(
            host,
            pending.id,
            followUpMode,
            steerSendDependencies,
          );
        }
      }
    } else {
      sendResult = await sendChatMessageNow(host, effectiveMessage, {
        queueItemId: queued.id,
        previousDraft: cleared.previousDraft,
        restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
        attachments: hasAttachments ? attachmentsToSend : undefined,
        previousAttachments: cleared.previousAttachments,
        restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
        refreshSessions,
        routingSessionKey: submittedSessionKey,
        storageMode: canSendFromMemory ? "memory" : "durable",
        submittedAtMs,
      });
    }
    if (
      sendResult !== "failed" &&
      replyTarget &&
      host.chatReplyTarget?.messageId === replyTarget.messageId &&
      host.sessionKey === submittedSessionKey
    ) {
      // A reconnect queue owns the quoted turn before the Gateway ACK. Consume
      // its reply target so later offline turns cannot reuse stale context.
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
