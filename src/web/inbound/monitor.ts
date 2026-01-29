import type { AnyMessageContent, proto, WAMessage } from "@whiskeysockets/baileys";
import { DisconnectReason, isJidGroup } from "@whiskeysockets/baileys";
import { formatLocationText } from "../../channels/location.js";
import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import { getChildLogger } from "../../logging/logger.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { saveMediaBuffer } from "../../media/store.js";
import { createInboundDebouncer } from "../../auto-reply/inbound-debounce.js";
import { jidToE164, resolveJidToE164 } from "../../utils.js";
import { createWaSocket, getStatusCode, waitForWaConnection } from "../session.js";
import { checkInboundAccessControl } from "./access-control.js";
import { isRecentInboundMessage } from "./dedupe.js";
import {
  describeReplyContext,
  extractForwardingInfo,
  extractLocationData,
  extractMediaPlaceholder,
  extractMentionedJids,
  extractText,
} from "./extract.js";
import { downloadInboundMedia } from "./media.js";
import { createWebSendApi } from "./send-api.js";
import type { WebInboundMessage, WebListenerCloseReason } from "./types.js";

export async function monitorWebInbox(options: {
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  mediaMaxMb?: number;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: WebInboundMessage) => boolean;
}) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir,
  });
  await waitForWaConnection(sock);
  const connectedAtMs = Date.now();

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
    await sock.sendPresenceUpdate("available");
    if (shouldLogVerbose()) logVerbose("Sent global 'available' presence on connect");
  } catch (err) {
    logVerbose(`Failed to send 'available' presence on connect: ${String(err)}`);
  }

  const selfJid = sock.user?.id;
  const selfE164 = selfJid ? jidToE164(selfJid) : null;
  const debouncer = createInboundDebouncer<WebInboundMessage>({
    debounceMs: options.debounceMs ?? 0,
    buildKey: (msg) => {
      const senderKey =
        msg.chatType === "group"
          ? (msg.senderJid ?? msg.senderE164 ?? msg.senderName ?? msg.from)
          : msg.from;
      if (!senderKey) return null;
      const conversationKey = msg.chatType === "group" ? msg.chatId : msg.from;
      return `${msg.accountId}:${conversationKey}:${senderKey}`;
    },
    shouldDebounce: options.shouldDebounce,
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) return;
      if (entries.length === 1) {
        await options.onMessage(last);
        return;
      }
      const mentioned = new Set<string>();
      for (const entry of entries) {
        for (const jid of entry.mentionedJids ?? []) mentioned.add(jid);
      }
      const combinedBody = entries
        .map((entry) => entry.body)
        .filter(Boolean)
        .join("\n");
      const combinedMessage: WebInboundMessage = {
        ...last,
        body: combinedBody,
        mentionedJids: mentioned.size > 0 ? Array.from(mentioned) : undefined,
      };
      await options.onMessage(combinedMessage);
    },
    onError: (err) => {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    },
  });
  const groupMetaCache = new Map<
    string,
    { subject?: string; participants?: string[]; expires: number }
  >();
  const GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const lidLookup = sock.signalRepository?.lidMapping;

  const resolveInboundJid = async (jid: string | null | undefined): Promise<string | null> =>
    resolveJidToE164(jid, { authDir: options.authDir, lidLookup });

  const getGroupMeta = async (jid: string) => {
    const cached = groupMetaCache.get(jid);
    if (cached && cached.expires > Date.now()) return cached;
    try {
      const meta = await sock.groupMetadata(jid);
      const participants =
        (
          await Promise.all(
            meta.participants?.map(async (p) => {
              const mapped = await resolveInboundJid(p.id);
              return mapped ?? p.id;
            }) ?? [],
          )
        ).filter(Boolean) ?? [];
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

  const handleMessagesUpsert = async (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    if (upsert.type !== "notify" && upsert.type !== "append") return;
    for (const msg of upsert.messages ?? []) {
      recordChannelActivity({
        channel: "whatsapp",
        accountId: options.accountId,
        direction: "inbound",
      });
      const id = msg.key?.id ?? undefined;
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid) continue;
      if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) continue;

      const group = isJidGroup(remoteJid) === true;
      if (id) {
        const dedupeKey = `${options.accountId}:${remoteJid}:${id}`;
        if (isRecentInboundMessage(dedupeKey)) continue;
      }
      const participantJid = msg.key?.participant ?? undefined;
      const from = group ? remoteJid : await resolveInboundJid(remoteJid);
      if (!from) continue;
      const senderE164 = group
        ? participantJid
          ? await resolveInboundJid(participantJid)
          : null
        : from;

      let groupSubject: string | undefined;
      let groupParticipants: string[] | undefined;
      if (group) {
        const meta = await getGroupMeta(remoteJid);
        groupSubject = meta.subject;
        groupParticipants = meta.participants;
      }
      const messageTimestampMs = msg.messageTimestamp
        ? Number(msg.messageTimestamp) * 1000
        : undefined;

      const access = await checkInboundAccessControl({
        accountId: options.accountId,
        from,
        selfE164,
        senderE164,
        group,
        pushName: msg.pushName ?? undefined,
        isFromMe: Boolean(msg.key?.fromMe),
        messageTimestampMs,
        connectedAtMs,
        sock: { sendMessage: (jid, content) => sock.sendMessage(jid, content) },
        remoteJid,
      });
      if (!access.allowed) continue;

      if (id && !access.isSelfChat && options.sendReadReceipts !== false) {
        const participant = msg.key?.participant;
        try {
          await sock.readMessages([{ remoteJid, id, participant, fromMe: false }]);
          if (shouldLogVerbose()) {
            const suffix = participant ? ` (participant ${participant})` : "";
            logVerbose(`Marked message ${id} as read for ${remoteJid}${suffix}`);
          }
        } catch (err) {
          logVerbose(`Failed to mark message ${id} read: ${String(err)}`);
        }
      } else if (id && access.isSelfChat && shouldLogVerbose()) {
        // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
        logVerbose(`Self-chat mode: skipping read receipt for ${id}`);
      }

      // If this is history/offline catch-up, mark read above but skip auto-reply.
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
      const replyContext = describeReplyContext(msg.message as proto.IMessage | undefined);
      const forwardingInfo = extractForwardingInfo(msg.message as proto.IMessage | undefined);

      // Add forwarding tag to body if message is forwarded
      if (forwardingInfo.isForwarded) {
        const forwardTag =
          forwardingInfo.forwardingScore && forwardingInfo.forwardingScore >= 5
            ? "[forwarded many times]"
            : "[forwarded]";
        body = `${forwardTag} ${body}`;
      }

      let mediaPath: string | undefined;
      let mediaType: string | undefined;
      try {
        const inboundMedia = await downloadInboundMedia(msg as proto.IWebMessageInfo, sock);
        if (inboundMedia) {
          const maxMb =
            typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0
              ? options.mediaMaxMb
              : 50;
          const maxBytes = maxMb * 1024 * 1024;
          const saved = await saveMediaBuffer(
            inboundMedia.buffer,
            inboundMedia.mimetype,
            "inbound",
            maxBytes,
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
      const timestamp = messageTimestampMs;
      const mentionedJids = extractMentionedJids(msg.message as proto.IMessage | undefined);
      const senderName = msg.pushName ?? undefined;

      inboundLogger.info(
        { from, to: selfE164 ?? "me", body, mediaPath, mediaType, timestamp },
        "inbound message",
      );
      const inboundMessage: WebInboundMessage = {
        id,
        from,
        conversationId: from,
        to: selfE164 ?? "me",
        accountId: access.resolvedAccountId,
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
        replyToSenderJid: replyContext?.senderJid,
        replyToSenderE164: replyContext?.senderE164,
        groupSubject,
        groupParticipants,
        mentionedJids: mentionedJids ?? undefined,
        isForwarded: forwardingInfo.isForwarded,
        forwardingScore: forwardingInfo.forwardingScore,
        selfJid,
        selfE164,
        location: location ?? undefined,
        sendComposing,
        reply,
        sendMedia,
        mediaPath,
        mediaType,
      };
      try {
        const task = Promise.resolve(debouncer.enqueue(inboundMessage));
        void task.catch((err) => {
          inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
          inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
        });
      } catch (err) {
        inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
        inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
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
      inboundLogger.error({ error: String(err) }, "connection.update handler error");
      resolveClose({ status: undefined, isLoggedOut: false, error: err });
    }
  };
  sock.ev.on("connection.update", handleConnectionUpdate);

  const sendApi = createWebSendApi({
    sock: {
      sendMessage: (jid: string, content: AnyMessageContent) => sock.sendMessage(jid, content),
      sendPresenceUpdate: (presence, jid?: string) => sock.sendPresenceUpdate(presence, jid),
    },
    defaultAccountId: options.accountId,
  });

  return {
    close: async () => {
      try {
        const ev = sock.ev as unknown as {
          off?: (event: string, listener: (...args: unknown[]) => void) => void;
          removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
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
      resolveClose(reason ?? { status: undefined, isLoggedOut: false, error: "closed" });
    },
    // IPC surface (sendMessage/sendPoll/sendReaction/sendComposingTo)
    ...sendApi,
  } as const;
}
