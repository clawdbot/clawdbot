// Feishu plugin module implements send result behavior.
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";

type FeishuMessageApiResponse = {
  code?: number;
  msg?: string;
  data?: {
    message_id?: string;
  };
};

export function resolveFeishuReceiptKind(msgType?: string): MessageReceiptPartKind {
  switch (msgType) {
    case "audio":
      return "voice";
    case "image":
    case "media":
    case "file":
    case "sticker":
      return "media";
    case "interactive":
      return "card";
    case "post":
    case "text":
      return "text";
    default:
      return "unknown";
  }
}

export function createFeishuSendReceipt(params: {
  messageId?: string;
  chatId: string;
  kind?: MessageReceiptPartKind;
}): MessageReceipt {
  const messageId = params.messageId?.trim();
  const chatId = params.chatId.trim();
  return createMessageReceiptFromOutboundResults({
    results: messageId
      ? [
          {
            channel: "feishu",
            messageId,
            chatId,
            conversationId: chatId,
          },
        ]
      : [],
    ...(chatId ? { threadId: chatId } : {}),
    kind: params.kind ?? "unknown",
  });
}

export function assertFeishuMessageApiSuccess(
  response: FeishuMessageApiResponse,
  errorPrefix: string,
) {
  if (response.code !== 0) {
    throw new Error(`${errorPrefix}: ${response.msg || `code ${response.code}`}`);
  }
}

export function toFeishuSendResult(
  response: FeishuMessageApiResponse,
  chatId: string,
  kind?: MessageReceiptPartKind,
  errorPrefix = "Feishu send failed",
): {
  messageId: string;
  chatId: string;
  receipt: MessageReceipt;
} {
  const messageId = response.data?.message_id?.trim();
  if (!messageId) {
    // Feishu already accepted this send; an ordinary error would invite a duplicate retry.
    throw createChannelPartialDeliveryError(new Error(`${errorPrefix}: no message_id returned`), {
      messageIds: [],
      visibleReplySent: true,
    });
  }
  return {
    messageId,
    chatId,
    receipt: createFeishuSendReceipt({ messageId, chatId, kind }),
  };
}
