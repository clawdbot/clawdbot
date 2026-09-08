// Discord plugin module implements send.receipt behavior.
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import { attachChannelToResults } from "openclaw/plugin-sdk/channel-send-result";
import type { DiscordReplyReference } from "./reply-reference.js";
import type { DiscordSendResult } from "./send.types.js";

export type DiscordReceiptResultSource = {
  id?: string | null;
  channel_id?: string | null;
  platformMessageIds?: readonly string[];
};

export function toDiscordOutboundDeliveryResult<T extends { channelId: string }>(result: T) {
  const { channelId, ...delivery } = result;
  return { ...delivery, target: { kind: "channel" as const, id: channelId } };
}

export function createDiscordSendReceiptFromResults(params: {
  results: readonly DiscordSendResult[];
  threadId?: string;
}): MessageReceipt {
  const receipt = createMessageReceiptFromOutboundResults({
    results: attachChannelToResults("discord", params.results),
    threadId: params.threadId,
  });
  return {
    ...receipt,
    parts: receipt.parts.map(({ platformMessageId, kind, threadId, replyToId, raw }, index) => ({
      platformMessageId,
      kind,
      index,
      threadId,
      replyToId,
      raw,
    })),
  };
}

export function createDiscordSendReceipt(params: {
  platformMessageIds: readonly string[];
  channelId?: string;
  kind: MessageReceiptPartKind;
  threadId?: string;
  reply?: DiscordReplyReference;
}): MessageReceipt {
  const platformMessageIds = params.platformMessageIds
    .map((messageId) => messageId.trim())
    .filter(Boolean);
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
  // A missing Discord ID is ambiguous, not an acknowledgement. Leave it empty
  // so shared delivery custody cannot mistake a placeholder for platform evidence.
  const messageId = params.result.id ?? "";
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
