import type { proto, WAMessage } from "@whiskeysockets/baileys";
import {
  downloadMediaMessage,
  normalizeMessageContent,
} from "@whiskeysockets/baileys";
import { logVerbose } from "../../globals.js";
import type { createWaSocket } from "../session.js";

function unwrapMessage(
  message: proto.IMessage | undefined,
): proto.IMessage | undefined {
  const normalized = normalizeMessageContent(
    message as proto.IMessage | undefined,
  );
  return normalized as proto.IMessage | undefined;
}

export async function downloadInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
): Promise<{ buffer: Buffer; mimetype?: string } | undefined> {
  const message = unwrapMessage(msg.message as proto.IMessage | undefined);
  if (!message) return undefined;
  const mimetype =
    message.imageMessage?.mimetype ??
    message.videoMessage?.mimetype ??
    message.documentMessage?.mimetype ??
    message.audioMessage?.mimetype ??
    message.stickerMessage?.mimetype ??
    undefined;
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
    const buffer = (await downloadMediaMessage(
      msg as WAMessage,
      "buffer",
      {},
      {
        reuploadRequest: sock.updateMediaMessage,
        logger: sock.logger,
      },
    )) as Buffer;
    return { buffer, mimetype };
  } catch (err) {
    logVerbose(`downloadMediaMessage failed: ${String(err)}`);
    return undefined;
  }
}
