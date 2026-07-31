// Whatsapp plugin module implements media behavior.
import type { proto, WAMessage } from "baileys";
import type { SavedMedia } from "openclaw/plugin-sdk/media-store";
import type { createWaSocket } from "../session.js";
import { extractContextInfo } from "./extract.js";
import {
  saveInboundMediaStreamWithIdleTimeout,
  WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS,
} from "./media-chunk-idle.js";
import { resolveInboundMediaMimetype } from "./media-mimetype.js";
import { downloadMediaMessage, normalizeMessageContent } from "./runtime-api.js";

class WhatsAppInboundMediaLimitExceededError extends Error {
  constructor(maxBytes: number) {
    super(`Media exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    this.name = "WhatsAppInboundMediaLimitExceededError";
  }
}

function unwrapMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  const normalized = normalizeMessageContent(message);
  return normalized;
}

export async function downloadInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
  maxBytes = 50 * 1024 * 1024,
  options?: { chunkTimeoutMs?: number },
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
    !message.documentMessage &&
    !message.audioMessage &&
    !message.stickerMessage
  ) {
    return undefined;
  }
  const chunkTimeoutMs = options?.chunkTimeoutMs ?? WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS;
  const stream = await downloadMediaMessage(
    msg as WAMessage,
    "stream",
    {},
    {
      reuploadRequest: sock.updateMediaMessage,
      logger: sock.logger,
    },
  );
  const saved = await saveInboundMediaStreamWithIdleTimeout(
    stream as AsyncIterable<unknown>,
    mimetype,
    maxBytes,
    fileName,
    chunkTimeoutMs,
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
  options?: { chunkTimeoutMs?: number },
): Promise<{ saved: SavedMedia; mimetype?: string; fileName?: string } | undefined> {
  const message = unwrapMessage(msg.message as proto.IMessage | undefined);
  const contextInfo = extractContextInfo(message);
  if (!contextInfo?.quotedMessage) {
    return undefined;
  }
  const quotedMessage = contextInfo.quotedMessage;
  return downloadInboundMedia(
    {
      key: {
        id: contextInfo?.stanzaId || undefined,
        remoteJid: contextInfo.remoteJid ?? msg.key?.remoteJid ?? undefined,
        participant: contextInfo?.participant ?? undefined,
        fromMe: false,
      },
      message: quotedMessage,
      messageTimestamp: msg.messageTimestamp,
    },
    sock,
    maxBytes,
    options,
  );
}
