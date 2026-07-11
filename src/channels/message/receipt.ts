/**
 * Channel message receipt normalization.
 *
 * Builds stable receipts from platform send results and nested adapter receipt data.
 */
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type {
  MessageReceipt,
  MessageReceiptPartKind,
  MessageReceiptSourceResult,
} from "./types.js";

type MessageReceiptInputResult = MessageReceiptSourceResult & {
  receipt?: MessageReceipt;
  // Optional receipt kind for this single physical platform message. Adapters
  // that deliver several kinds in one logical send (e.g. LINE media + caption)
  // set it per result so each part keeps its own kind; the kind travels with its
  // id so the two cannot drift, unlike a separate parallel array. Ignored for
  // nested-receipt results, which carry their own part kinds.
  kind?: MessageReceiptPartKind;
};

// The per-result `kind` is receipt-layer metadata, not a platform field, so keep
// it out of `raw`, which mirrors the raw platform send result.
function stripResultKind(result: MessageReceiptInputResult): MessageReceiptInputResult {
  // Own-key check, not `=== undefined`: an explicit `{ kind: undefined }` still
  // carries the key and must be stripped so `kind` never appears in `raw`.
  if (!Object.hasOwn(result, "kind")) {
    return result;
  }
  const { kind: _kind, ...rest } = result;
  return rest;
}

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

/** Builds one normalized receipt from platform send results or nested adapter receipts. */
export function createMessageReceiptFromOutboundResults(params: {
  results: readonly MessageReceiptInputResult[];
  // Fallback kind for flat results that do not carry their own `kind`.
  kind?: MessageReceiptPartKind;
  threadId?: string;
  replyToId?: string;
  sentAt?: number;
}): MessageReceipt {
  const parts = params.results.flatMap((result, resultIndex) => {
    if (hasNestedReceiptData(result.receipt)) {
      if (result.receipt.parts.length === 0) {
        return result.receipt.platformMessageIds.map((platformMessageId, partIndex) => ({
          platformMessageId,
          kind: params.kind ?? "unknown",
          index: partIndex,
          ...(params.threadId ? { threadId: params.threadId } : {}),
          ...(params.replyToId ? { replyToId: params.replyToId } : {}),
        }));
      }
      // Mixed adapter-supplied reply metadata is authoritative: missing entries mean
      // those physical messages were not native replies and must not inherit the route reply.
      const hasPartReplyMetadata = result.receipt.parts.some((part) => part.replyToId);
      return result.receipt.parts.map((part, partIndex) => ({
        ...part,
        index: part.index ?? partIndex,
        ...(part.threadId || !params.threadId ? {} : { threadId: params.threadId }),
        ...(part.replyToId || !params.replyToId || hasPartReplyMetadata
          ? {}
          : { replyToId: params.replyToId }),
      }));
    }
    const platformMessageId = resolveReceiptMessageId(result);
    if (!platformMessageId) {
      return [];
    }
    return [
      {
        platformMessageId,
        kind: result.kind ?? params.kind ?? "unknown",
        index: resultIndex,
        ...(params.threadId ? { threadId: params.threadId } : {}),
        ...(params.replyToId ? { replyToId: params.replyToId } : {}),
        raw: stripResultKind(result),
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
    raw: params.results.map(stripResultKind),
  };
}

/** Lists unique platform message ids in receipt order. */
export function listMessageReceiptPlatformIds(receipt: MessageReceipt): string[] {
  return normalizeUniqueStringEntries(receipt.platformMessageIds);
}

/** Resolves the explicit primary platform id, falling back to the first unique receipt id. */
export function resolveMessageReceiptPrimaryId(receipt: MessageReceipt): string | undefined {
  const primary = receipt.primaryPlatformMessageId?.trim();
  if (primary) {
    return primary;
  }
  return listMessageReceiptPlatformIds(receipt)[0];
}
