import type {
  AnyMessageContent,
  proto,
  WAMessage,
} from "@whiskeysockets/baileys";
import {
  DisconnectReason,
  downloadMediaMessage,
  extractMessageContent,
  getContentType,
  isJidGroup,
  normalizeMessageContent,
} from "@whiskeysockets/baileys";

import { loadConfig } from "../config/config.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { createSubsystemLogger, getChildLogger } from "../logging.js";
import { saveMediaBuffer } from "../media/store.js";
import {
  readProviderAllowFromStore,
  upsertProviderPairingRequest,
} from "../pairing/pairing-store.js";
import {
  formatLocationText,
  type NormalizedLocation,
} from "../providers/location.js";
import {
  isSelfChatMode,
  jidToE164,
  normalizeE164,
  toWhatsappJid,
} from "../utils.js";
import { resolveWhatsAppAccount } from "./accounts.js";
import type { ActiveWebSendOptions } from "./active-listener.js";
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
  from: string; // conversation id: E.164 for direct chats, group JID for groups
  conversationId: string; // alias for clarity (same as from)
  to: string;
  accountId: string;
  body: string;
  pushName?: string;
  timestamp?: number;
  chatType: "direct" | "group";
  chatId: string;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  groupSubject?: string;
  groupParticipants?: string[];
  mentionedJids?: string[];
  selfJid?: string | null;
  selfE164?: string | null;
  location?: NormalizedLocation;
  sendComposing: () => Promise<void>;
  reply: (text: string) => Promise<void>;
  sendMedia: (payload: AnyMessageContent) => Promise<void>;
  mediaPath?: string;
  mediaType?: string;
  mediaUrl?: string;
  wasMentioned?: boolean;
};

export async function monitorWebInbox(options: {
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
}) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger(
    "gateway/providers/whatsapp",
  ).child("inbound");
  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir,
  });
  await waitForWaConnection(sock);
  let onCloseResolve: ((reason: WebListenerCloseReason) => void) | null = null;
  const onClose = new Promise<WebListenerCloseReason>((resolve) => {
    onCloseResolve = resolve;
  });
  const resolveClose = (reason: WebListenerCloseReason) => {
    if (!onCloseResolve) return;
    const resolver = onCloseResolve;
    onCloseResolve = null;
    resolver(reason);
  };
  try {
    // Advertise that the gateway is online right after connecting.
    await sock.sendPresenceUpdate("available");
    if (shouldLogVerbose())
      logVerbose("Sent global 'available' presence on connect");
  } catch (err) {
    logVerbose(
      `Failed to send 'available' presence on connect: ${String(err)}`,
    );
  }
  const selfJid = sock.user?.id;
  const selfE164 = selfJid ? jidToE164(selfJid) : null;
  const seen = new Set<string>();
  const groupMetaCache = new Map<
    string,
    { subject?: string; participants?: string[]; expires: number }
  >();
  const GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes

  const getGroupMeta = async (jid: string) => {
    const cached = groupMetaCache.get(jid);
    if (cached && cached.expires > Date.now()) return cached;
    try {
      const meta = await sock.groupMetadata(jid);
      const participants =
        meta.participants
          ?.map((p) => jidToE164(p.id) ?? p.id)
          .filter(Boolean) ?? [];
      const entry = {
        subject: meta.subject,
        participants,
        expires: Date.now() + GROUP_META_TTL_MS,
      };
      groupMetaCache.set(jid, entry);
      return entry;
    } catch (err) {
      logVerbose(`Failed to fetch group metadata for ${jid}: ${String(err)}`);
      return { expires: Date.now() + GROUP_META_TTL_MS };
    }
  };

  const handleMessagesUpsert = async (upsert: {
    type?: string;
    messages?: Array<import("@whiskeysockets/baileys").WAMessage>;
  }) => {
    if (upsert.type !== "notify" && upsert.type !== "append") return;
    for (const msg of upsert.messages ?? []) {
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
      const group = isJidGroup(remoteJid);
      const participantJid = msg.key?.participant ?? undefined;
      const from = group ? remoteJid : jidToE164(remoteJid);
      // Skip if we still can't resolve an id to key conversation
      if (!from) continue;
      const senderE164 = group
        ? participantJid
          ? jidToE164(participantJid)
          : null
        : from;
      let groupSubject: string | undefined;
      let groupParticipants: string[] | undefined;
      if (group) {
        const meta = await getGroupMeta(remoteJid);
        groupSubject = meta.subject;
        groupParticipants = meta.participants;
      }

      // Filter unauthorized senders early to prevent wasted processing
      // and potential session corruption from Bad MAC errors
      const cfg = loadConfig();
      const account = resolveWhatsAppAccount({
        cfg,
        accountId: options.accountId,
      });
      const dmPolicy = cfg.whatsapp?.dmPolicy ?? "pairing";
      const configuredAllowFrom = account.allowFrom;
      const storeAllowFrom = await readProviderAllowFromStore("whatsapp").catch(
        () => [],
      );
      // Without user config, default to self-only DM access so the owner can talk to themselves
      const combinedAllowFrom = Array.from(
        new Set([...(configuredAllowFrom ?? []), ...storeAllowFrom]),
      );
      const defaultAllowFrom =
        combinedAllowFrom.length === 0 && selfE164 ? [selfE164] : undefined;
      const allowFrom =
        combinedAllowFrom.length > 0 ? combinedAllowFrom : defaultAllowFrom;
      const groupAllowFrom =
        account.groupAllowFrom ??
        (configuredAllowFrom && configuredAllowFrom.length > 0
          ? configuredAllowFrom
          : undefined);
      const isSamePhone = from === selfE164;
      const isSelfChat = isSelfChatMode(selfE164, configuredAllowFrom);
      const isFromMe = Boolean(msg.key?.fromMe);
      const selfChatMode = account.selfChatMode ?? false;
      const selfPhoneMode = selfChatMode || isSelfChat;

      // Pre-compute normalized allowlists for filtering
      const dmHasWildcard = allowFrom?.includes("*") ?? false;
      const normalizedAllowFrom =
        allowFrom && allowFrom.length > 0
          ? allowFrom.filter((entry) => entry !== "*").map(normalizeE164)
          : [];
      const groupHasWildcard = groupAllowFrom?.includes("*") ?? false;
      const normalizedGroupAllowFrom =
        groupAllowFrom && groupAllowFrom.length > 0
          ? groupAllowFrom.filter((entry) => entry !== "*").map(normalizeE164)
          : [];

      // Group policy filtering: controls how group messages are handled
      // - "open" (default): groups bypass allowFrom, only mention-gating applies
      // - "disabled": block all group messages entirely
      // - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
      const groupPolicy = account.groupPolicy ?? "open";
      if (group && groupPolicy === "disabled") {
        logVerbose(`Blocked group message (groupPolicy: disabled)`);
        continue;
      }
      if (group && groupPolicy === "allowlist") {
        // For allowlist mode, the sender (participant) must be in allowFrom
        // If we can't resolve the sender E164, block the message for safety
        if (!groupAllowFrom || groupAllowFrom.length === 0) {
          logVerbose(
            "Blocked group message (groupPolicy: allowlist, no groupAllowFrom)",
          );
          continue;
        }
        const senderAllowed =
          groupHasWildcard ||
          (senderE164 != null && normalizedGroupAllowFrom.includes(senderE164));
        if (!senderAllowed) {
          logVerbose(
            `Blocked group message from ${senderE164 ?? "unknown sender"} (groupPolicy: allowlist)`,
          );
          continue;
        }
      }

      // DM access control (secure defaults): "pairing" (default) / "allowlist" / "open" / "disabled"
      if (!group) {
        if (isFromMe && !isSamePhone && selfPhoneMode) {
          logVerbose(
            "Skipping outbound self-phone DM (fromMe); no pairing reply needed.",
          );
          continue;
        }
        if (dmPolicy === "disabled") {
          logVerbose("Blocked dm (dmPolicy: disabled)");
          continue;
        }
        if (dmPolicy !== "open" && !isSamePhone) {
          const candidate = from;
          const allowed =
            dmHasWildcard ||
            (normalizedAllowFrom.length > 0 &&
              normalizedAllowFrom.includes(candidate));
          if (!allowed) {
            if (dmPolicy === "pairing") {
              const { code, created } = await upsertProviderPairingRequest({
                provider: "whatsapp",
                id: candidate,
                meta: {
                  name: (msg.pushName ?? "").trim() || undefined,
                },
              });
              if (created) {
                logVerbose(
                  `whatsapp pairing request sender=${candidate} name=${msg.pushName ?? "unknown"}`,
                );
                try {
                  await sock.sendMessage(remoteJid, {
                    text: [
                      "Clawdbot: access not configured.",
                      "",
                      `Pairing code: ${code}`,
                      "",
                      "Ask the bot owner to approve with:",
                      "clawdbot pairing approve --provider whatsapp <code>",
                    ].join("\n"),
                  });
                } catch (err) {
                  logVerbose(
                    `whatsapp pairing reply failed for ${candidate}: ${String(err)}`,
                  );
                }
              }
            } else {
              logVerbose(
                `Blocked unauthorized sender ${candidate} (dmPolicy=${dmPolicy})`,
              );
            }
            continue;
          }
        }
      }

      if (id && !isSelfChat) {
        const participant = msg.key?.participant;
        try {
          await sock.readMessages([
            { remoteJid, id, participant, fromMe: false },
          ]);
          if (shouldLogVerbose()) {
            const suffix = participant ? ` (participant ${participant})` : "";
            logVerbose(
              `Marked message ${id} as read for ${remoteJid}${suffix}`,
            );
          }
        } catch (err) {
          logVerbose(`Failed to mark message ${id} read: ${String(err)}`);
        }
      } else if (id && isSelfChat && shouldLogVerbose()) {
        // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
        logVerbose(`Self-chat mode: skipping read receipt for ${id}`);
      }

      // If this is history/offline catch-up, we marked it as read above,
      // but we skip triggering the auto-reply logic to avoid spamming old context.
      if (upsert.type === "append") continue;

      const location = extractLocationData(msg.message ?? undefined);
      const locationText = location ? formatLocationText(location) : undefined;
      let body = extractText(msg.message ?? undefined);
      if (locationText) {
        body = [body, locationText].filter(Boolean).join("\n").trim();
      }
      if (!body) {
        body = extractMediaPlaceholder(msg.message ?? undefined);
        if (!body) continue;
      }
      const replyContext = describeReplyContext(
        msg.message as proto.IMessage | undefined,
      );
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
      const mentionedJids = extractMentionedJids(
        msg.message as proto.IMessage | undefined,
      );
      const senderName = msg.pushName ?? undefined;
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
        const task = Promise.resolve(
          options.onMessage({
            id,
            from,
            conversationId: from,
            to: selfE164 ?? "me",
            accountId: account.accountId,
            body,
            pushName: senderName,
            timestamp,
            chatType: group ? "group" : "direct",
            chatId: remoteJid,
            senderJid: participantJid,
            senderE164: senderE164 ?? undefined,
            senderName,
            replyToId: replyContext?.id,
            replyToBody: replyContext?.body,
            replyToSender: replyContext?.sender,
            groupSubject,
            groupParticipants,
            mentionedJids: mentionedJids ?? undefined,
            selfJid,
            selfE164,
            location: location ?? undefined,
            sendComposing,
            reply,
            sendMedia,
            mediaPath,
            mediaType,
          }),
        );
        void task.catch((err) => {
          inboundLogger.error(
            { error: String(err) },
            "failed handling inbound web message",
          );
          inboundConsoleLog.error(
            `Failed handling inbound web message: ${String(err)}`,
          );
        });
      } catch (err) {
        inboundLogger.error(
          { error: String(err) },
          "failed handling inbound web message",
        );
        inboundConsoleLog.error(
          `Failed handling inbound web message: ${String(err)}`,
        );
      }
    }
  };
  sock.ev.on("messages.upsert", handleMessagesUpsert);

  const handleConnectionUpdate = (
    update: Partial<import("@whiskeysockets/baileys").ConnectionState>,
  ) => {
    try {
      if (update.connection === "close") {
        const status = getStatusCode(update.lastDisconnect?.error);
        resolveClose({
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
      resolveClose({
        status: undefined,
        isLoggedOut: false,
        error: err,
      });
    }
  };
  sock.ev.on("connection.update", handleConnectionUpdate);

  return {
    close: async () => {
      try {
        const ev = sock.ev as unknown as {
          off?: (event: string, listener: (...args: unknown[]) => void) => void;
          removeListener?: (
            event: string,
            listener: (...args: unknown[]) => void,
          ) => void;
        };
        const messagesUpsertHandler = handleMessagesUpsert as unknown as (
          ...args: unknown[]
        ) => void;
        const connectionUpdateHandler = handleConnectionUpdate as unknown as (
          ...args: unknown[]
        ) => void;
        if (typeof ev.off === "function") {
          ev.off("messages.upsert", messagesUpsertHandler);
          ev.off("connection.update", connectionUpdateHandler);
        } else if (typeof ev.removeListener === "function") {
          ev.removeListener("messages.upsert", messagesUpsertHandler);
          ev.removeListener("connection.update", connectionUpdateHandler);
        }
        sock.ws?.close();
      } catch (err) {
        logVerbose(`Socket close failed: ${String(err)}`);
      }
    },
    onClose,
    signalClose: (reason?: WebListenerCloseReason) => {
      resolveClose(
        reason ?? { status: undefined, isLoggedOut: false, error: "closed" },
      );
    },
    /**
     * Send a message through this connection's socket.
     * Used by IPC to avoid creating new connections.
     */
    sendMessage: async (
      to: string,
      text: string,
      mediaBuffer?: Buffer,
      mediaType?: string,
      options?: ActiveWebSendOptions,
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
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
          const gifPlayback = options?.gifPlayback;
          payload = {
            video: mediaBuffer,
            caption: text || undefined,
            mimetype: mediaType,
            ...(gifPlayback ? { gifPlayback: true } : {}),
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
     * Send a poll message through this connection's socket.
     * Used by IPC to create WhatsApp polls in groups or chats.
     */
    sendPoll: async (
      to: string,
      poll: { question: string; options: string[]; maxSelections?: number },
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      const result = await sock.sendMessage(jid, {
        poll: {
          name: poll.question,
          values: poll.options,
          selectableCount: poll.maxSelections ?? 1,
        },
      });
      return { messageId: result?.key?.id ?? "unknown" };
    },
    /**
     * Send a reaction (emoji) to a specific message.
     * Pass an empty string for emoji to remove the reaction.
     */
    sendReaction: async (
      chatJid: string,
      messageId: string,
      emoji: string,
      fromMe: boolean,
      participant?: string,
    ): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: jid,
            id: messageId,
            fromMe,
            participant,
          },
        },
      });
    },
    /**
     * Send typing indicator ("composing") to a chat.
     * Used after IPC send to show more messages are coming.
     */
    sendComposingTo: async (to: string): Promise<void> => {
      const jid = toWhatsappJid(to);
      await sock.sendPresenceUpdate("composing", jid);
    },
  } as const;
}

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

function extractMentionedJids(
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
  // De-dupe
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

function describeReplyContext(rawMessage: proto.IMessage | undefined): {
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

async function downloadInboundMedia(
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
