import { randomUUID } from "node:crypto";

import type { AnyMessageContent } from "@whiskeysockets/baileys";

import { logVerbose } from "../globals.js";
import { logInfo } from "../logger.js";
import { getChildLogger } from "../logging.js";
import { toWhatsappJid } from "../utils.js";
import { loadWebMedia } from "./media.js";
import { createWaSocket, waitForWaConnection } from "./session.js";

export async function sendMessageWeb(
  to: string,
  body: string,
  options: { verbose: boolean; mediaUrl?: string },
): Promise<{ messageId: string; toJid: string }> {
  const correlationId = randomUUID();
  const sock = await createWaSocket(false, options.verbose);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to,
  });
  try {
    logInfo("🔌 Connecting to WhatsApp Web…");
    logger.info("connecting to whatsapp web");
    await waitForWaConnection(sock);
    // waitForWaConnection sets up listeners and error handling; keep the presence update safe.
    const jid = toWhatsappJid(to);
    try {
      await sock.sendPresenceUpdate("composing", jid);
    } catch (err) {
      logVerbose(`Presence update skipped: ${String(err)}`);
    }
    let payload: AnyMessageContent = { text: body };
    if (options.mediaUrl) {
      const media = await loadWebMedia(options.mediaUrl);
      const caption = body || undefined;
      if (media.kind === "audio") {
        // WhatsApp expects explicit opus codec for PTT voice notes.
        const mimetype =
          media.contentType === "audio/ogg"
            ? "audio/ogg; codecs=opus"
            : (media.contentType ?? "application/octet-stream");
        payload = { audio: media.buffer, ptt: true, mimetype };
      } else if (media.kind === "video") {
        const mimetype = media.contentType ?? "application/octet-stream";
        payload = {
          video: media.buffer,
          caption,
          mimetype,
        };
      } else if (media.kind === "image") {
        const mimetype = media.contentType ?? "application/octet-stream";
        payload = {
          image: media.buffer,
          caption,
          mimetype,
        };
      } else {
        // Fallback to document for anything else (pdf, etc.).
        const fileName = media.fileName ?? "file";
        const mimetype = media.contentType ?? "application/octet-stream";
        payload = {
          document: media.buffer,
          fileName,
          caption,
          mimetype,
        };
      }
    }
    logInfo(
      `📤 Sending via web session -> ${jid}${options.mediaUrl ? " (media)" : ""}`,
    );
    logger.info(
      { jid, hasMedia: Boolean(options.mediaUrl) },
      "sending message",
    );
    const result = await sock.sendMessage(jid, payload);
    const messageId = result?.key?.id ?? "unknown";
    logInfo(
      `✅ Sent via web session. Message ID: ${messageId} -> ${jid}${options.mediaUrl ? " (media)" : ""}`,
    );
    logger.info({ jid, messageId }, "sent message");
    return { messageId, toJid: jid };
  } finally {
    try {
      sock.ws?.close();
    } catch (err) {
      logVerbose(`Socket close failed: ${String(err)}`);
    }
  }
}
