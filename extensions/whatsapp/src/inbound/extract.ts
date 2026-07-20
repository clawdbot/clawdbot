// Whatsapp plugin module implements extract behavior.
import type { proto } from "baileys";
import { extractMessageContent, getContentType, normalizeMessageContent } from "baileys";
import {
  formatLocationText,
  type ChannelInboundMediaInput,
  type NormalizedLocation,
} from "openclaw/plugin-sdk/channel-inbound";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveComparableIdentity, type WhatsAppReplyContext } from "../identity.js";
import { jidToE164 } from "../text-runtime.js";
import { parseVcard } from "../vcard.js";
import { resolveInboundMediaMimetype } from "./media-mimetype.js";
import type { WhatsAppStructuredContactContext } from "./types.js";

function getFutureProofInnerMessage(message: proto.IMessage): proto.IMessage | undefined {
  const contentType = getContentType(message);
  const candidate = contentType ? (message as Record<string, unknown>)[contentType] : undefined;
  if (
    candidate &&
    typeof candidate === "object" &&
    "message" in candidate &&
    (candidate as { message?: unknown }).message &&
    typeof (candidate as { message: unknown }).message === "object"
  ) {
    const inner = normalizeMessageContent((candidate as { message: proto.IMessage }).message);
    if (inner) {
      const innerType = getContentType(inner);
      if (innerType && innerType !== contentType) {
        return inner;
      }
    }
  }
  return undefined;
}

function buildMessageChain(message: proto.IMessage | undefined): proto.IMessage[] {
  const chain: proto.IMessage[] = [];
  let current = normalizeMessageContent(message);
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
  const contentType = getContentType(message);
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
  return uniqueStrings(flattened);
}

export function extractText(rawMessage: proto.IMessage | undefined): string | undefined {
  const message = unwrapMessage(rawMessage);
  if (!message) {
    return undefined;
  }
  const extracted = extractMessageContent(message);
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

export function extractExternalAdReplyContext(rawMessage: proto.IMessage | undefined):
  | {
      title?: string;
      sourceUrl?: string;
      body?: string;
    }
  | undefined {
  const message = unwrapMessage(rawMessage);
  const adReply =
    message?.imageMessage?.contextInfo?.externalAdReply ??
    message?.videoMessage?.contextInfo?.externalAdReply;
  if (!adReply) {
    return undefined;
  }
  const title = adReply.title?.trim() || undefined;
  const sourceUrl = adReply.sourceUrl?.trim() || undefined;
  const body = adReply.body?.trim() || undefined;
  return title || sourceUrl || body ? { title, sourceUrl, body } : undefined;
}

export function extractMediaKind(
  rawMessage: proto.IMessage | undefined,
): NonNullable<ChannelInboundMediaInput["kind"]> | undefined {
  const message = unwrapMessage(rawMessage);
  if (!message) {
    return undefined;
  }
  if (message.imageMessage) {
    return "image";
  }
  if (message.videoMessage) {
    // GIF playback is a video transport detail; no downstream behavior needs a new GIF kind.
    return "video";
  }
  if (message.audioMessage) {
    return "audio";
  }
  if (message.documentMessage) {
    return "document";
  }
  if (message.stickerMessage) {
    return "sticker";
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
  const quoted = normalizeMessageContent(contextInfo?.quotedMessage as proto.IMessage | undefined);
  if (!quoted) {
    return null;
  }
  const location = extractLocationData(quoted);
  const locationText = location ? formatLocationText(location) : undefined;
  const text = extractText(quoted);
  const body = [text, locationText].filter(Boolean).join("\n").trim();
  const mediaKind = extractMediaKind(quoted);
  const media = mediaKind
    ? { kind: mediaKind, contentType: resolveInboundMediaMimetype(quoted) }
    : undefined;
  if (!body && !media) {
    const quotedType = quoted ? getContentType(quoted) : undefined;
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
    body: body ?? "",
    media,
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
  if (extractMediaKind(rawMessage)) {
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
