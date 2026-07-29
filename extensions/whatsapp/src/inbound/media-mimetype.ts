// Whatsapp plugin module implements inbound media MIME normalization.
import type { proto } from "baileys";

/**
 * Resolve the MIME type for an inbound media message.
 * Falls back to WhatsApp's standard formats when Baileys omits the MIME.
 */
export function resolveInboundMediaMimetype(message: proto.IMessage): string | undefined {
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
  // WhatsApp voice messages (PTT) and audio use OGG Opus by default.
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
