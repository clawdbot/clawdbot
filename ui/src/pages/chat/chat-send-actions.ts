import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  chatQueueMovableSegments,
  isMovableChatQueueItem,
  reorderChatQueueItems,
} from "../../lib/chat/chat-queue-order.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { hasUiSessionDefaults } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { loadChatBranches } from "./chat-history-branches.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  flushStoredChatOutbox,
  resumeStoredChatOutboxes as resumeStoredChatOutboxesDrain,
  scheduleStoredChatOutboxDrain,
} from "./chat-outbox-drain.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import {
  admitQueuedMessageForSession,
  isVolatileQueuedMessage,
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
import { OFFLINE_QUEUE_STORAGE_ERROR } from "./chat-send-support.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { storedChatOutboxScopeKey } from "./composer-persistence.ts";
import { formatConnectError } from "./connect-error.ts";
import {
  activeQueuedMessageEdit,
  isQueuedMessageBeingEdited,
  QUEUED_MESSAGE_RETRY_CONFLICT_ERROR,
  QUEUED_MESSAGE_REORDER_CONFLICT_ERROR,
  QUEUED_MESSAGE_STEER_CONFLICT_ERROR,
} from "./queued-message-edit.ts";

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
  options: {
    canApplyError?: () => boolean;
    expectedLeafEntryId?: string | null;
    queueMode?: QueueMode;
    replyToId?: string;
    runId?: string;
  } = {},
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
      ...(options.queueMode !== "steer" && options.expectedLeafEntryId !== undefined
        ? { expectedLeafEntryId: options.expectedLeafEntryId }
        : options.queueMode !== "steer" && expectedLeafEntryId !== undefined
          ? { expectedLeafEntryId }
          : {}),
      ...(options.queueMode ? { queueMode: options.queueMode } : {}),
      ...(options.replyToId ? { replyToId: options.replyToId } : {}),
    });
  } catch (err) {
    const error = applyChatSendError(state, err, canApplyError);
    return err instanceof GatewayRequestError ? { kind: "rejected" as const, error } : null;
  }
}

const resetRetryState = (
  entry: ChatQueueItem,
  sendState: ChatQueueItem["sendState"],
): ChatQueueItem => {
  // An ID-less post-clear review barrier has no transport attempt to preserve.
  const uncertain =
    entry.sendState === "unconfirmed" && Boolean(entry.sendRunId) && !entry.localCommandName;
  return {
    ...entry,
    // Local payload failure cannot erase an uncertain transport attempt. Keep its
    // identity until the explicitly admitted retry actually reaches transport.
    sendAttempts: uncertain ? entry.sendAttempts : 0,
    // A failed delivery keeps its diagnostic while an explicit retry waits for
    // run admission; the transcript uses it to retain the same optimistic row.
    sendError: entry.sendState === "failed" ? entry.sendError : undefined,
    sendRequestStartedAtMs: uncertain ? entry.sendRequestStartedAtMs : undefined,
    sendRunId:
      entry.sendState === "failed" && entry.queueMode !== "steer" && !entry.intent
        ? generateUUID()
        : entry.sendRunId,
    sendState: uncertain ? "unconfirmed" : sendState,
  };
};

export async function steerQueuedChatMessage(host: ChatHost, id: string): Promise<void> {
  if (readQueuedMessageById(host, id)?.intent) {
    setChatError(host, t("chat.goals.admissionImmutable"));
    return;
  }
  if (isQueuedMessageBeingEdited(host, id)) {
    setChatError(host, QUEUED_MESSAGE_STEER_CONFLICT_ERROR);
    return;
  }
  const item = updateQueuedMessage(host, id, (entry) => ({ ...entry, queueMode: "steer" }));
  if (!item) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  await retryQueuedChatMessage(host, id);
}

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
type ChatQueueMoveResult = "moved" | "rejected" | "noop";

export function moveQueuedChatMessage(
  host: ChatHost,
  id: string,
  toIndex: number,
): ChatQueueMoveResult {
  const owner = chatOutboxOwner(host);
  const located = owner.locate(host, id);
  if (!located || !isMovableChatQueueItem(located.item)) {
    return "noop";
  }
  if (isQueuedMessageBeingEdited(host, id)) {
    setChatError(host, QUEUED_MESSAGE_REORDER_CONFLICT_ERROR);
    return "rejected";
  }
  const scope = owner.snapshot(host, located.scope);
  // This pane already excludes its own edited row from rendered move indices,
  // but cannot see edits owned by peers. Rebuild that exact offered index space
  // so a peer-edit barrier is distinguishable from an ordinary no-op.
  const localEditId = activeQueuedMessageEdit(host)?.id;
  const offeredSegment = chatQueueMovableSegments(
    scope,
    (row) => isMovableChatQueueItem(row) && row.id !== localEditId,
  ).find((rows) => rows.some((row) => row.id === id));
  const fromIndex = offeredSegment?.findIndex((row) => row.id === id) ?? -1;
  const requestedIndex = offeredSegment
    ? Math.min(Math.max(toIndex, 0), offeredSegment.length - 1)
    : -1;
  if (fromIndex < 0 || fromIndex === requestedIndex) {
    return "noop";
  }
  const crossedPeerEdit = offeredSegment!.some(
    (row, index) =>
      index >= Math.min(fromIndex, requestedIndex) &&
      index <= Math.max(fromIndex, requestedIndex) &&
      row.id !== id &&
      isQueuedMessageBeingEdited(host, row.id),
  );
  if (crossedPeerEdit) {
    setChatError(host, QUEUED_MESSAGE_REORDER_CONFLICT_ERROR);
    return "rejected";
  }
  const segment = chatQueueMovableSegments(
    scope,
    (row) => isMovableChatQueueItem(row) && !isQueuedMessageBeingEdited(host, row.id),
  ).find((rows) => rows.some((row) => row.id === id));
  const targetId = offeredSegment![requestedIndex]?.id;
  const segmentTargetIndex = segment?.findIndex((row) => row.id === targetId) ?? -1;
  const moves = reorderChatQueueItems(segment ?? [], id, segmentTargetIndex);
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
  const item = host.chatQueue.find((entry) => entry.id === id);
  const retriesFailedDelivery = item?.sendState === "failed" && !item.localCommandName;
  const retriesUnconfirmed =
    item?.sendState === "unconfirmed" && Boolean(item.sendRunId) && !item.localCommandName;
  if (isQueuedMessageBeingEdited(host, id)) {
    setChatError(host, QUEUED_MESSAGE_RETRY_CONFLICT_ERROR);
    return;
  }
  if (
    !item ||
    item.pendingRunId ||
    item.sendState === "executing-command" ||
    item.sendState === "sending" ||
    item.sendState === "waiting-model"
  ) {
    return;
  }
  const owner = chatOutboxOwner(host);
  const located = owner.locate(host, item.id);
  if (!located) {
    return;
  }
  if (!located.durable) {
    const wasVolatile = isVolatileQueuedMessage(host, item.id);
    const admission = { scope: located.scope, awaitingDefaults: !hasUiSessionDefaults(host) };
    if (!admitQueuedMessageForSession(host, admission, item)) {
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
  const retried = owner.locate(host, retry.id);
  if (!retried?.durable) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  const outbox = retried.scope;
  const explicitAdmission = retry.queueMode || retriesFailedDelivery || retriesUnconfirmed;
  const drain = scheduleStoredChatOutboxDrain(
    host,
    outbox,
    chatOutboxDrainDependencies,
    explicitAdmission ? retry.id : undefined,
    explicitAdmission
      ? {
          routingSessionKey: host.sessionKey,
          ...(retriesFailedDelivery ? { allowActiveRunSend: true } : {}),
        }
      : undefined,
  );
  if (host.chatSending && host.chatSendingScopeKey === storedChatOutboxScopeKey(outbox)) {
    void drain;
    return;
  }
  await drain;
  if (!host.chatRunId) {
    void flushStoredChatOutbox(host, chatOutboxDrainDependencies);
  }
}
