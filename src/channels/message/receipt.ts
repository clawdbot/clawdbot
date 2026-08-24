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
};

const normalizeIdentity = (value: string | undefined): string | undefined =>
  value?.trim() || undefined;

export function resolveReceiptSourceId(result: MessageReceiptInputResult): string | undefined {
  return (
    normalizeIdentity(result.messageId) ??
    (result.receipt ? resolveMessageReceiptPrimaryId(result.receipt) : undefined) ??
    normalizeIdentity(result.pollId)
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
  kind?: MessageReceiptPartKind;
  threadId?: string;
  replyToId?: string;
  sentAt?: number;
}): MessageReceipt {
  const requestedThreadId = normalizeIdentity(params.threadId);
  const providerThreadIds = normalizeUniqueStringEntries(
    params.results.flatMap(({ receipt }) =>
      receipt?.parts.length
        ? receipt.parts.flatMap(
            (part) => normalizeIdentity(part.threadId) ?? normalizeIdentity(receipt.threadId) ?? [],
          )
        : (normalizeIdentity(receipt?.threadId) ?? []),
    ),
  );
  const aggregateThreadId =
    providerThreadIds.length > 1 ? undefined : (providerThreadIds[0] ?? requestedThreadId);
  const parts = params.results.flatMap((result, resultIndex) => {
    if (result.receipt) {
      const receiptThreadId = normalizeIdentity(result.receipt.threadId) ?? requestedThreadId;
      if (result.receipt.parts.length === 0) {
        return result.receipt.platformMessageIds.map((platformMessageId, partIndex) => ({
          platformMessageId,
          kind: params.kind ?? "unknown",
          index: partIndex,
          ...(receiptThreadId ? { threadId: receiptThreadId } : {}),
          ...(params.replyToId ? { replyToId: params.replyToId } : {}),
        }));
      }
      // Mixed adapter-supplied reply metadata is authoritative: missing entries mean
      // those physical messages were not native replies and must not inherit the route reply.
      const hasPartReplyMetadata = result.receipt.parts.some((part) => part.replyToId);
      return result.receipt.parts.map((part, partIndex) => ({
        ...part,
        index: part.index ?? partIndex,
        ...(normalizeIdentity(part.threadId) || !receiptThreadId
          ? {}
          : { threadId: receiptThreadId }),
        ...(part.replyToId || !params.replyToId || hasPartReplyMetadata
          ? {}
          : { replyToId: params.replyToId }),
      }));
    }
    const platformMessageId = resolveReceiptSourceId(result);
    if (!platformMessageId) {
      return [];
    }
    return [
      {
        platformMessageId,
        kind: params.kind ?? "unknown",
        index: resultIndex,
        ...(requestedThreadId ? { threadId: requestedThreadId } : {}),
        ...(params.replyToId ? { replyToId: params.replyToId } : {}),
        raw: result,
      },
    ];
  });
  const platformMessageIds: string[] = [];
  for (const result of params.results) {
    if (result.receipt) {
      appendUnique(platformMessageIds, result.receipt.primaryPlatformMessageId);
      for (const platformMessageId of result.receipt.platformMessageIds) {
        appendUnique(platformMessageIds, platformMessageId);
      }
      for (const part of result.receipt.parts) {
        appendUnique(platformMessageIds, part.platformMessageId);
      }
      continue;
    }
    appendUnique(platformMessageIds, resolveReceiptSourceId(result));
  }
  const firstNestedReceipt = params.results.find((result) => result.receipt)?.receipt;
  return {
    ...(platformMessageIds[0] ? { primaryPlatformMessageId: platformMessageIds[0] } : {}),
    platformMessageIds,
    parts,
    ...(aggregateThreadId ? { threadId: aggregateThreadId } : {}),
    ...((params.replyToId ?? firstNestedReceipt?.replyToId)
      ? { replyToId: params.replyToId ?? firstNestedReceipt?.replyToId }
      : {}),
    sentAt: params.sentAt ?? firstNestedReceipt?.sentAt ?? Date.now(),
    raw: params.results,
  };
}

/** Lists unique platform message ids in receipt order. */
export function listMessageReceiptPlatformIds(receipt: MessageReceipt): string[] {
  return normalizeUniqueStringEntries(receipt.platformMessageIds);
}

/** Resolves the explicit primary platform id, falling back to the first unique receipt id. */
export function resolveMessageReceiptPrimaryId(receipt: MessageReceipt): string | undefined {
  const primary = normalizeIdentity(receipt.primaryPlatformMessageId);
  if (primary) {
    return primary;
  }
  return (
    listMessageReceiptPlatformIds(receipt)[0] ??
    receipt.parts.map((part) => normalizeIdentity(part.platformMessageId)).find(Boolean)
  );
}

/** Resolves provider-owned thread placement without collapsing conflicting receipt parts. */
export function resolveMessageReceiptThreadId(
  receipt: MessageReceipt,
  requestedThreadId?: string,
): string | undefined {
  const partThreadIds = normalizeUniqueStringEntries(
    receipt.parts.flatMap((part) => normalizeIdentity(part.threadId) ?? []),
  );
  if (partThreadIds.length > 1) {
    return undefined;
  }
  return (
    partThreadIds[0] ?? normalizeIdentity(receipt.threadId) ?? normalizeIdentity(requestedThreadId)
  );
}
