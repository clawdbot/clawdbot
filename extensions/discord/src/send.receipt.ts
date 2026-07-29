// Discord plugin module implements send.receipt behavior.
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { DiscordReplyReference } from "./reply-reference.js";
import type { DiscordSendResult } from "./send.types.js";

export type DiscordReceiptResultSource = {
  id?: string | null;
  channel_id?: string | null;
  platformMessageIds?: readonly string[];
};

export function createDiscordSendReceipt(params: {
  platformMessageIds: readonly string[];
  channelId?: string;
  kind: MessageReceiptPartKind;
  threadId?: string;
  reply?: DiscordReplyReference;
}): MessageReceipt {
  const platformMessageIds = params.platformMessageIds
    .map((messageId) => messageId.trim())
    .filter((messageId) => messageId && messageId !== "unknown");
  const results: Array<MessageReceiptSourceResult & { receipt?: MessageReceipt }> =
    platformMessageIds.map((messageId, index) => {
      const result: MessageReceiptSourceResult & { receipt?: MessageReceipt } = {
        channel: "discord",
        messageId,
      };
      if (params.channelId) {
        result.channelId = params.channelId;
      }
      if (params.reply?.scope === "first" && index === 0) {
        // A top-level replyToId would be copied onto every receipt part. Nest the
        // first receipt so persisted metadata matches Discord's one message_reference.
        const rawResult: MessageReceiptSourceResult = {
          channel: "discord",
          messageId,
        };
        if (params.channelId) {
          rawResult.channelId = params.channelId;
        }
        result.receipt = createMessageReceiptFromOutboundResults({
          results: [rawResult],
          kind: params.kind,
          threadId: params.threadId,
          replyToId: params.reply.messageId,
        });
      }
      return result;
    });
  return createMessageReceiptFromOutboundResults({
    results,
    kind: params.kind,
    threadId: params.threadId,
    replyToId: params.reply?.scope === "all" ? params.reply.messageId : undefined,
  });
}

export function createDiscordSendResult(params: {
  result: DiscordReceiptResultSource;
  fallbackChannelId: string;
  kind: MessageReceiptPartKind;
  threadId?: string | number;
  reply?: DiscordReplyReference;
}): DiscordSendResult {
  const messageId = params.result.id || "unknown";
  const channelId = params.result.channel_id ?? params.fallbackChannelId;
  const receiptParams: Parameters<typeof createDiscordSendReceipt>[0] = {
    platformMessageIds: params.result.platformMessageIds?.length
      ? params.result.platformMessageIds
      : [messageId],
    channelId,
    kind: params.kind,
  };
  if (params.threadId != null) {
    receiptParams.threadId = String(params.threadId);
  }
  if (params.reply) {
    receiptParams.reply = params.reply;
  }
  return {
    messageId,
    channelId,
    receipt: createDiscordSendReceipt(receiptParams),
  };
}
