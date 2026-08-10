// Whatsapp plugin module implements media behavior.
import type { proto, WAMessage } from "baileys";
import { saveMediaStream, type SavedMedia } from "openclaw/plugin-sdk/media-store";
import { identitiesOverlap } from "../identity.js";
import type { createWaSocket } from "../session.js";
import { extractContextInfo } from "./extract.js";
import { resolveInboundMediaMimetype } from "./media-mimetype.js";
import { downloadMediaMessage, normalizeMessageContent } from "./runtime-api.js";

class WhatsAppInboundMediaLimitExceededError extends Error {
  constructor(maxBytes: number) {
    super(`Media exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    this.name = "WhatsAppInboundMediaLimitExceededError";
  }
}

const TRANSIENT_WHATSAPP_MEDIA_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
]);

function boomStatusCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const boom = err as { isBoom?: unknown; output?: { statusCode?: unknown } };
  if (boom.isBoom !== true) {
    return undefined;
  }
  return typeof boom.output?.statusCode === "number" ? boom.output.statusCode : undefined;
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

// Baileys' own reupload-on-410/404 retry never engages here (it keys off
// `error.status`, which @hapi/boom never sets), so we rethrow only errors a
// retry can plausibly fix; everything else, including the size limit, degrades.
export function isRetryableWhatsAppInboundMediaError(err: unknown): boolean {
  const statusCode = boomStatusCode(err);
  if (statusCode !== undefined) {
    return statusCode === 408 || statusCode === 429 || statusCode >= 500;
  }
  if (err instanceof WhatsAppInboundMediaLimitExceededError) {
    return false;
  }
  const code =
    errorCode(err) ??
    (err instanceof Error ? errorCode((err as { cause?: unknown }).cause) : undefined);
  return code !== undefined && TRANSIENT_WHATSAPP_MEDIA_NETWORK_CODES.has(code);
}

function unwrapMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  const normalized = normalizeMessageContent(message);
  return normalized;
}

export async function downloadInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
  maxBytes = 50 * 1024 * 1024,
): Promise<{ saved: SavedMedia; mimetype?: string; fileName?: string } | undefined> {
  const message = unwrapMessage(msg.message as proto.IMessage | undefined);
  if (!message) {
    return undefined;
  }
  const mimetype = resolveInboundMediaMimetype(message);
  const fileName = message.documentMessage?.fileName ?? undefined;
  if (
    !message.imageMessage &&
    !message.videoMessage &&
    !message.ptvMessage &&
    !message.documentMessage &&
    !message.audioMessage &&
    !message.stickerMessage
  ) {
    return undefined;
  }
  const stream = await downloadMediaMessage(
    msg as WAMessage,
    "stream",
    {},
    {
      reuploadRequest: sock.updateMediaMessage,
      logger: sock.logger,
    },
  );
  const saved = await saveMediaStream(
    stream as AsyncIterable<unknown>,
    mimetype,
    "inbound",
    maxBytes,
    fileName,
  ).catch((err: unknown) => {
    if (err instanceof Error && /Media exceeds/i.test(err.message)) {
      throw new WhatsAppInboundMediaLimitExceededError(maxBytes);
    }
    throw err;
  });
  return { saved, mimetype, fileName };
}

export async function downloadQuotedInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
  maxBytes = 50 * 1024 * 1024,
): Promise<{ saved: SavedMedia; mimetype?: string; fileName?: string } | undefined> {
  const message = unwrapMessage(msg.message as proto.IMessage | undefined);
  const contextInfo = extractContextInfo(message);
  if (!contextInfo?.quotedMessage) {
    return undefined;
  }
  const quotedMessage = contextInfo.quotedMessage;
  const self = sock.user;
  // Baileys copies fromMe into the media-reupload receipt; own quoted media must retain its author.
  const quotedFromMe = identitiesOverlap(
    { jid: contextInfo.participant },
    { jid: self?.id, lid: self?.lid, e164: self?.phoneNumber },
  );
  return downloadInboundMedia(
    {
      key: {
        id: contextInfo?.stanzaId || undefined,
        remoteJid: contextInfo.remoteJid ?? msg.key?.remoteJid ?? undefined,
        participant: contextInfo?.participant ?? undefined,
        fromMe: quotedFromMe,
      },
      message: quotedMessage,
      messageTimestamp: msg.messageTimestamp,
    },
    sock,
    maxBytes,
  );
}
