import type { QueueMode } from "../../../../src/auto-reply/reply/queue/types.js";
import type { SessionsListResult } from "../../api/types.ts";
import { setLastActiveSessionKey } from "../../app/settings.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  clearPendingQueueItemsForRun,
  clearTransientQueuedMessageProjection,
  excludeComposerAttachments,
  removeQueuedMessageWithoutReleasing,
  replacePendingQueuedMessageProjection,
  setTransientQueuedMessageProjection,
  type ChatQueueScopedSessionHost,
  updateQueuedMessage,
} from "./chat-queue.ts";
import {
  isTerminalFailureChatSendAck,
  type ChatSendAck,
  type TerminalFailureChatSendAck,
} from "./chat-send-contract.ts";
import { hasAbortableSessionRun } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import {
  appendChatMessageToCache,
  readChatMessagesFromCache,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import { ackSteeredChip, buildInflightSteerChip, isAckedSteeredChip } from "./steered-chip.ts";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

type SteerLifecycleHost = ChatQueueScopedSessionHost & {
  connected: boolean;
  chatRunId: string | null;
  chatMessages: unknown[];
  chatMessagesBySession?: ChatMessageCache;
  sessionsResult?: SessionsListResult | null;
  lastError?: string | null;
  chatError?: string | null;
};

export type SteerSendDependencies = {
  loadChatHistory: (host: SteerLifecycleHost) => void;
  resumeRestoredOutbox: (host: SteerLifecycleHost, itemId: string) => void;
  sendChatMessage: (
    host: SteerLifecycleHost,
    message: string,
    attachments: ChatAttachment[] | undefined,
    options: { canApplyError: () => boolean; queueMode?: QueueMode; runId: string },
  ) => Promise<ChatSendAck | null>;
};

export const OFFLINE_QUEUE_STORAGE_ERROR =
  "Could not store this message for reconnect. Free browser storage or reconnect before sending.";
const UNCONFIRMED_STEER_ERROR =
  "Steer delivery could not be confirmed. Check the active run before retrying.";
const UNCONFIRMED_FOLLOW_UP_ERROR =
  "Follow-up delivery could not be confirmed. Check the conversation before retrying.";

export function formatTerminalChatSendAckError(
  ack: TerminalFailureChatSendAck,
  context: "chat" | "detached" | "steer",
): string {
  return ack.status === "error"
    ? context === "steer"
      ? "Steer failed before it reached the run; try again."
      : "Chat failed before the run started; try again."
    : context === "detached"
      ? "The active run ended before the detached message was accepted."
      : context === "steer"
        ? "The active run ended before the steer message was accepted."
        : "The run ended before the message was accepted.";
}

export function chatMessagesContainQueuedSend(
  messages: unknown,
  item: ChatQueueItem,
  userRoleOnly = false,
): boolean {
  if (!item.sendRunId) {
    return false;
  }
  return (Array.isArray(messages) ? messages : []).some((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return false;
    }
    // Render retirement requires a user-role entry: an assistant entry can
    // carry the same run key without proving the queued turn is visible.
    const record = message as Record<string, unknown>;
    if (userRoleOnly && record.role !== "user") {
      return false;
    }
    const marker = record["__openclaw"];
    const markerIdempotencyKey =
      marker && typeof marker === "object" && !Array.isArray(marker)
        ? (marker as { idempotencyKey?: unknown }).idempotencyKey
        : undefined;
    const idempotencyKey = markerIdempotencyKey ?? record.idempotencyKey;
    return idempotencyKey === item.sendRunId || idempotencyKey === `${item.sendRunId}:user`;
  });
}

function durableDeliveredAttachments(
  attachments: readonly ChatAttachment[] | undefined,
): ChatAttachment[] | undefined {
  return attachments?.flatMap((attachment) => {
    // Composer uploads keep their bytes in the payload store; queue rows carry
    // metadata only. Resolve through the store or attachment-only turns
    // materialize empty and vanish at chip retirement.
    const dataUrl = getChatAttachmentDataUrl(attachment);
    if (!dataUrl) {
      return [];
    }
    // Terminal retirement releases the queue-owned live blob. Pin synthetic
    // transcript content to durable bytes before that ownership ends.
    return [{ ...attachment, dataUrl, previewUrl: dataUrl }];
  });
}

export function preserveQueuedUserTurn(state: SteerLifecycleHost, item: ChatQueueItem): void {
  const runId = item.sendRunId;
  const sessionKey = item.sessionKey ?? state.sessionKey;
  if (!runId) {
    return;
  }
  const content = buildUserChatMessageContentBlocks(
    item.text,
    durableDeliveredAttachments(item.attachments),
  );
  if (!content.length) {
    return;
  }
  const userMessage = {
    role: "user",
    content,
    timestamp: item.createdAt,
    __openclaw: { idempotencyKey: `${runId}:user` },
  };
  if (visibleSessionMatches(state, sessionKey, item.agentId)) {
    if (!chatMessagesContainQueuedSend(state.chatMessages, item, true)) {
      state.chatMessages = [...state.chatMessages, userMessage];
    }
    return;
  }
  if (!state.chatMessagesBySession) {
    return;
  }
  const target = { sessionKey, agentId: item.agentId };
  const cached = readChatMessagesFromCache(state.chatMessagesBySession, state, target);
  if (!chatMessagesContainQueuedSend(cached, item, true)) {
    appendChatMessageToCache(state.chatMessagesBySession, state, target, userMessage);
  }
}

export function retireSteeredChipsForTerminalRun(
  state: SteerLifecycleHost,
  runId: string | undefined,
): void {
  if (!runId) {
    return;
  }
  for (const item of state.chatQueue) {
    if (isAckedSteeredChip(item) && item.pendingRunId === runId) {
      preserveQueuedUserTurn(state, item);
    }
  }
  clearPendingQueueItemsForRun(state, runId);
}

export function retireHistoryProvenSteeredChips(state: SteerLifecycleHost): void {
  const retired = state.chatQueue.filter(
    (item) =>
      isAckedSteeredChip(item) && chatMessagesContainQueuedSend(state.chatMessages, item, true),
  );
  if (retired.length === 0) {
    return;
  }
  const retiredIds = new Set(retired.map((item) => item.id));
  state.chatQueue = state.chatQueue.filter((item) => !retiredIds.has(item.id));
  for (const item of retired) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(state, item.attachments));
  }
}

function setChatError(host: SteerLifecycleHost, error: string | null): void {
  host.lastError = error;
  host.chatError = error;
}

export async function sendQueuedChatMessageWithQueueMode(
  host: SteerLifecycleHost,
  id: string,
  queueMode: QueueMode | undefined,
  dependencies: SteerSendDependencies,
): Promise<void> {
  if (!host.connected || !hasAbortableSessionRun(host)) {
    return;
  }
  const isSteer = queueMode === "steer";
  const unconfirmedError = isSteer ? UNCONFIRMED_STEER_ERROR : UNCONFIRMED_FOLLOW_UP_ERROR;
  const activeRunId = host.chatRunId;
  const item = host.chatQueue.find(
    (entry) =>
      entry.id === id &&
      !entry.pendingRunId &&
      !entry.localCommandName &&
      (entry.sendState === undefined || entry.sendState === "waiting-idle"),
  );
  if (!item) {
    return;
  }
  const itemSessionKey = item.sessionKey ?? host.sessionKey;
  const message = item.text.trim();
  const attachments = item.attachments ?? [];
  if (!message && attachments.length === 0) {
    return;
  }

  // Claim the durable row before transport so a crash or ambiguous ACK cannot
  // replay the original queued turn after active-run admission may have succeeded.
  const claimed = updateQueuedMessage(host, id, (entry) => ({
    ...entry,
    sendError: unconfirmedError,
    sendRunId: entry.sendRunId ?? generateUUID(),
    sendState: "unconfirmed",
  }));
  if (!claimed?.sendRunId) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  const pendingItem: ChatQueueItem = {
    id: item.id,
    text: item.text,
    createdAt: item.createdAt,
    attachments: item.attachments,
    sendRunId: claimed.sendRunId,
    sessionKey: claimed.sessionKey,
    agentId: claimed.agentId,
  };
  const steeringChip = buildInflightSteerChip(pendingItem, claimed.sendRunId, activeRunId);
  const pendingIndicator = isSteer
    ? steeringChip
    : ({
        ...pendingItem,
        sendState: "sending",
      } satisfies ChatQueueItem);
  const transientProjection = isSteer
    ? buildInflightSteerChip({ ...claimed, sendError: undefined }, claimed.sendRunId)
    : { ...claimed, sendError: undefined, sendState: "sending" as const };
  if (
    !setTransientQueuedMessageProjection(host, itemSessionKey, transientProjection, item.agentId)
  ) {
    const restored = updateQueuedMessage(host, id, () => item);
    if (!restored) {
      host.chatQueue = host.chatQueue.map((entry) => (entry.id === id ? item : entry));
    }
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  host.chatQueue = host.chatQueue.map((entry) => (entry.id === id ? pendingIndicator : entry));
  const ack = await dependencies.sendChatMessage(
    host,
    message,
    attachments.length ? attachments : undefined,
    {
      canApplyError: () => visibleSessionMatches(host, itemSessionKey, item.agentId),
      ...(queueMode ? { queueMode } : {}),
      runId: claimed.sendRunId,
    },
  );
  if (isSteer && activeRunId) {
    replacePendingQueuedMessageProjection(
      host,
      itemSessionKey,
      id,
      activeRunId,
      claimed,
      item.agentId,
    );
  }
  clearTransientQueuedMessageProjection(host, itemSessionKey, id, item.agentId);
  const itemStillVisible = visibleSessionMatches(host, itemSessionKey, item.agentId);
  if (!ack) {
    // A transport failure does not prove active-run admission was rejected. Keep the
    // durable row parked so reconnect cannot replay it as a separate turn.
    if (itemStillVisible) {
      setChatError(host, unconfirmedError);
    }
    return;
  }
  if (isTerminalFailureChatSendAck(ack)) {
    const restored = updateQueuedMessage(host, id, (entry) => ({
      ...item,
      ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
    }));
    if (!restored) {
      if (itemStillVisible) {
        setChatError(host, unconfirmedError);
      }
    } else {
      if (itemStillVisible) {
        setChatError(host, formatTerminalChatSendAckError(ack, isSteer ? "steer" : "chat"));
      }
      dependencies.resumeRestoredOutbox(host, id);
    }
    return;
  }
  const removed = removeQueuedMessageWithoutReleasing(host, id, itemSessionKey, item.agentId);
  if (!removed) {
    if (itemStillVisible) {
      setChatError(host, unconfirmedError);
    }
    return;
  }
  const userTurnAlreadyVisible = chatMessagesContainQueuedSend(host.chatMessages, claimed, true);
  if (isSteer && ack.status === "ok") {
    preserveQueuedUserTurn(host, claimed);
    if (itemStillVisible) {
      dependencies.loadChatHistory(host);
    }
  }
  if (isSteer && ack.status !== "ok" && itemStillVisible && !userTurnAlreadyVisible) {
    // Key the chip to the run that will emit its terminal cleanup: the active
    // run when it still owns the tab, else the steer's own gateway lifecycle
    // (session-row-only runs, or the captured run ended mid-request).
    const chipRunId = activeRunId && host.chatRunId === activeRunId ? activeRunId : ack.runId;
    const steeredIndicator = ackSteeredChip(steeringChip, chipRunId);
    host.chatQueue = [
      ...host.chatQueue.filter((entry) => entry.id !== id),
      steeredIndicator,
    ].toSorted((left, right) => left.createdAt - right.createdAt);
  } else {
    releaseChatAttachmentPayloads(attachments);
  }
  if (itemStillVisible) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      itemSessionKey,
    );
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  }
}

export function steerQueuedChatMessage(
  host: SteerLifecycleHost,
  id: string,
  dependencies: SteerSendDependencies,
): Promise<void> {
  return sendQueuedChatMessageWithQueueMode(host, id, "steer", dependencies);
}
