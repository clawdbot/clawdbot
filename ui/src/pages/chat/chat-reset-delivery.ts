import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { ChatCommandResetOptions } from "./chat-commands.ts";
import type {
  ChatOutboxDrainDependencies,
  QueuedChatSendOptions,
  QueuedChatSendResult,
} from "./chat-outbox-drain.ts";
import { admitQueuedMessageForSession } from "./chat-queue.ts";
import { cancelChatDelivery } from "./chat-send-composer.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  createPendingSendMessage,
  publishPendingSendMessage,
  reconnectSafeQueuedSendState,
  setChatError,
} from "./chat-send-queue-state.ts";
import { OFFLINE_QUEUE_STORAGE_ERROR } from "./chat-send-support.ts";

type DeliverChatQueueItem = (
  host: ChatHost,
  item: ChatQueueItem,
  options?: QueuedChatSendOptions,
) => Promise<QueuedChatSendResult>;

export function createResetSlashCommandSender(
  deliverChatQueueItem: DeliverChatQueueItem,
): ChatOutboxDrainDependencies["sendResetSlashCommand"] {
  return async (host: ChatHost, message: string, options: ChatCommandResetOptions) => {
    const pending = createPendingSendMessage(
      host,
      message,
      undefined,
      true,
      undefined,
      reconnectSafeQueuedSendState(host),
    );
    const item = pending?.item;
    if (item) {
      publishPendingSendMessage(host, item);
    }
    if (
      !item ||
      !admitQueuedMessageForSession(host, host.sessionKey, item, undefined, pending?.admission)
    ) {
      if (item) {
        cancelChatDelivery(host, item, { previousDraft: options.previousDraft });
      }
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      return;
    }
    await deliverChatQueueItem(host, item, {
      previousDraft: options.previousDraft,
      restoreDraft: options.restoreDraft,
      routingSessionKey: host.sessionKey,
      target: options.target,
    });
  };
}
