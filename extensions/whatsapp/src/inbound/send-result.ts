import type { WAMessage, WAMessageKey } from "baileys";
import {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  type MessageReceipt,
  type MessageReceiptPartKind,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-message";

export type WhatsAppSendKind = "media" | "poll" | "reaction" | "text";

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

export function normalizeWhatsAppSendResult(
  result: WAMessage | undefined,
  kind: WhatsAppSendKind,
): WhatsAppSendResult {
  const key = normalizeKey(result?.key);
  const messageId = key?.id ?? "unknown";
  return {
    kind,
    messageId,
    receipt: createWhatsAppSendReceipt(kind, key ? [key] : []),
    keys: key ? [key] : [],
    providerAccepted: Boolean(key),
  };
}

export function combineWhatsAppSendResults(
  kind: WhatsAppSendKind,
  results: readonly WhatsAppSendResult[],
): WhatsAppSendResult {
  const messageIds = [...new Set(results.flatMap(listWhatsAppSendResultMessageIds))];
  const keys = results.flatMap((result) => result.keys);
  return {
    kind,
    messageId: messageIds[0] ?? "unknown",
    receipt: createWhatsAppSendReceipt(kind, keys),
    keys,
    providerAccepted: results.some((result) => result.providerAccepted),
  };
}

export function listWhatsAppSendResultMessageIds(result: WhatsAppSendResult): string[] {
  const receiptIds = result.receipt ? listMessageReceiptPlatformIds(result.receipt) : [];
  if (receiptIds.length > 0) {
    return receiptIds;
  }
  const keyIds = result.keys.map((key) => key.id.trim()).filter(Boolean);
  if (keyIds.length > 0) {
    return [...new Set(keyIds)];
  }
  return [];
}
