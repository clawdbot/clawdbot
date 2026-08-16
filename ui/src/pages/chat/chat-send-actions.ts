import { GatewayRequestError } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  chatQueueMovableSegments,
  compareChatQueueOrder,
  isMovableChatQueueItem,
  reorderChatQueueItems,
} from "../../lib/chat/chat-queue-order.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { loadChatBranches, loadChatHistory, type ChatState } from "./chat-history.ts";
import {
  flushStoredChatOutbox,
  resumeStoredChatOutboxes as resumeStoredChatOutboxesDrain,
  scheduleStoredChatOutboxDrain,
} from "./chat-outbox-drain.ts";
import {
  admitQueuedMessageForSession,
  isVolatileQueuedMessage,
  readChatQueueForScope,
  readQueuedMessageById,
  updateQueuedMessage,
  updateQueuedMessagesForSession,
  updateVolatileQueuedMessage,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { chatOutboxDrainDependencies, deliverChatQueueItem } from "./chat-send-delivery.ts";
import {
  canSendVolatileQueueItem,
  reconnectSafeQueuedSendState,
  setChatError,
} from "./chat-send-queue-state.ts";
import {
  isActiveLeafChangedError,
  requestChatSend,
  resolveDisplayedLeafEntryId,
} from "./chat-send-request.ts";
import { listStoredChatOutboxes, storedChatOutboxScopeKey } from "./composer-persistence.ts";
import { formatConnectError } from "./connect-error.ts";
import {
  isQueuedMessageBeingEdited,
  isQueuedMessageRetryBlocked,
  isQueuedMessageReorderBlocked,
  QUEUED_MESSAGE_RETRY_CONFLICT_ERROR,
  QUEUED_MESSAGE_REORDER_CONFLICT_ERROR,
} from "./queued-message-edit.ts";
import { hasAbortableSessionRun } from "./run-lifecycle.ts";
import {
  OFFLINE_QUEUE_STORAGE_ERROR,
  steerQueuedChatMessage as steerQueuedChatMessageLifecycle,
  type SteerSendDependencies,
} from "./steer-lifecycle.ts";
import { isInflightSteer } from "./steered-chip.ts";

function applyChatSendError(state: ChatState, err: unknown, canApplyError: () => boolean): string {
  const error = isActiveLeafChangedError(err)
    ? t("chat.sendErrors.activeLeafChanged")
    : formatConnectError(err);
  if (canApplyError()) {
    setChatError(state, error);
    if (isActiveLeafChangedError(err)) {
      void Promise.all([loadChatHistory(state), loadChatBranches(state)]);
    }
  }
  return error;
}

export async function sendChatMessageWithGeneratedRunId(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
  options: Partial<Parameters<SteerSendDependencies["sendChatMessage"]>[3]> = {},
) {
  const msg = message.trim();
  if (!state.client || !state.connected || (!msg && !attachments?.length)) {
    return null;
  }
  const canApplyError = options.canApplyError ?? (() => true);
  if (canApplyError()) {
    setChatError(state, null);
  }
  const runId = options.runId ?? generateUUID();
  // Direct sends fail closed on the authoritative leaf; restored drains omit it.
  const expectedLeafEntryId = resolveDisplayedLeafEntryId(state);
  try {
    return await requestChatSend(state, {
      message: msg,
      attachments,
      runId,
      ...(options.expectedLeafEntryId !== undefined
        ? { expectedLeafEntryId: options.expectedLeafEntryId }
        : expectedLeafEntryId !== undefined
          ? { expectedLeafEntryId }
          : {}),
      ...(options.expectedRunId ? { expectedRunId: options.expectedRunId } : {}),
      ...(options.queueMode ? { queueMode: options.queueMode } : {}),
      ...(options.replyToId ? { replyToId: options.replyToId } : {}),
    });
  } catch (err) {
    const error = applyChatSendError(state, err, canApplyError);
    return err instanceof GatewayRequestError ? { kind: "rejected" as const, error } : null;
  }
}

function findStoredOutbox(host: ChatHost, id: string) {
  return listStoredChatOutboxes(host).find(({ queue }) => queue.some((item) => item.id === id));
}

const resetRetryState = (
  entry: ChatQueueItem,
  sendState: ChatQueueItem["sendState"],
): ChatQueueItem => ({
  ...entry,
  sendAttempts: 0,
  sendError: undefined,
  sendRequestStartedAtMs: undefined,
  sendRunId: entry.sendState === "failed" ? generateUUID() : entry.sendRunId,
  sendState,
});

export const steerSendDependencies: SteerSendDependencies = {
  loadChatHistory: (host) => void loadChatHistory(host),
  resumeRestoredOutbox: (host, itemId) => {
    const restoredOutbox = findStoredOutbox(host as ChatHost, itemId);
    if (!host.chatRunId && restoredOutbox) {
      void scheduleStoredChatOutboxDrain(
        host as ChatHost,
        restoredOutbox,
        chatOutboxDrainDependencies,
      );
    }
  },
  sendChatMessage: (host, message, attachments, options) =>
    sendChatMessageWithGeneratedRunId(host, message, attachments, options),
};

export const steerQueuedChatMessage = (host: ChatHost, id: string) =>
  steerQueuedChatMessageLifecycle(host, id, steerSendDependencies);

export const resumeStoredChatOutboxes = (host: ChatHost) =>
  resumeStoredChatOutboxesDrain(host, chatOutboxDrainDependencies);

export const flushChatQueueForEvent = (host: ChatHost) =>
  flushStoredChatOutbox(host, chatOutboxDrainDependencies);

export const retryReconnectableQueuedChatSends = resumeStoredChatOutboxes;

/**
 * Moves a queued row to `toIndex` within its own movable segment. A locked row
 * ends that segment, so the move can never carry a message past work the drain
 * is still waiting on. Every changed row commits as one durable unit, so a
 * storage failure mid-permutation leaves the prior order intact instead of a
 * partially reshuffled queue.
 */
export type ChatQueueMoveResult = "moved" | "rejected" | "noop";

export function moveQueuedChatMessage(
  host: ChatHost,
  id: string,
  toIndex: number,
): ChatQueueMoveResult {
  const item = readQueuedMessageById(host, id);
  if (!item || !isMovableChatQueueItem(item)) {
    return "noop";
  }
  if (isQueuedMessageReorderBlocked(host, id)) {
    setChatError(host, QUEUED_MESSAGE_REORDER_CONFLICT_ERROR);
    return "rejected";
  }
  const sessionKey = item.sessionKey ?? host.sessionKey;
  const scope = readChatQueueForScope(host, sessionKey, item.agentId);
  const movableSegments = chatQueueMovableSegments(
    scope,
    (row) => isMovableChatQueueItem(row) && !isQueuedMessageBeingEdited(host, row.id),
  );
  const segment = movableSegments.find((rows) => rows.some((row) => row.id === id));
  const orderedScope = scope.toSorted(compareChatQueueOrder);
  const fromIndex = orderedScope.findIndex((row) => row.id === id);
  const targetIndex = Math.min(Math.max(toIndex, 0), orderedScope.length - 1);
  const crossesPeerEdit = orderedScope
    .slice(Math.min(fromIndex, targetIndex), Math.max(fromIndex, targetIndex) + 1)
    .some((row) => row.id !== id && isQueuedMessageBeingEdited(host, row.id));
  if (crossesPeerEdit) {
    setChatError(host, QUEUED_MESSAGE_REORDER_CONFLICT_ERROR);
    return "rejected";
  }
  const moves = reorderChatQueueItems(segment ?? [], id, toIndex);
  if (moves.length === 0) {
    return "noop";
  }
  const applied = updateQueuedMessagesForSession(
    host,
    moves.map((moved) => ({
      id: moved.id,
      update: (entry: ChatQueueItem) => ({ ...entry, orderKey: moved.orderKey }),
    })),
  );
  if (!applied) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return "rejected";
  }
  return "moved";
}

export async function retryQueuedChatMessage(host: ChatHost, id: string) {
  let item = host.chatQueue.find((entry) => entry.id === id);
  if (isQueuedMessageRetryBlocked(host, id)) {
    setChatError(host, QUEUED_MESSAGE_RETRY_CONFLICT_ERROR);
    return;
  }
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
  if (item.kind === "steered") {
    if (!host.connected || !host.client) {
      setChatError(host, t("chat.sendErrors.steerRunNoLongerActive"));
      return;
    }
    if (hasAbortableSessionRun(host)) {
      const retry = updateQueuedMessage(host, id, (entry) => ({
        ...entry,
        sendAttempts: 0,
        sendError: undefined,
        sendRequestStartedAtMs: undefined,
        sendState: "waiting-idle",
      }));
      if (!retry) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        return;
      }
      await steerQueuedChatMessageLifecycle(host, id, steerSendDependencies);
      return;
    }
    const converted = updateQueuedMessage(host, id, (entry) => {
      const {
        kind: _kind,
        pendingRunId: _pendingRunId,
        steerTargetRunId: _steerTargetRunId,
        ...queued
      } = entry;
      return resetRetryState(queued, reconnectSafeQueuedSendState(host));
    });
    if (!converted) {
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      return;
    }
    item = converted;
  }
  let outbox = findStoredOutbox(host, item.id);
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
        const retry = updateVolatileQueuedMessage(host, id, (entry) =>
          resetRetryState(entry, undefined),
        );
        if (!retry) {
          setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
          return;
        }
        await deliverChatQueueItem(host, retry, {
          routingSessionKey: retry.sessionKey ?? host.sessionKey,
          storageMode: "memory",
        });
        return;
      }
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      return;
    }
  }
  const retry = updateQueuedMessage(host, id, (entry) =>
    resetRetryState(entry, reconnectSafeQueuedSendState(host)),
  );
  if (!retry) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  outbox = findStoredOutbox(host, retry.id);
  if (!outbox) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  const drain = scheduleStoredChatOutboxDrain(host, outbox, chatOutboxDrainDependencies);
  if (host.chatSending && host.chatSendingScopeKey === storedChatOutboxScopeKey(outbox)) {
    void drain;
    return;
  }
  await drain;
  if (!host.chatRunId) {
    void flushStoredChatOutbox(host, chatOutboxDrainDependencies);
  }
}
