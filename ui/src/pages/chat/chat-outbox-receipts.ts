import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { readChatInputReceipt } from "../../lib/chat/history-message-identity.ts";
import {
  listStoredChatOutboxes,
  type StoredChatOutbox,
} from "../../lib/chat/outbox-store-projection.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { removeDeliveredQueuedChatSendForRun, updateQueuedMessage } from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  OFFLINE_QUEUE_STORAGE_ERROR,
  UNCONFIRMED_CHAT_SEND_ERROR,
  surfaceChatDeliveryFailure,
} from "./chat-send-support.ts";

export function readStoredChatOutbox(
  host: ChatHost,
  scope: StoredChatOutboxScope,
): StoredChatOutbox | undefined {
  return listStoredChatOutboxes(host).find(
    (outbox) => outbox.sessionKey === scope.sessionKey && outbox.agentId === scope.agentId,
  );
}

export function isInterruptedChatInput(history: ChatHistoryResult, item: ChatQueueItem): boolean {
  return (
    readChatInputReceipt(history, item) === "pending" &&
    history.pendingInputs?.items.some(
      (input) => input.runId === item.sendRunId && input.state === "interrupted",
    ) === true
  );
}

/** Reconcile exact pending custody; ordinary transcript consumption stays with the drain. */
export function reconcilePendingChatOutboxInput(
  host: ChatHost,
  outbox: StoredChatOutbox,
  item: ChatQueueItem,
  history: ChatHistoryResult,
  pendingBefore: number | undefined,
): ChatHistoryResult | "blocked" | "continue" | undefined {
  const historySessionId = history.sessionInfo?.sessionId ?? history.sessionId;
  if (item.sessionId && item.sessionId !== historySessionId) {
    // Request ids are scoped to their physical session. A replacement's matching
    // id cannot consume an old input or authorize sending it into the new chat.
    if (item.sendState !== "unconfirmed" || item.sendError !== UNCONFIRMED_CHAT_SEND_ERROR) {
      const parked = updateQueuedMessage(host, item.id, (entry) => ({
        ...entry,
        sendState: "unconfirmed",
        sendError: UNCONFIRMED_CHAT_SEND_ERROR,
      }));
      surfaceChatDeliveryFailure(
        host,
        outbox.sessionKey,
        outbox.agentId,
        parked ? UNCONFIRMED_CHAT_SEND_ERROR : OFFLINE_QUEUE_STORAGE_ERROR,
      );
    }
    return "blocked";
  }
  const inputReceipt = readChatInputReceipt(history, item);
  if (inputReceipt === "pending") {
    if (
      visibleSessionMatches(host, outbox.sessionKey, outbox.agentId) &&
      historySessionId === host.currentSessionId &&
      pendingBefore === undefined
    ) {
      applyChatPendingInputs(host, history.pendingInputs);
    }
    const pending = history.pendingInputs?.items.find((input) => input.runId === item.sendRunId);
    if (pending?.state === "cancelled") {
      return removeDeliveredQueuedChatSendForRun(host, item.sendRunId, outbox) !== null ||
        !readStoredChatOutbox(host, outbox)?.queue.some((entry) => entry.id === item.id)
        ? "continue"
        : "blocked";
    }
    if (!item.sessionId && historySessionId) {
      return updateQueuedMessage(host, item.id, (entry) => ({
        ...entry,
        sessionId: historySessionId,
      }))
        ? "continue"
        : "blocked";
    }
    // Only positive unconsumed custody can cross a restart. The new request
    // acquires current authority; an absent receipt is still an uncertain send.
    return pending?.state === "interrupted" &&
      item.sendState !== "sending" &&
      history.sessionInfo &&
      (item.queueMode === "steer" ||
        item.queueMode === "interrupt" ||
        // Recovery can own the session while its runner waits for capacity.
        // Queued input must not enter that interrupted turn's model context.
        (history.sessionInfo.hasActiveRun !== true &&
          history.sessionInfo.status !== "running" &&
          history.sessionInfo.status !== "queued"))
      ? history
      : "blocked";
  }
  return undefined;
}
