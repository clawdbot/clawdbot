import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPart,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";

export type SendMSTeamsMessageResult = {
  messageId: string;
  conversationId: string;
  receipt: MessageReceipt;
  pendingUploadId?: string;
};

export function createMSTeamsSendReceipt(params: {
  conversationId: string;
  platformMessageIds: readonly string[];
  kind: MessageReceiptPartKind;
  kinds?: readonly MessageReceiptPartKind[];
}) {
  const receipt = createMessageReceiptFromOutboundResults({
    kind: params.kind,
    results: params.platformMessageIds.map((messageId) => ({
      channel: "msteams",
      messageId,
      conversationId: params.conversationId,
    })),
  });
  if (!params.kinds) {
    return receipt;
  }
  const kinds = params.kinds;
  return {
    ...receipt,
    parts: receipt.parts.map((part, index) => {
      const nextPart: MessageReceiptPart = {
        platformMessageId: part.platformMessageId,
        kind: kinds[index] ?? params.kind,
        index: part.index,
      };
      if (part.threadId) {
        nextPart.threadId = part.threadId;
      }
      if (part.replyToId) {
        nextPart.replyToId = part.replyToId;
      }
      if (part.raw) {
        nextPart.raw = part.raw;
      }
      return nextPart;
    }),
  };
}

export function createMSTeamsSendResult(params: {
  conversationId: string;
  messageId: string;
  platformMessageIds?: readonly string[];
  kind: MessageReceiptPartKind;
  pendingUploadId?: string;
}): SendMSTeamsMessageResult {
  const platformMessageIds = (
    params.platformMessageIds?.length ? [...params.platformMessageIds] : [params.messageId]
  )
    .map((messageId) => messageId.trim())
    .filter((messageId) => messageId && messageId !== "unknown");
  return {
    messageId: params.messageId,
    conversationId: params.conversationId,
    receipt: createMSTeamsSendReceipt({
      conversationId: params.conversationId,
      platformMessageIds,
      kind: params.kind,
    }),
    ...(params.pendingUploadId ? { pendingUploadId: params.pendingUploadId } : {}),
  };
}
