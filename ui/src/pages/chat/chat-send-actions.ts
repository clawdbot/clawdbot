import type { QueueMode } from "../../../../src/auto-reply/reply/queue/types.js";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
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
  updateQueuedMessage,
  updateVolatileQueuedMessage,
} from "./chat-queue.ts";
import type { ChatSendAck } from "./chat-send-ack.ts";
import type { ChatHost } from "./chat-send-contract.ts";
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
import { chatOutboxDrainDependencies, sendQueuedChatMessage } from "./chat-send.ts";
import { listStoredChatOutboxes, storedChatOutboxScopeKey } from "./composer-persistence.ts";
import { formatConnectError } from "./connect-error.ts";
import {
  OFFLINE_QUEUE_STORAGE_ERROR,
  steerQueuedChatMessage as steerQueuedChatMessageLifecycle,
  type SteerSendDependencies,
} from "./steer-lifecycle.ts";
import { isInflightSteer } from "./steered-chip.ts";

export async function sendChatMessageWithGeneratedRunId(
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
  // Only an authoritative history/cache commit can advance this token. Optimistic
  // sends do not know their persisted leaf id; direct sends must fail closed while
  // restored outbox drains intentionally omit the precondition.
  const expectedLeafEntryId = resolveDisplayedLeafEntryId(state);
  try {
    return await requestChatSend(state, {
      message: msg,
      attachments,
      runId,
      ...(expectedLeafEntryId !== undefined ? { expectedLeafEntryId } : {}),
      ...(options.queueMode ? { queueMode: options.queueMode } : {}),
    });
  } catch (err) {
    if (canApplyError()) {
      setChatError(
        state,
        isActiveLeafChangedError(err)
          ? t("chat.sendErrors.activeLeafChanged")
          : formatConnectError(err),
      );
      if (isActiveLeafChangedError(err)) {
        void Promise.all([loadChatHistory(state), loadChatBranches(state)]);
      }
    }
    return null;
  }
}

export const steerSendDependencies: SteerSendDependencies = {
  loadChatHistory: (host) => void loadChatHistory(host as unknown as ChatState),
  resumeRestoredOutbox: (host, itemId) => {
    const restoredOutbox = listStoredChatOutboxes(host).find((outbox) =>
      outbox.queue.some((item) => item.id === itemId),
    );
    if (!host.chatRunId && restoredOutbox) {
      void scheduleStoredChatOutboxDrain(
        host as ChatHost,
        restoredOutbox,
        chatOutboxDrainDependencies,
      );
    }
  },
  sendChatMessage: (host, message, attachments, options) =>
    sendChatMessageWithGeneratedRunId(host as unknown as ChatState, message, attachments, options),
};

export function steerQueuedChatMessage(host: ChatHost, id: string) {
  return steerQueuedChatMessageLifecycle(host, id, steerSendDependencies);
}

export async function resumeStoredChatOutboxes(host: ChatHost) {
  await resumeStoredChatOutboxesDrain(host, chatOutboxDrainDependencies);
}

export async function flushChatQueueForEvent(host: ChatHost) {
  await flushStoredChatOutbox(host, chatOutboxDrainDependencies);
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
