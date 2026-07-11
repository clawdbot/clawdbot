// Line plugin module implements send receipt behavior.
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";

export function createLineSendReceipt(params: {
  // Ordered physical LINE messages this send produced (media + caption is two).
  // Each id is paired with its own kind so a media + caption send records kinds
  // [media, text]; the two cannot drift because they travel together. The first
  // stays primary.
  parts: { messageId: string; kind: MessageReceiptPartKind }[];
  chatId: string;
  messageCount?: number;
}): MessageReceipt {
  const chatId = params.chatId.trim();
  const parts = params.parts
    .map((part) => ({ messageId: part.messageId.trim(), kind: part.kind }))
    .filter((part) => part.messageId.length > 0);
  return createMessageReceiptFromOutboundResults({
    // Each id carries its own kind on its result so the two cannot drift.
    results: parts.map((part) => ({
      channel: "line",
      messageId: part.messageId,
      chatId,
      conversationId: chatId,
      kind: part.kind,
      meta: {
        messageCount: params.messageCount ?? parts.length,
      },
    })),
    ...(chatId ? { threadId: chatId } : {}),
  });
}
