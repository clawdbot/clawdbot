import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { scopedAgentIdForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type {
  QueuedChatSendOptions,
  QueuedChatSendResult,
  QueuedChatStorageMode,
} from "./chat-outbox-drain.ts";
import {
  keepVolatileQueuedMessage,
  readQueuedMessageById,
  updateQueuedMessageForSession,
  updateVolatileQueuedMessage,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { chatSendHoldReason, OFFLINE_QUEUE_STORAGE_ERROR } from "./chat-send-support.ts";
import { recordChatSendTiming, schedulePendingSendPaintTiming } from "./chat-send-timing.ts";
import { getPendingChatPickerPatch } from "./chat-session.ts";
import { storedChatOutboxScopeKey, type StoredChatOutboxScope } from "./composer-persistence.ts";
import { controlUiNowMs } from "./performance.ts";
import { hasDirectSessionRun, isChatBusy } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";

export function setChatError(
  host: { lastError?: string | null; chatError?: string | null },
  error: string | null,
) {
  const message = error === null ? null : formatUiError(error);
  host.lastError = message;
  host.chatError = message;
}

export function enqueuePendingSendMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
  submittedAtMs = controlUiNowMs(),
  sendState?: ChatQueueItem["sendState"],
  replyToId?: string,
  resumedOrderKey?: number,
  queueMode?: ChatQueueItem["queueMode"],
  intent?: ChatQueueItem["intent"],
  expectedLeafEntryId?: string | null,
): ChatQueueItem | null {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return null;
  }
  const sender = resolveCurrentUserIdentity(host.hello, host.client?.instanceId, host.selfUser);
  // A send that resumes an edited row inherits its place; the row itself is
  // retired by the write that admits this replacement, not here.
  const pending: ChatQueueItem = {
    id: generateUUID(),
    text: intent ? text : trimmed,
    createdAt: Date.now(),
    ...(resumedOrderKey !== undefined ? { orderKey: resumedOrderKey } : {}),
    attachments: hasAttachments ? attachments : undefined,
    refreshSessions,
    sendAttempts: 0,
    sendRunId: generateUUID(),
    sendState,
    ...(queueMode ? { queueMode } : {}),
    ...(intent
      ? { intent, ...(host.currentSessionId ? { sessionId: host.currentSessionId } : {}) }
      : {}),
    ...(intent && expectedLeafEntryId !== undefined ? { expectedLeafEntryId } : {}),
    sendSubmittedAtMs: submittedAtMs,
    sessionKey: host.sessionKey,
    agentId: scopedAgentIdForSession(host, host.sessionKey),
    ...(sender ? { sender } : {}),
    ...(replyToId ? { replyToId } : {}),
  };
  keepVolatileQueuedMessage(host, host.sessionKey, pending, pending.agentId);
  recordChatSendTiming(host, pending, "pending-visible", submittedAtMs);
  if (sendState === "waiting-model" || sendState === "waiting-reconnect") {
    recordChatSendTiming(host, pending, sendState, submittedAtMs);
  }
  schedulePendingSendPaintTiming(host, pending, submittedAtMs);
  scheduleChatScroll(host, true, false, {
    source: "manual",
  });
  return pending;
}

export function reconnectSafeQueuedSendState(
  host: Pick<ChatHost, "client" | "connected">,
): "waiting-idle" | "waiting-reconnect" {
  return host.connected && host.client ? "waiting-idle" : "waiting-reconnect";
}

export function captureChatConnectionOwner(
  host: Pick<ChatHost, "client" | "connected" | "connectionEpoch">,
  requireConnected = true,
): () => boolean {
  const client = host.client;
  const connectionEpoch = host.connectionEpoch;
  return () =>
    (!requireConnected || host.connected) &&
    host.client === client &&
    host.connectionEpoch === connectionEpoch;
}

export function updateQueuedSendItem(
  host: ChatHost,
  storageMode: QueuedChatStorageMode,
  sessionKey: string,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
): ChatQueueItem | null {
  return storageMode === "memory"
    ? updateVolatileQueuedMessage(host, id, update, { retryable: true })
    : updateQueuedMessageForSession(host, sessionKey, id, update);
}

export function deliveryStateWriter(
  host: ChatHost,
  storageMode: QueuedChatStorageMode,
  sessionKey: string,
  id: string,
) {
  return (sendState: ChatQueueItem["sendState"], sendError?: string) =>
    updateQueuedSendItem(host, storageMode, sessionKey, id, (item) => ({
      ...item,
      sendError,
      sendState,
    }));
}

export function finishChatDeliveryAdmission(
  host: ChatHost,
  item: ChatQueueItem,
  storageMode: QueuedChatStorageMode,
  queueSessionKey: string,
  options?: QueuedChatSendOptions,
): ChatQueueItem | QueuedChatSendResult {
  const route = options?.routingSessionKey ?? queueSessionKey;
  const setState = deliveryStateWriter(host, storageMode, queueSessionKey, item.id);
  const routeVisible = (agentId = item.agentId) =>
    host.sessionKey === route && visibleSessionMatches(host, route, agentId);
  const current = readQueuedMessageById(host, item.id);
  if (!current) {
    return "failed";
  }
  const sendsDuringActiveRun = Boolean(current.queueMode || options?.allowActiveRunSend);
  if (
    chatSendHoldReason(host, route) ||
    (options?.routingSessionKey && !routeVisible(current.agentId)) ||
    (!sendsDuringActiveRun &&
      routeVisible(current.agentId) &&
      (isChatBusy(host) || hasDirectSessionRun(host)))
  ) {
    const parked = setState(host.connected && host.client ? "waiting-idle" : "waiting-reconnect");
    if (!parked) {
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      return "failed";
    }
    return "pending";
  }
  return options?.routingSessionKey ? { ...current, sessionKey: route } : current;
}

export function canSendVolatileQueueItem(
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

export function finishScopedChatSending(host: ChatHost, scope: StoredChatOutboxScope): void {
  if (host.chatSendingScopeKey !== storedChatOutboxScopeKey(scope)) {
    return;
  }
  host.chatSendingScopeKey = null;
  host.chatSending = false;
}

export async function waitForPendingChatSettings(
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
