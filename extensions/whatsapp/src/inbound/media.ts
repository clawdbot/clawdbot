import type { proto, WAMessage } from "baileys";
import { saveMediaStream, type SavedMedia } from "openclaw/plugin-sdk/media-store";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { createWaSocket } from "../session.js";
import { extractContextInfo } from "./extract.js";
import { downloadMediaMessage, normalizeMessageContent } from "./runtime-api.js";

export class WhatsAppInboundMediaLimitExceededError extends Error {
  constructor(maxBytes: number) {
    super(`Media exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    this.name = "WhatsAppInboundMediaLimitExceededError";
  }
}

function unwrapMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  const normalized = normalizeMessageContent(message);
  return normalized;
}

/**
 * Resolve the MIME type for an inbound media message.
 * Falls back to WhatsApp's standard formats when Baileys omits the MIME.
 */
function resolveMediaMimetype(message: proto.IMessage): string | undefined {
  const explicit =
    message.imageMessage?.mimetype ??
    message.videoMessage?.mimetype ??
    message.documentMessage?.mimetype ??
    message.audioMessage?.mimetype ??
    message.stickerMessage?.mimetype ??
    undefined;
  if (explicit) {
    return explicit;
  }
  // WhatsApp voice messages (PTT) and audio use OGG Opus by default
  if (message.audioMessage) {
    return "audio/ogg; codecs=opus";
  }
  if (message.imageMessage) {
    return "image/jpeg";
  }
  if (message.videoMessage) {
    return "video/mp4";
  }
  if (message.stickerMessage) {
    return "image/webp";
  }
  return undefined;
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
  const mimetype = resolveMediaMimetype(message);
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
  try {
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
    ).catch((err) => {
      if (err instanceof Error && /Media exceeds/i.test(err.message)) {
        throw new WhatsAppInboundMediaLimitExceededError(maxBytes);
      }
      throw err;
    });
    return { saved, mimetype, fileName };
  } catch (err) {
    if (err instanceof WhatsAppInboundMediaLimitExceededError) {
      throw err;
    }
    logVerbose(`downloadMediaMessage failed: ${String(err)}`);
    return undefined;
  }
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
  );
}
