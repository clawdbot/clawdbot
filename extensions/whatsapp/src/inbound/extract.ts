import type { proto } from "@whiskeysockets/baileys";
import {
  extractMessageContent,
  getContentType,
  normalizeMessageContent,
} from "@whiskeysockets/baileys";
import { formatLocationText, type NormalizedLocation } from "openclaw/plugin-sdk/channel-inbound";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveComparableIdentity, type WhatsAppReplyContext } from "../identity.js";
import { jidToE164 } from "../text-runtime.js";
import { parseVcard } from "../vcard.js";
import type { WhatsAppStructuredContactContext } from "./types.js";

const MESSAGE_WRAPPER_KEYS = [
  "botInvokeMessage",
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "groupMentionedMessage",
] as const;

const MESSAGE_CONTENT_KEYS = [
  "conversation",
  "extendedTextMessage",
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
  "locationMessage",
  "liveLocationMessage",
  "contactMessage",
  "contactsArrayMessage",
  "buttonsResponseMessage",
  "listResponseMessage",
  "templateButtonReplyMessage",
  "interactiveResponseMessage",
  "buttonsMessage",
  "listMessage",
] as const;

function fallbackNormalizeMessageContent(
  message: proto.IMessage | undefined,
): proto.IMessage | undefined {
  let current = message as unknown;
  while (current && typeof current === "object") {
    let unwrapped = false;
    for (const key of MESSAGE_WRAPPER_KEYS) {
      const candidate = (current as Record<string, unknown>)[key];
      if (
        candidate &&
        typeof candidate === "object" &&
        "message" in (candidate as Record<string, unknown>) &&
        (candidate as { message?: unknown }).message
      ) {
        current = (candidate as { message: unknown }).message;
        unwrapped = true;
        break;
      }
    }
    if (!unwrapped) {
      break;
    }
  }
  return current as proto.IMessage | undefined;
}

function normalizeMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  if (typeof normalizeMessageContent === "function") {
    return normalizeMessageContent(message);
  }
  return fallbackNormalizeMessageContent(message);
}

function fallbackGetContentType(
  message: proto.IMessage | undefined,
): keyof proto.IMessage | undefined {
  const normalized = fallbackNormalizeMessageContent(message);
  if (!normalized || typeof normalized !== "object") {
    return undefined;
  }
  for (const key of MESSAGE_CONTENT_KEYS) {
    if ((normalized as Record<string, unknown>)[key] != null) {
      return key as keyof proto.IMessage;
    }
  }
  return undefined;
}

function getMessageContentType(
  message: proto.IMessage | undefined,
): keyof proto.IMessage | undefined {
  if (typeof getContentType === "function") {
    return getContentType(message);
  }
  return fallbackGetContentType(message);
}

function extractMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  if (typeof extractMessageContent === "function") {
    return extractMessageContent(message);
  }
  const normalized = fallbackNormalizeMessageContent(message);
  const contentType = fallbackGetContentType(normalized);
  if (!normalized || !contentType || contentType === "conversation") {
    return normalized;
  }
  const candidate = (normalized as Record<string, unknown>)[contentType];
  return candidate && typeof candidate === "object" ? (candidate as proto.IMessage) : normalized;
}

function getFutureProofInnerMessage(message: proto.IMessage): proto.IMessage | undefined {
  const contentType = getMessageContentType(message);
  const candidate = contentType ? (message as Record<string, unknown>)[contentType] : undefined;
  if (
    candidate &&
    typeof candidate === "object" &&
    "message" in candidate &&
    (candidate as { message?: unknown }).message &&
    typeof (candidate as { message: unknown }).message === "object"
  ) {
    const inner = normalizeMessage((candidate as { message: proto.IMessage }).message);
    if (inner) {
      const innerType = getMessageContentType(inner);
      if (innerType && innerType !== contentType) {
        return inner;
      }
    }
  }
  return undefined;
}

function buildMessageChain(message: proto.IMessage | undefined): proto.IMessage[] {
  const chain: proto.IMessage[] = [];
  let current = normalizeMessage(message);
  while (current && chain.length < 4) {
    chain.push(current);
    current = getFutureProofInnerMessage(current);
  }
  return chain;
}

function unwrapMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  const chain = buildMessageChain(message);
  return chain.at(-1);
}

function extractContextInfoFromMessage(message: proto.IMessage): proto.IContextInfo | undefined {
  const contentType = getMessageContentType(message);
  const candidate = contentType ? (message as Record<string, unknown>)[contentType] : undefined;
  const contextInfo =
    candidate && typeof candidate === "object" && "contextInfo" in candidate
      ? (candidate as { contextInfo?: proto.IContextInfo }).contextInfo
      : undefined;
  if (contextInfo) {
    return contextInfo;
  }
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
  if (fallback) {
    return fallback;
  }
  for (const value of Object.values(message)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    if ("contextInfo" in value) {
      const candidateContext = (value as { contextInfo?: proto.IContextInfo }).contextInfo;
      if (candidateContext) {
        return candidateContext;
      }
    }
    // FutureProofMessage wrapper: dig into .message to find contextInfo
    if ("message" in value) {
      const inner = (value as { message?: proto.IMessage }).message;
      if (inner) {
        const innerCtx = extractContextInfo(inner);
        if (innerCtx) {
          return innerCtx;
        }
      }
    }
  }
  return undefined;
}

export function extractContextInfo(
  message: proto.IMessage | undefined,
): proto.IContextInfo | undefined {
  for (const candidate of buildMessageChain(message)) {
    const contextInfo = extractContextInfoFromMessage(candidate);
    if (contextInfo) {
      return contextInfo;
    }
  }
  return undefined;
}

export function extractMentionedJids(rawMessage: proto.IMessage | undefined): string[] | undefined {
  const message = unwrapMessage(rawMessage);
  if (!message) {
    return undefined;
  }

  const candidates: Array<string[] | null | undefined> = [
    message.extendedTextMessage?.contextInfo?.mentionedJid,
    message.imageMessage?.contextInfo?.mentionedJid,
    message.videoMessage?.contextInfo?.mentionedJid,
    message.documentMessage?.contextInfo?.mentionedJid,
    message.audioMessage?.contextInfo?.mentionedJid,
    message.stickerMessage?.contextInfo?.mentionedJid,
    message.buttonsResponseMessage?.contextInfo?.mentionedJid,
    message.listResponseMessage?.contextInfo?.mentionedJid,
  ];

  const flattened = candidates.flatMap((arr) => arr ?? []).filter(Boolean);
  if (flattened.length === 0) {
    return undefined;
  }
  return Array.from(new Set(flattened));
}

export function extractText(rawMessage: proto.IMessage | undefined): string | undefined {
  const message = unwrapMessage(rawMessage);
  if (!message) {
    return undefined;
  }
  const extracted = extractMessage(message);
  const candidates = [message, extracted && extracted !== message ? extracted : undefined];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (typeof candidate.conversation === "string" && candidate.conversation.trim()) {
      return candidate.conversation.trim();
    }
    const extended = candidate.extendedTextMessage?.text;
    if (extended?.trim()) {
      return extended.trim();
    }
    const caption =
      candidate.imageMessage?.caption ??
      candidate.videoMessage?.caption ??
      candidate.documentMessage?.caption;
    if (caption?.trim()) {
      return caption.trim();
    }
  }
  const contactPlaceholder =
    extractContactPlaceholder(message) ??
    (extracted && extracted !== message
      ? extractContactPlaceholder(extracted as proto.IMessage | undefined)
      : undefined);
  if (contactPlaceholder) {
    return contactPlaceholder;
  }
  return undefined;
}

export function extractMediaPlaceholder(
  rawMessage: proto.IMessage | undefined,
): string | undefined {
  const message = unwrapMessage(rawMessage);
  if (!message) {
    return undefined;
  }
  if (message.imageMessage) {
    return "<media:image>";
  }
  if (message.videoMessage) {
    return "<media:video>";
  }
  if (message.audioMessage) {
    return "<media:audio>";
  }
  if (message.documentMessage) {
    return "<media:document>";
  }
  if (message.stickerMessage) {
    return "<media:sticker>";
  }
  return undefined;
}

function extractContactPlaceholder(rawMessage: proto.IMessage | undefined): string | undefined {
  const contactContext = extractContactContext(rawMessage);
  if (!contactContext) {
    return undefined;
  }
  if (contactContext.kind === "contact") {
    return "<contact>";
  }
  const suffix = contactContext.total === 1 ? "contact" : "contacts";
  return `<contacts: ${contactContext.total} ${suffix}>`;
}

export function extractContactContext(
  rawMessage: proto.IMessage | undefined,
): WhatsAppStructuredContactContext | undefined {
  const message = unwrapMessage(rawMessage);
  if (!message) {
    return undefined;
  }
  const contact = message.contactMessage ?? undefined;
  if (contact) {
    const { name, phones } = describeContact({
      displayName: contact.displayName,
      vcard: contact.vcard,
    });
    return {
      kind: "contact",
      total: 1,
      contacts: [{ name, phones }],
    };
  }
  const contactsArray = message.contactsArrayMessage?.contacts ?? undefined;
  if (!contactsArray || contactsArray.length === 0) {
    return undefined;
  }
  return {
    kind: "contacts",
    total: contactsArray.length,
    contacts: contactsArray.map((entry) =>
      describeContact({ displayName: entry.displayName, vcard: entry.vcard }),
    ),
  };
}

function describeContact(input: { displayName?: string | null; vcard?: string | null }): {
  name?: string;
  phones: string[];
} {
  const displayName = (input.displayName ?? "").trim();
  const parsed = parseVcard(input.vcard ?? undefined);
  const name = displayName || parsed.name;
  return { name, phones: parsed.phones };
}

export function extractLocationData(
  rawMessage: proto.IMessage | undefined,
): NormalizedLocation | null {
  const message = unwrapMessage(rawMessage);
  if (!message) {
    return null;
  }

  const live = message.liveLocationMessage ?? undefined;
  if (live) {
    const latitudeRaw = live.degreesLatitude;
    const longitudeRaw = live.degreesLongitude;
    if (latitudeRaw != null && longitudeRaw != null) {
      const latitude = latitudeRaw;
      const longitude = longitudeRaw;
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
      const latitude = latitudeRaw;
      const longitude = longitudeRaw;
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        const isLive = Boolean(location.isLive);
        return {
          latitude,
          longitude,
          accuracy: location.accuracyInMeters ?? undefined,
          name: location.name ?? undefined,
          address: location.address ?? undefined,
          caption: location.comment ?? undefined,
          source: isLive ? "live" : location.name || location.address ? "place" : "pin",
          isLive,
        };
      }
    }
  }

  return null;
}

export function describeReplyContext(
  rawMessage: proto.IMessage | undefined,
): WhatsAppReplyContext | null {
  const message = unwrapMessage(rawMessage);
  if (!message) {
    return null;
  }
  const contextInfo = extractContextInfo(message);
  const quoted = normalizeMessage(contextInfo?.quotedMessage as proto.IMessage | undefined);
  if (!quoted) {
    return null;
  }
  const location = extractLocationData(quoted);
  const locationText = location ? formatLocationText(location) : undefined;
  const text = extractText(quoted);
  let body: string | undefined = [text, locationText].filter(Boolean).join("\n").trim();
  if (!body) {
    body = extractMediaPlaceholder(quoted);
  }
  if (!body) {
    const quotedType = quoted ? getMessageContentType(quoted) : undefined;
    logVerbose(
      `Quoted message missing extractable body${quotedType ? ` (type ${quotedType})` : ""}`,
    );
    return null;
  }
  const senderJid = contextInfo?.participant ?? undefined;
  const sender = resolveComparableIdentity({
    jid: senderJid,
    label: senderJid ? (jidToE164(senderJid) ?? senderJid) : "unknown sender",
  });
  return {
    id: contextInfo?.stanzaId || undefined,
    body,
    sender,
  };
}

function hasInteractiveResponseContent(message: proto.IMessage | undefined): boolean {
  if (!message) {
    return false;
  }
  // Button/list/template/interactive selections that the existing four
  // extractors do not cover. Treat any presence of these keys as user
  // content — Baileys never delivers these as receipts or protocol
  // envelopes, only as explicit user choices.
  return Boolean(
    message.buttonsResponseMessage ||
    message.listResponseMessage ||
    message.templateButtonReplyMessage ||
    message.interactiveResponseMessage,
  );
}

/**
 * Fast check that a Baileys message carries user-visible inbound content
 * (text, media, contact, location, button/list selection). Returns false for
 * protocol/receipt/typing notifications that arrive on the same
 * `messages.upsert` stream as real messages but should not trigger pairing
 * access-control side effects.
 */
export function hasInboundUserContent(rawMessage: proto.IMessage | undefined): boolean {
  if (!rawMessage) {
    return false;
  }
  if (extractText(rawMessage)) {
    return true;
  }
  if (extractMediaPlaceholder(rawMessage)) {
    return true;
  }
  if (extractLocationData(rawMessage)) {
    return true;
  }
  // Walk wrappers (ephemeral, viewOnce, etc.) — interactive responses
  // can arrive nested.
  for (const candidate of buildMessageChain(rawMessage)) {
    if (hasInteractiveResponseContent(candidate)) {
      return true;
    }
  }
  return false;
}
