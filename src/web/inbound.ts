import type {
  AnyMessageContent,
  proto,
  WAMessage,
} from "@whiskeysockets/baileys";
import {
  DisconnectReason,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";

import { loadConfig } from "../config/config.js";
import { isVerbose, logVerbose } from "../globals.js";
import { getChildLogger } from "../logging.js";
import { saveMediaBuffer } from "../media/store.js";
import { jidToE164, normalizeE164 } from "../utils.js";
import {
  createWaSocket,
  getStatusCode,
  waitForWaConnection,
} from "./session.js";

export type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
};

export type WebInboundMessage = {
  id?: string;
  from: string;
  to: string;
  body: string;
  pushName?: string;
  timestamp?: number;
  sendComposing: () => Promise<void>;
  reply: (text: string) => Promise<void>;
  sendMedia: (payload: AnyMessageContent) => Promise<void>;
  mediaPath?: string;
  mediaType?: string;
  mediaUrl?: string;
};

export async function monitorWebInbox(options: {
  verbose: boolean;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
}) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const sock = await createWaSocket(false, options.verbose);
  await waitForWaConnection(sock);
  let onCloseResolve: ((reason: WebListenerCloseReason) => void) | null = null;
  const onClose = new Promise<WebListenerCloseReason>((resolve) => {
    onCloseResolve = resolve;
  });
  try {
    // Advertise that the relay is online right after connecting.
    await sock.sendPresenceUpdate("available");
    if (isVerbose()) logVerbose("Sent global 'available' presence on connect");
  } catch (err) {
    logVerbose(
      `Failed to send 'available' presence on connect: ${String(err)}`,
    );
  }
  const selfJid = sock.user?.id;
  const selfE164 = selfJid ? jidToE164(selfJid) : null;
  const seen = new Set<string>();

  sock.ev.on("messages.upsert", async (upsert) => {
    if (upsert.type !== "notify") return;
    for (const msg of upsert.messages) {
      const id = msg.key?.id ?? undefined;
      // De-dupe on message id; Baileys can emit retries.
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      // Note: not filtering fromMe here - echo detection happens in auto-reply layer
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid) continue;
      // Ignore status/broadcast traffic; we only care about direct chats.
      if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast"))
        continue;
      if (id) {
        const participant = msg.key?.participant;
        try {
          await sock.readMessages([
            { remoteJid, id, participant, fromMe: false },
          ]);
          if (isVerbose()) {
            const suffix = participant ? ` (participant ${participant})` : "";
            logVerbose(
              `Marked message ${id} as read for ${remoteJid}${suffix}`,
            );
          }
        } catch (err) {
          logVerbose(`Failed to mark message ${id} read: ${String(err)}`);
        }
      }
      const from = jidToE164(remoteJid);
      if (!from) continue;

      // Filter unauthorized senders early to prevent wasted processing
      // and potential session corruption from Bad MAC errors
      const cfg = loadConfig();
      const allowFrom = cfg.inbound?.allowFrom;
      const isSamePhone = from === selfE164;

      if (!isSamePhone && Array.isArray(allowFrom) && allowFrom.length > 0) {
        if (!allowFrom.includes("*") && !allowFrom.map(normalizeE164).includes(from)) {
          logVerbose(`Blocked unauthorized sender ${from} (not in allowFrom list)`);
          continue; // Skip processing entirely
        }
      }

      let body = extractText(msg.message ?? undefined);
      if (!body) {
        body = extractMediaPlaceholder(msg.message ?? undefined);
        if (!body) continue;
      }
      let mediaPath: string | undefined;
      let mediaType: string | undefined;
      try {
        const inboundMedia = await downloadInboundMedia(msg, sock);
        if (inboundMedia) {
          const saved = await saveMediaBuffer(
            inboundMedia.buffer,
            inboundMedia.mimetype,
          );
          mediaPath = saved.path;
          mediaType = inboundMedia.mimetype;
        }
      } catch (err) {
        logVerbose(`Inbound media download failed: ${String(err)}`);
      }
      const chatJid = remoteJid;
      const sendComposing = async () => {
        try {
          await sock.sendPresenceUpdate("composing", chatJid);
        } catch (err) {
          logVerbose(`Presence update failed: ${String(err)}`);
        }
      };
      const reply = async (text: string) => {
        await sock.sendMessage(chatJid, { text });
      };
      const sendMedia = async (payload: AnyMessageContent) => {
        await sock.sendMessage(chatJid, payload);
      };
      const timestamp = msg.messageTimestamp
        ? Number(msg.messageTimestamp) * 1000
        : undefined;
      inboundLogger.info(
        {
          from,
          to: selfE164 ?? "me",
          body,
          mediaPath,
          mediaType,
          timestamp,
        },
        "inbound message",
      );
      try {
        await options.onMessage({
          id,
          from,
          to: selfE164 ?? "me",
          body,
          pushName: msg.pushName ?? undefined,
          timestamp,
          sendComposing,
          reply,
          sendMedia,
          mediaPath,
          mediaType,
        });
      } catch (err) {
        console.error("Failed handling inbound web message:", String(err));
      }
    }
  });

  sock.ev.on(
    "connection.update",
    (update: Partial<import("@whiskeysockets/baileys").ConnectionState>) => {
      try {
        if (update.connection === "close") {
          const status = getStatusCode(update.lastDisconnect?.error);
          onCloseResolve?.({
            status,
            isLoggedOut: status === DisconnectReason.loggedOut,
            error: update.lastDisconnect?.error,
          });
        }
      } catch (err) {
        inboundLogger.error(
          { error: String(err) },
          "connection.update handler error",
        );
        onCloseResolve?.({
          status: undefined,
          isLoggedOut: false,
          error: err,
        });
      }
    },
  );

  return {
    close: async () => {
      try {
        sock.ws?.close();
      } catch (err) {
        logVerbose(`Socket close failed: ${String(err)}`);
      }
    },
    onClose,
    /**
     * Send a message through this connection's socket.
     * Used by IPC to avoid creating new connections.
     */
    sendMessage: async (
      to: string,
      text: string,
      mediaBuffer?: Buffer,
      mediaType?: string,
    ): Promise<{ messageId: string }> => {
      const jid = `${to.replace(/^\+/, "")}@s.whatsapp.net`;
      let payload: AnyMessageContent;
      if (mediaBuffer && mediaType) {
        if (mediaType.startsWith("image/")) {
          payload = {
            image: mediaBuffer,
            caption: text || undefined,
            mimetype: mediaType,
          };
        } else if (mediaType.startsWith("audio/")) {
          payload = {
            audio: mediaBuffer,
            ptt: true,
            mimetype: mediaType,
          };
        } else if (mediaType.startsWith("video/")) {
          payload = {
            video: mediaBuffer,
            caption: text || undefined,
            mimetype: mediaType,
          };
        } else {
          payload = {
            document: mediaBuffer,
            fileName: "file",
            caption: text || undefined,
            mimetype: mediaType,
          };
        }
      } else {
        payload = { text };
      }
      const result = await sock.sendMessage(jid, payload);
      return { messageId: result?.key?.id ?? "unknown" };
    },
    /**
     * Send typing indicator ("composing") to a chat.
     * Used after IPC send to show more messages are coming.
     */
    sendComposingTo: async (to: string): Promise<void> => {
      const jid = `${to.replace(/^\+/, "")}@s.whatsapp.net`;
      await sock.sendPresenceUpdate("composing", jid);
    },
  } as const;
}

export function extractText(
  message: proto.IMessage | undefined,
): string | undefined {
  if (!message) return undefined;
  if (typeof message.conversation === "string" && message.conversation.trim()) {
    return message.conversation.trim();
  }
  const extended = message.extendedTextMessage?.text;
  if (extended?.trim()) return extended.trim();
  const caption =
    message.imageMessage?.caption ?? message.videoMessage?.caption;
  if (caption?.trim()) return caption.trim();
  return undefined;
}

export function extractMediaPlaceholder(
  message: proto.IMessage | undefined,
): string | undefined {
  if (!message) return undefined;
  if (message.imageMessage) return "<media:image>";
  if (message.videoMessage) return "<media:video>";
  if (message.audioMessage) return "<media:audio>";
  if (message.documentMessage) return "<media:document>";
  if (message.stickerMessage) return "<media:sticker>";
  return undefined;
}

async function downloadInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
): Promise<{ buffer: Buffer; mimetype?: string } | undefined> {
  const message = msg.message;
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
