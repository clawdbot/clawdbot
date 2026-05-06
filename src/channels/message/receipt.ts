import type {
  MessageReceipt,
  MessageReceiptPartKind,
  MessageReceiptSourceResult,
} from "./types.js";

type MessageReceiptInputResult = MessageReceiptSourceResult & {
  receipt?: MessageReceipt;
};

function resolveReceiptMessageId(result: MessageReceiptInputResult): string | undefined {
  return (
    result.messageId ||
    result.chatId ||
    result.channelId ||
    result.roomId ||
    result.conversationId ||
    result.toJid ||
    result.pollId
  );
}

function hasNestedReceiptData(receipt: MessageReceipt | undefined): receipt is MessageReceipt {
  return Boolean(
    receipt &&
    (receipt.parts.length > 0 ||
      receipt.platformMessageIds.length > 0 ||
      receipt.primaryPlatformMessageId),
  );
}

function appendUnique(values: string[], value: string | undefined): void {
  const normalized = value?.trim();
  if (normalized && !values.includes(normalized)) {
    values.push(normalized);
  }
}

export function createMessageReceiptFromOutboundResults(params: {
  results: readonly MessageReceiptInputResult[];
  kind?: MessageReceiptPartKind;
  threadId?: string;
  replyToId?: string;
  sentAt?: number;
}): MessageReceipt {
  const parts = params.results.flatMap((result, resultIndex) => {
    if (hasNestedReceiptData(result.receipt)) {
      return result.receipt.parts.length > 0
        ? result.receipt.parts.map((part, partIndex) => ({
            ...part,
            index: part.index ?? partIndex,
            ...(part.threadId || !params.threadId ? {} : { threadId: params.threadId }),
            ...(part.replyToId || !params.replyToId ? {} : { replyToId: params.replyToId }),
          }))
        : result.receipt.platformMessageIds.map((platformMessageId, partIndex) => ({
            platformMessageId,
            kind: params.kind ?? "unknown",
            index: partIndex,
            ...(params.threadId ? { threadId: params.threadId } : {}),
            ...(params.replyToId ? { replyToId: params.replyToId } : {}),
          }));
    }
    const platformMessageId = resolveReceiptMessageId(result);
    if (!platformMessageId) {
      return [];
    }
    return [
      {
        platformMessageId,
        kind: params.kind ?? "unknown",
        index: resultIndex,
        ...(params.threadId ? { threadId: params.threadId } : {}),
        ...(params.replyToId ? { replyToId: params.replyToId } : {}),
        raw: result,
      },
    ];
  });
  const platformMessageIds: string[] = [];
  for (const result of params.results) {
    if (hasNestedReceiptData(result.receipt)) {
      appendUnique(platformMessageIds, result.receipt.primaryPlatformMessageId);
      for (const platformMessageId of result.receipt.platformMessageIds) {
        appendUnique(platformMessageIds, platformMessageId);
      }
      for (const part of result.receipt.parts) {
        appendUnique(platformMessageIds, part.platformMessageId);
      }
      continue;
    }
    appendUnique(platformMessageIds, resolveReceiptMessageId(result));
  }
  const firstNestedReceipt = params.results.find((result) =>
    hasNestedReceiptData(result.receipt),
  )?.receipt;
  return {
    ...(platformMessageIds[0] ? { primaryPlatformMessageId: platformMessageIds[0] } : {}),
    platformMessageIds,
    parts,
    ...((params.threadId ?? firstNestedReceipt?.threadId)
      ? { threadId: params.threadId ?? firstNestedReceipt?.threadId }
      : {}),
    ...((params.replyToId ?? firstNestedReceipt?.replyToId)
      ? { replyToId: params.replyToId ?? firstNestedReceipt?.replyToId }
      : {}),
    sentAt: params.sentAt ?? firstNestedReceipt?.sentAt ?? Date.now(),
    raw: params.results,
  };
}

export function listMessageReceiptPlatformIds(receipt: MessageReceipt): string[] {
  return Array.from(
    new Set(receipt.platformMessageIds.map((messageId) => messageId.trim()).filter(Boolean)),
  );
}

export function resolveMessageReceiptPrimaryId(receipt: MessageReceipt): string | undefined {
  const primary = receipt.primaryPlatformMessageId?.trim();
  if (primary) {
    return primary;
  }
  return listMessageReceiptPlatformIds(receipt)[0];
}
