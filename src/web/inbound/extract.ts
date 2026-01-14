import type { proto } from "@whiskeysockets/baileys";
import {
  extractMessageContent,
  getContentType,
  normalizeMessageContent,
} from "@whiskeysockets/baileys";
import {
  formatLocationText,
  type NormalizedLocation,
} from "../../channels/location.js";
import { logVerbose } from "../../globals.js";
import { jidToE164 } from "../../utils.js";
import { parseVcard } from "../vcard.js";

function unwrapMessage(
  message: proto.IMessage | undefined,
): proto.IMessage | undefined {
  const normalized = normalizeMessageContent(
    message as proto.IMessage | undefined,
  );
  return normalized as proto.IMessage | undefined;
}

function extractContextInfo(
  message: proto.IMessage | undefined,
): proto.IContextInfo | undefined {
  if (!message) return undefined;
  const contentType = getContentType(message);
  const candidate = contentType
    ? (message as Record<string, unknown>)[contentType]
    : undefined;
  const contextInfo =
    candidate && typeof candidate === "object" && "contextInfo" in candidate
      ? (candidate as { contextInfo?: proto.IContextInfo }).contextInfo
      : undefined;
  if (contextInfo) return contextInfo;
  const fallback =
    message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.documentMessage?.contextInfo ??
    message.audioMessage?.contextInfo ??
    message.stickerMessage?.contextInfo ??
    message.buttonsResponseMessage?.contextInfo ??
    message.listResponseMessage?.contextInfo ??
    message.templateButtonReplyMessage?.contextInfo ??
    message.interactiveResponseMessage?.contextInfo ??
    message.buttonsMessage?.contextInfo ??
    message.listMessage?.contextInfo;
  if (fallback) return fallback;
  for (const value of Object.values(message)) {
    if (!value || typeof value !== "object") continue;
    if (!("contextInfo" in value)) continue;
    const candidateContext = (value as { contextInfo?: proto.IContextInfo })
      .contextInfo;
    if (candidateContext) return candidateContext;
  }
  return undefined;
}

export function extractMentionedJids(
  rawMessage: proto.IMessage | undefined,
): string[] | undefined {
  const message = unwrapMessage(rawMessage);
  if (!message) return undefined;

  const candidates: Array<string[] | null | undefined> = [
    message.extendedTextMessage?.contextInfo?.mentionedJid,
    message.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage
      ?.contextInfo?.mentionedJid,
    message.imageMessage?.contextInfo?.mentionedJid,
    message.videoMessage?.contextInfo?.mentionedJid,
    message.documentMessage?.contextInfo?.mentionedJid,
    message.audioMessage?.contextInfo?.mentionedJid,
    message.stickerMessage?.contextInfo?.mentionedJid,
    message.buttonsResponseMessage?.contextInfo?.mentionedJid,
    message.listResponseMessage?.contextInfo?.mentionedJid,
  ];

  const flattened = candidates.flatMap((arr) => arr ?? []).filter(Boolean);
  if (flattened.length === 0) return undefined;
  return Array.from(new Set(flattened));
}

export function extractText(
  rawMessage: proto.IMessage | undefined,
): string | undefined {
  const message = unwrapMessage(rawMessage);
  if (!message) return undefined;
  const extracted = extractMessageContent(message);
  const candidates = [
    message,
    extracted && extracted !== message ? extracted : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (
      typeof candidate.conversation === "string" &&
      candidate.conversation.trim()
    ) {
      return candidate.conversation.trim();
    }
    const extended = candidate.extendedTextMessage?.text;
    if (extended?.trim()) return extended.trim();
    const caption =
      candidate.imageMessage?.caption ??
      candidate.videoMessage?.caption ??
      candidate.documentMessage?.caption;
    if (caption?.trim()) return caption.trim();
  }
  const contactPlaceholder =
    extractContactPlaceholder(message) ??
    (extracted && extracted !== message
      ? extractContactPlaceholder(extracted as proto.IMessage | undefined)
      : undefined);
  if (contactPlaceholder) return contactPlaceholder;
  return undefined;
}

export function extractMediaPlaceholder(
  rawMessage: proto.IMessage | undefined,
): string | undefined {
  const message = unwrapMessage(rawMessage);
  if (!message) return undefined;
  if (message.imageMessage) return "<media:image>";
  if (message.videoMessage) return "<media:video>";
  if (message.audioMessage) return "<media:audio>";
  if (message.documentMessage) return "<media:document>";
  if (message.stickerMessage) return "<media:sticker>";
  return undefined;
}

function extractContactPlaceholder(
  rawMessage: proto.IMessage | undefined,
): string | undefined {
  const message = unwrapMessage(rawMessage);
  if (!message) return undefined;
  const contact = message.contactMessage ?? undefined;
  if (contact) {
    const { name, phones } = describeContact({
      displayName: contact.displayName,
      vcard: contact.vcard,
    });
    return formatContactPlaceholder(name, phones);
  }
  const contactsArray = message.contactsArrayMessage?.contacts ?? undefined;
  if (!contactsArray || contactsArray.length === 0) return undefined;
  const labels = contactsArray
    .map((entry) =>
      describeContact({ displayName: entry.displayName, vcard: entry.vcard }),
    )
    .map((entry) => formatContactLabel(entry.name, entry.phones))
    .filter((value): value is string => Boolean(value));
  return formatContactsPlaceholder(labels, contactsArray.length);
}

function describeContact(input: {
  displayName?: string | null;
  vcard?: string | null;
}): { name?: string; phones: string[] } {
  const displayName = (input.displayName ?? "").trim();
  const parsed = parseVcard(input.vcard ?? undefined);
  const name = displayName || parsed.name;
  return { name, phones: parsed.phones };
}

function formatContactPlaceholder(name?: string, phones?: string[]): string {
  const label = formatContactLabel(name, phones);
  if (!label) return "<contact>";
  return `<contact: ${label}>`;
}

function formatContactsPlaceholder(labels: string[], total: number): string {
  const cleaned = labels.map((label) => label.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    const suffix = total === 1 ? "contact" : "contacts";
    return `<contacts: ${total} ${suffix}>`;
  }
  const remaining = Math.max(total - cleaned.length, 0);
  const suffix = remaining > 0 ? ` +${remaining} more` : "";
  return `<contacts: ${cleaned.join(", ")}${suffix}>`;
}

function formatContactLabel(
  name?: string,
  phones?: string[],
): string | undefined {
  const phoneLabel = formatPhoneList(phones);
  const parts = [name, phoneLabel].filter((value): value is string =>
    Boolean(value),
  );
  if (parts.length === 0) return undefined;
  return parts.join(", ");
}

function formatPhoneList(phones?: string[]): string | undefined {
  const cleaned = phones?.map((phone) => phone.trim()).filter(Boolean) ?? [];
  if (cleaned.length === 0) return undefined;
  const { shown, remaining } = summarizeList(cleaned, cleaned.length, 1);
  const [primary] = shown;
  if (!primary) return undefined;
  if (remaining === 0) return primary;
  return `${primary} (+${remaining} more)`;
}

function summarizeList(
  values: string[],
  total: number,
  maxShown: number,
): { shown: string[]; remaining: number } {
  const shown = values.slice(0, maxShown);
  const remaining = Math.max(total - shown.length, 0);
  return { shown, remaining };
}

export function extractLocationData(
  rawMessage: proto.IMessage | undefined,
): NormalizedLocation | null {
  const message = unwrapMessage(rawMessage);
  if (!message) return null;

  const live = message.liveLocationMessage ?? undefined;
  if (live) {
    const latitudeRaw = live.degreesLatitude;
    const longitudeRaw = live.degreesLongitude;
    if (latitudeRaw != null && longitudeRaw != null) {
      const latitude = Number(latitudeRaw);
      const longitude = Number(longitudeRaw);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        return {
          latitude,
          longitude,
          accuracy: live.accuracyInMeters ?? undefined,
          caption: live.caption ?? undefined,
          source: "live",
          isLive: true,
        };
      }
    }
  }

  const location = message.locationMessage ?? undefined;
  if (location) {
    const latitudeRaw = location.degreesLatitude;
    const longitudeRaw = location.degreesLongitude;
    if (latitudeRaw != null && longitudeRaw != null) {
      const latitude = Number(latitudeRaw);
      const longitude = Number(longitudeRaw);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        const isLive = Boolean(location.isLive);
        return {
          latitude,
          longitude,
          accuracy: location.accuracyInMeters ?? undefined,
          name: location.name ?? undefined,
          address: location.address ?? undefined,
          caption: location.comment ?? undefined,
          source: isLive
            ? "live"
            : location.name || location.address
              ? "place"
              : "pin",
          isLive,
        };
      }
    }
  }

  return null;
}

export function describeReplyContext(rawMessage: proto.IMessage | undefined): {
  id?: string;
  body: string;
  sender: string;
} | null {
  const message = unwrapMessage(rawMessage);
  if (!message) return null;
  const contextInfo = extractContextInfo(message);
  const quoted = normalizeMessageContent(
    contextInfo?.quotedMessage as proto.IMessage | undefined,
  ) as proto.IMessage | undefined;
  if (!quoted) return null;
  const location = extractLocationData(quoted);
  const locationText = location ? formatLocationText(location) : undefined;
  const text = extractText(quoted);
  let body: string | undefined = [text, locationText]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!body) body = extractMediaPlaceholder(quoted);
  if (!body) {
    const quotedType = quoted ? getContentType(quoted) : undefined;
    logVerbose(
      `Quoted message missing extractable body${
        quotedType ? ` (type ${quotedType})` : ""
      }`,
    );
    return null;
  }
  const senderJid = contextInfo?.participant ?? undefined;
  const senderE164 = senderJid
    ? (jidToE164(senderJid) ?? senderJid)
    : undefined;
  const sender = senderE164 ?? "unknown sender";
  return {
    id: contextInfo?.stanzaId ? String(contextInfo.stanzaId) : undefined,
    body,
    sender,
  };
}
