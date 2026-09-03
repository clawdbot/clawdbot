// Whatsapp plugin module implements send result behavior.
import { AsyncLocalStorage } from "node:async_hooks";
import type { WAMessage, WAMessageKey } from "baileys";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  type MessageReceipt,
  type MessageReceiptPartKind,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

export type WhatsAppSendKind =
  | "contact"
  | "location"
  | "media"
  | "poll"
  | "reaction"
  | "sticker"
  | "text";

type WhatsAppSendKey = Omit<
  Pick<WAMessageKey, "fromMe" | "id" | "participant" | "remoteJid">,
  "id"
> & {
  id: string;
};

export type WhatsAppSendResult = {
  kind: WhatsAppSendKind;
  messageId: string;
  receipt?: MessageReceipt;
  keys: WhatsAppSendKey[];
  providerAccepted: boolean;
};

// Producer-owned accounting follows the accepted object across nested owner boundaries.
const activityAccountedWhatsAppSendResults = new WeakSet<WhatsAppSendResult>();
const logicalWhatsAppDeliveryActivity = new AsyncLocalStorage<{
  accountedAccountIds: Set<string>;
}>();

/** Keep all separately produced platform sends inside one logical reply accounting scope. */
export async function withWhatsAppLogicalDeliveryActivity<T>(run: () => Promise<T>): Promise<T> {
  if (logicalWhatsAppDeliveryActivity.getStore()) {
    return await run();
  }
  return await logicalWhatsAppDeliveryActivity.run({ accountedAccountIds: new Set() }, run);
}

function resolveWhatsAppReceiptKind(kind: WhatsAppSendKind): MessageReceiptPartKind {
  if (kind === "media" || kind === "text") {
    return kind;
  }
  return "unknown";
}

function toReceiptSourceResult(key: WhatsAppSendKey): MessageReceiptSourceResult {
  return {
    channel: "whatsapp",
    messageId: key.id,
    ...(key.remoteJid ? { toJid: key.remoteJid } : {}),
    meta: {
      fromMe: key.fromMe,
      participant: key.participant,
    },
  };
}

function createWhatsAppSendReceipt(
  kind: WhatsAppSendKind,
  keys: readonly WhatsAppSendKey[],
): MessageReceipt {
  return createMessageReceiptFromOutboundResults({
    kind: resolveWhatsAppReceiptKind(kind),
    results: keys.map(toReceiptSourceResult),
  });
}

function mergeWhatsAppReceiptSourceMetadata(
  sources: readonly (MessageReceiptSourceResult | undefined)[],
): MessageReceiptSourceResult | undefined {
  const defined = sources.filter((source): source is MessageReceiptSourceResult => Boolean(source));
  const preferred = defined[0];
  if (!preferred) {
    return undefined;
  }
  const merged = new Map<string, unknown>();
  const meta = new Map<string, unknown>();
  for (const source of defined.toReversed()) {
    for (const [key, value] of Object.entries(source)) {
      if (key !== "meta" && value !== undefined) {
        merged.set(key, value);
      }
    }
    for (const [key, value] of Object.entries(source.meta ?? {})) {
      if (value !== undefined) {
        meta.set(key, value);
      }
    }
  }
  const mergedSource = Object.assign({}, preferred, Object.fromEntries(merged));
  if (meta.size > 0) {
    mergedSource.meta = Object.fromEntries(meta);
  } else {
    delete mergedSource.meta;
  }
  return mergedSource;
}

function enrichWhatsAppDeliveryReceipt(params: {
  receipt: MessageReceipt;
  sources: readonly MessageReceipt[];
}): MessageReceipt {
  const seenPartIds = new Set<string>();
  const parts = params.receipt.parts.flatMap((part) => {
    if (seenPartIds.has(part.platformMessageId)) {
      return [];
    }
    seenPartIds.add(part.platformMessageId);
    const matchingParts = params.sources.flatMap((source) =>
      source.parts.filter((candidate) => candidate.platformMessageId === part.platformMessageId),
    );
    const matchingRawSources = params.sources.flatMap(
      (source) => source.raw?.filter((raw) => raw.messageId === part.platformMessageId) ?? [],
    );
    const raw = mergeWhatsAppReceiptSourceMetadata([
      part.raw,
      ...matchingParts.map((candidate) => candidate.raw),
      ...matchingRawSources,
    ]);
    const threadId =
      part.threadId ?? matchingParts.find((candidate) => candidate.threadId)?.threadId;
    const replyToId =
      part.replyToId ?? matchingParts.find((candidate) => candidate.replyToId)?.replyToId;
    return [
      {
        ...part,
        ...(threadId ? { threadId } : {}),
        ...(replyToId ? { replyToId } : {}),
        ...(raw ? { raw } : {}),
      },
    ];
  });
  const threadId =
    params.receipt.threadId ?? params.sources.find((source) => source.threadId)?.threadId;
  const replyToId =
    params.receipt.replyToId ?? params.sources.find((source) => source.replyToId)?.replyToId;
  const editToken =
    params.receipt.editToken ?? params.sources.find((source) => source.editToken)?.editToken;
  const deleteToken =
    params.receipt.deleteToken ?? params.sources.find((source) => source.deleteToken)?.deleteToken;
  return {
    ...params.receipt,
    parts,
    raw: parts.map(
      (part) => part.raw ?? { channel: "whatsapp", messageId: part.platformMessageId },
    ),
    ...(threadId ? { threadId } : {}),
    ...(replyToId ? { replyToId } : {}),
    ...(editToken ? { editToken } : {}),
    ...(deleteToken ? { deleteToken } : {}),
  };
}

function normalizeKey(key: WAMessageKey | undefined): WhatsAppSendKey | undefined {
  const id = typeof key?.id === "string" ? key.id.trim() : "";
  if (!id) {
    return undefined;
  }
  return {
    id,
    remoteJid: key?.remoteJid,
    fromMe: key?.fromMe,
    participant: key?.participant,
  };
}

function createWhatsAppProviderNotAcceptedError(kind: WhatsAppSendKind) {
  const cause = new Error("Baileys returned no accepted message key.");
  return new PlatformMessageNotDispatchedError(
    `WhatsApp ${kind} send was not accepted by the provider: ${cause.message}`,
    { cause },
  );
}

export function normalizeWhatsAppSendResult(
  result: WAMessage | undefined,
  kind: WhatsAppSendKind,
): WhatsAppSendResult {
  const key = normalizeKey(result?.key);
  if (!key) {
    throw createWhatsAppProviderNotAcceptedError(kind);
  }
  return {
    kind,
    messageId: key.id,
    receipt: createWhatsAppSendReceipt(kind, [key]),
    keys: [key],
    providerAccepted: true,
  };
}

/** Refuse synthetic ids from listener boundaries before callers create durable receipts. */
export function requireWhatsAppAcceptedSendResult(result: WhatsAppSendResult): WhatsAppSendResult {
  if (
    result.providerAccepted &&
    result.messageId !== "unknown" &&
    result.keys.some((key) => key.id === result.messageId) &&
    listWhatsAppSendResultMessageIds(result).includes(result.messageId)
  ) {
    return result;
  }
  throw createWhatsAppProviderNotAcceptedError(result.kind);
}

/** Persist accepted provider facts before account bookkeeping or later platform sends can fail. */
export function rememberWhatsAppAcceptedSend(params: {
  accountId: string;
  result: WhatsAppSendResult;
  results: WhatsAppSendResult[];
}): WhatsAppSendResult {
  const accepted = requireWhatsAppAcceptedSendResult(params.result);
  params.results.push(accepted);
  if (params.results.length === 1) {
    const deliveryActivity = logicalWhatsAppDeliveryActivity.getStore();
    const alreadyAccounted =
      activityAccountedWhatsAppSendResults.has(accepted) ||
      Boolean(deliveryActivity?.accountedAccountIds.has(params.accountId));
    // Mark before bookkeeping: a thrown owner callback must not be retried by an outer adapter.
    activityAccountedWhatsAppSendResults.add(accepted);
    if (!alreadyAccounted) {
      deliveryActivity?.accountedAccountIds.add(params.accountId);
      recordChannelActivity({
        channel: "whatsapp",
        accountId: params.accountId,
        direction: "outbound",
      });
    }
  }
  return accepted;
}

/** Nested owners already attempted activity accounting before exposing accepted delivery. */
export function rememberWhatsAppPartialSend(params: {
  error: unknown;
  kind: WhatsAppSendKind;
  results: WhatsAppSendResult[];
}): boolean {
  if (!isChannelPartialDeliveryError(params.error)) {
    return false;
  }
  const delivery = params.error.deliveryResult;
  const messageIds = uniqueStrings([
    ...(delivery.receipt ? listMessageReceiptPlatformIds(delivery.receipt) : []),
    ...normalizeStringEntries(delivery.messageIds ?? []),
  ]).filter((messageId) => messageId !== "unknown");
  const existingIds = new Set(params.results.flatMap(listWhatsAppSendResultMessageIds));
  const acceptedIds = messageIds.filter((messageId) => !existingIds.has(messageId));
  const messageId = acceptedIds[0];
  if (!messageId) {
    return false;
  }
  const receiptSources: Array<MessageReceiptSourceResult & { receipt?: MessageReceipt }> = [];
  if (delivery.receipt) {
    receiptSources.push({ channel: "whatsapp", messageId, receipt: delivery.receipt });
  }
  const receiptIds = new Set(
    delivery.receipt ? listMessageReceiptPlatformIds(delivery.receipt) : [],
  );
  for (const acceptedId of acceptedIds) {
    if (!receiptIds.has(acceptedId)) {
      receiptSources.push({ channel: "whatsapp", messageId: acceptedId });
    }
  }
  const receipt = createMessageReceiptFromOutboundResults({
    kind: resolveWhatsAppReceiptKind(params.kind),
    results: receiptSources,
  });
  const accepted = requireWhatsAppAcceptedSendResult({
    kind: params.kind,
    messageId,
    receipt,
    keys: acceptedIds.map((id) => ({ id })),
    providerAccepted: true,
  });
  activityAccountedWhatsAppSendResults.add(accepted);
  params.results.push(accepted);
  return true;
}

/** Merge accepted local sends with nested partial receipts without inventing provider ids. */
export function mergeWhatsAppAcceptedSendError(params: {
  error: unknown;
  kind: WhatsAppSendKind;
  results: readonly WhatsAppSendResult[];
}): unknown {
  const nested = isChannelPartialDeliveryError(params.error)
    ? params.error.deliveryResult
    : undefined;
  const receiptSources: Array<MessageReceiptSourceResult & { receipt?: MessageReceipt }> = [];
  const recordedIds = new Set<string>();
  for (const result of params.results) {
    const resultIds = listWhatsAppSendResultMessageIds(result);
    if (resultIds.every((messageId) => recordedIds.has(messageId))) {
      continue;
    }
    receiptSources.push({
      channel: "whatsapp",
      messageId: result.messageId,
      ...(result.receipt ? { receipt: result.receipt } : {}),
    });
    for (const messageId of resultIds) {
      recordedIds.add(messageId);
    }
  }
  const nestedIds = uniqueStrings([
    ...(nested?.receipt ? listMessageReceiptPlatformIds(nested.receipt) : []),
    ...normalizeStringEntries(nested?.messageIds ?? []),
  ]).filter((messageId) => messageId !== "unknown");
  const unrecordedNestedIds = nestedIds.filter((messageId) => !recordedIds.has(messageId));
  const nestedMessageId = unrecordedNestedIds[0];
  if (nested?.receipt && nestedMessageId) {
    receiptSources.push({
      channel: "whatsapp",
      messageId: nestedMessageId,
      receipt: nested.receipt,
    });
    for (const messageId of listMessageReceiptPlatformIds(nested.receipt)) {
      recordedIds.add(messageId);
    }
  }
  for (const messageId of unrecordedNestedIds) {
    if (!recordedIds.has(messageId)) {
      receiptSources.push({ channel: "whatsapp", messageId });
    }
  }
  const receipt = enrichWhatsAppDeliveryReceipt({
    receipt: createMessageReceiptFromOutboundResults({
      kind: resolveWhatsAppReceiptKind(params.kind),
      results: receiptSources,
    }),
    sources: [
      ...params.results.flatMap((result) => (result.receipt ? [result.receipt] : [])),
      ...(nested?.receipt ? [nested.receipt] : []),
    ],
  });
  const messageIds = listMessageReceiptPlatformIds(receipt);
  if (messageIds.length === 0) {
    return params.error;
  }
  let cause: unknown = params.error;
  const visitedPartialErrors = new Set<unknown>();
  while (
    isChannelPartialDeliveryError(cause) &&
    cause instanceof Error &&
    cause.cause !== undefined &&
    !visitedPartialErrors.has(cause)
  ) {
    visitedPartialErrors.add(cause);
    cause = cause.cause;
  }
  return createChannelPartialDeliveryError(cause, {
    ...nested,
    messageIds,
    receipt,
    visibleReplySent: true,
  });
}

export function combineWhatsAppSendResults(
  kind: WhatsAppSendKind,
  results: readonly WhatsAppSendResult[],
): WhatsAppSendResult {
  const messageIds = uniqueStrings(results.flatMap(listWhatsAppSendResultMessageIds));
  const messageId = messageIds[0];
  if (!messageId) {
    throw createWhatsAppProviderNotAcceptedError(kind);
  }
  const keys = results.flatMap((result) => result.keys);
  const combined: WhatsAppSendResult = {
    kind,
    messageId,
    receipt: createWhatsAppSendReceipt(kind, keys),
    keys,
    providerAccepted: results.some((result) => result.providerAccepted),
  };
  if (results.some((result) => activityAccountedWhatsAppSendResults.has(result))) {
    activityAccountedWhatsAppSendResults.add(combined);
  }
  return combined;
}

export function listWhatsAppSendResultMessageIds(result: WhatsAppSendResult): string[] {
  const receiptIds = result.receipt ? listMessageReceiptPlatformIds(result.receipt) : [];
  if (receiptIds.length > 0) {
    return receiptIds;
  }
  const keyIds = normalizeStringEntries(result.keys.map((key) => key.id));
  if (keyIds.length > 0) {
    return uniqueStrings(keyIds);
  }
  return [];
}
