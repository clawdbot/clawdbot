import type { WAMessage, WAMessageKey } from "@whiskeysockets/baileys";

export type WhatsAppSendKind = "media" | "poll" | "reaction" | "text";

export type WhatsAppSendKey = Omit<
  Pick<WAMessageKey, "fromMe" | "id" | "participant" | "remoteJid">,
  "id"
> & {
  id: string;
};

export type WhatsAppSendResult = {
  kind: WhatsAppSendKind;
  messageId: string;
  messageIds: string[];
  keys: WhatsAppSendKey[];
  providerAccepted: boolean;
};

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
    messageIds: key ? [key.id] : [],
    keys: key ? [key] : [],
    providerAccepted: Boolean(key),
  };
}

export function combineWhatsAppSendResults(
  kind: WhatsAppSendKind,
  results: readonly WhatsAppSendResult[],
): WhatsAppSendResult {
  const messageIds = [...new Set(results.flatMap((result) => result.messageIds))];
  const keys = results.flatMap((result) => result.keys);
  return {
    kind,
    messageId: messageIds[0] ?? "unknown",
    messageIds,
    keys,
    providerAccepted: results.some((result) => result.providerAccepted),
  };
}

export function hasAcceptedWhatsAppSendResult(
  result: WhatsAppSendResult | undefined,
): result is WhatsAppSendResult {
  return result?.providerAccepted === true;
}
