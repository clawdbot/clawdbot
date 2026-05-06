import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-message";

export function createLineSendReceipt(params: {
  messageId: string;
  chatId: string;
  kind?: MessageReceiptPartKind;
  messageCount?: number;
}): MessageReceipt {
  const messageId = params.messageId.trim();
  const chatId = params.chatId.trim();
  return createMessageReceiptFromOutboundResults({
    results: messageId
      ? [
          {
            channel: "line",
            messageId,
            chatId,
            conversationId: chatId,
            meta: {
              messageCount: params.messageCount ?? 1,
            },
          },
        ]
      : [],
    ...(chatId ? { threadId: chatId } : {}),
    kind: params.kind ?? "unknown",
  });
}
