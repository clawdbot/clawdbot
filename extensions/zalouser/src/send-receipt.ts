import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-message";

export function createZalouserSendReceipt(params: {
  messageId?: string;
  platformMessageIds?: readonly (string | null | undefined)[];
  threadId?: string;
  kind?: MessageReceiptPartKind;
}): MessageReceipt {
  const platformMessageIds = (params.platformMessageIds ?? [params.messageId])
    .map((messageId) => messageId?.trim())
    .filter((messageId): messageId is string => Boolean(messageId));
  const threadId = params.threadId?.trim();
  return createMessageReceiptFromOutboundResults({
    results: platformMessageIds.map((messageId) => {
      const result: { channel: string; messageId: string; conversationId?: string } = {
        channel: "zalouser",
        messageId,
      };
      if (threadId) {
        result.conversationId = threadId;
      }
      return result;
    }),
    ...(threadId ? { threadId } : {}),
    kind: params.kind ?? "unknown",
  });
}
