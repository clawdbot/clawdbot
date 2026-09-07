// Whatsapp plugin module implements qa driver behavior.
import type { ConnectionState, proto, WAMessage } from "baileys";
import { formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import {
  asBoolean,
  isRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  describeReplyContext,
  extractContextInfo,
  extractLocationData,
  extractText,
  findMessageSection,
} from "./inbound/extract.js";
import { resolveInboundMediaMimetype } from "./inbound/media-mimetype.js";
import { createWebSendApi } from "./inbound/send-api.js";
import type { ActiveWebSendOptions } from "./inbound/types.js";
import { isWhatsAppGroupJid } from "./normalize-target.js";
import { createWaSocket, formatError, getStatusCode, waitForWaConnection } from "./session.js";
import {
  DEFAULT_WHATSAPP_SOCKET_TIMING,
  createWhatsAppSocketOperationTimeoutAdapter,
} from "./socket-timing.js";
import { jidToE164 } from "./text-runtime.js";

type WhatsAppQaDriverObservedMessageKind =
  | "media"
  | "location"
  | "poll"
  | "reaction"
  | "text"
  | "unknown";

type WhatsAppQaDriverQuotedMessage = {
  messageId?: string;
  participant?: string;
  text?: string;
};

type WhatsAppQaDriverObservedReaction = {
  emoji: string;
  fromMe?: boolean;
  messageId?: string;
  participant?: string;
};

type WhatsAppQaDriverObservedPoll = {
  options: string[];
  question?: string;
};

export type WhatsAppQaDriverObservedMessage = {
  fromJid?: string;
  fromPhoneE164?: string | null;
  hasMedia?: boolean;
  kind: WhatsAppQaDriverObservedMessageKind;
  mediaFileName?: string;
  mediaType?: string;
  messageId?: string;
  observedAt: string;
  participantJid?: string;
  poll?: WhatsAppQaDriverObservedPoll;
  quoted?: WhatsAppQaDriverQuotedMessage;
  reaction?: WhatsAppQaDriverObservedReaction;
  text: string;
};

type WhatsAppQaDriverSendTextOptions = Pick<ActiveWebSendOptions, "quotedMessageKey">;

type WhatsAppQaDriverSendMediaOptions = Pick<
  ActiveWebSendOptions,
  "asDocument" | "fileName" | "gifPlayback" | "quotedMessageKey"
>;

type WhatsAppQaDriverSendReactionOptions = {
  fromMe: boolean;
  participant?: string;
};

type WhatsAppQaDriverSendResult = Promise<{ messageId?: string }>;

export type WhatsAppQaDriverSession = {
  close(): Promise<void>;
  getObservedMessages(): WhatsAppQaDriverObservedMessage[];
  sendContact(
    to: string,
    contact: { displayName: string; vcard: string },
  ): WhatsAppQaDriverSendResult;
  sendLocation(
    to: string,
    location: {
      address?: string;
      degreesLatitude: number;
      degreesLongitude: number;
      name?: string;
    },
  ): WhatsAppQaDriverSendResult;
  sendMedia(
    to: string,
    text: string,
    mediaBuffer: Buffer,
    mediaType: string,
    options?: WhatsAppQaDriverSendMediaOptions,
  ): WhatsAppQaDriverSendResult;
  sendPoll(
    to: string,
    poll: { maxSelections?: number; options: string[]; question: string },
  ): WhatsAppQaDriverSendResult;
  sendReaction(
    chatJid: string,
    messageId: string,
    emoji: string,
    options: WhatsAppQaDriverSendReactionOptions,
  ): WhatsAppQaDriverSendResult;
  sendSticker(
    to: string,
    stickerBuffer: Buffer,
    options?: { mimetype?: string },
  ): WhatsAppQaDriverSendResult;
  sendText(
    to: string,
    text: string,
    options?: WhatsAppQaDriverSendTextOptions,
  ): WhatsAppQaDriverSendResult;
  waitForMessage(params: {
    match: (message: WhatsAppQaDriverObservedMessage) => boolean;
    observedAfter?: Date;
    timeoutMs: number;
  }): Promise<WhatsAppQaDriverObservedMessage>;
};

type MessageUpsertEvent = {
  messages?: WAMessage[];
};

type ConnectionUpdateEvent = Partial<ConnectionState>;

type Waiter = {
  predicate: (message: WhatsAppQaDriverObservedMessage) => boolean;
  reject: (error: Error) => void;
  resolve: (message: WhatsAppQaDriverObservedMessage) => void;
  timeout: NodeJS.Timeout;
};

type VoidWaiter = {
  reject: (error: Error) => void;
  resolve: () => void;
  timeout: NodeJS.Timeout;
};

function readReaction(
  message: proto.IMessage | null | undefined,
): WhatsAppQaDriverObservedReaction | undefined {
  const reaction = findMessageSection(message ?? undefined, ["reactionMessage"])?.value;
  if (!reaction) {
    return undefined;
  }
  const emoji = normalizeOptionalString(reaction.text) ?? "";
  const key = isRecord(reaction.key) ? reaction.key : undefined;
  return {
    emoji,
    fromMe: asBoolean(key?.fromMe),
    messageId: normalizeOptionalString(key?.id),
    participant: normalizeOptionalString(key?.participant),
  };
}

function readPoll(
  message: proto.IMessage | null | undefined,
): WhatsAppQaDriverObservedPoll | undefined {
  const poll = findMessageSection(message ?? undefined, [
    "pollCreationMessage",
    "pollCreationMessageV2",
    "pollCreationMessageV3",
    "pollCreationMessageV5",
  ])?.value;
  if (!poll) {
    return undefined;
  }
  const rawOptions = Array.isArray(poll.options) ? poll.options : [];
  const options = rawOptions
    .map((option) => (isRecord(option) ? normalizeOptionalString(option.optionName) : undefined))
    .filter((option): option is string => Boolean(option));
  return {
    options,
    question: normalizeOptionalString(poll.name),
  };
}

function readMedia(message: proto.IMessage | null | undefined):
  | {
      fileName?: string;
      mediaType?: string;
    }
  | undefined {
  const media = findMessageSection(message ?? undefined, [
    "imageMessage",
    "videoMessage",
    "ptvMessage",
    "audioMessage",
    "documentMessage",
    "stickerMessage",
  ]);
  return media
    ? {
        fileName: normalizeOptionalString(media.value.fileName),
        mediaType: resolveInboundMediaMimetype({ [media.name]: media.value } as proto.IMessage),
      }
    : undefined;
}

function readQuotedMessage(message: WAMessage): WhatsAppQaDriverQuotedMessage | undefined {
  const contextInfo = extractContextInfo(message.message ?? undefined);
  const replyContext = describeReplyContext(message.message ?? undefined);
  if (!contextInfo && !replyContext) {
    return undefined;
  }
  if (!contextInfo?.stanzaId && !contextInfo?.participant && !replyContext?.body) {
    return undefined;
  }
  return {
    messageId: replyContext?.id ?? contextInfo?.stanzaId ?? undefined,
    participant: replyContext?.sender?.jid ?? contextInfo?.participant ?? undefined,
    text: replyContext?.body,
  };
}

function normalizeObservedMessage(
  message: WAMessage,
  authDir: string,
): WhatsAppQaDriverObservedMessage | null {
  if (message.key.fromMe) {
    return null;
  }
  const extractedText = extractText(message.message ?? undefined);
  const location = extractLocationData(message.message ?? undefined);
  const locationText = location ? formatLocationText(location) : undefined;
  const text = [extractedText, locationText].filter(Boolean).join("\n").trim() || undefined;
  const reaction = readReaction(message.message);
  const poll = readPoll(message.message);
  const media = readMedia(message.message);
  const quoted = readQuotedMessage(message);
  const kind: WhatsAppQaDriverObservedMessageKind = reaction
    ? "reaction"
    : poll
      ? "poll"
      : media
        ? "media"
        : location
          ? "location"
          : text
            ? "text"
            : "unknown";
  if (!text && kind === "unknown") {
    return null;
  }
  const fromJid = message.key.remoteJid ?? undefined;
  const senderJid =
    fromJid && isWhatsAppGroupJid(fromJid) ? (message.key.participant ?? fromJid) : fromJid;
  const participantJid = message.key.participant ?? undefined;
  return {
    fromJid,
    fromPhoneE164: senderJid ? jidToE164(senderJid, { authDir }) : null,
    hasMedia: media ? true : undefined,
    kind,
    mediaFileName: media?.fileName,
    mediaType: media?.mediaType,
    messageId: message.key.id ?? undefined,
    observedAt: new Date().toISOString(),
    ...(participantJid ? { participantJid } : {}),
    poll,
    quoted,
    reaction,
    text: text ?? "",
  };
}

function createConnectionClosedError(update: ConnectionUpdateEvent) {
  const reason = update.lastDisconnect?.error;
  const status = getStatusCode(reason);
  const details = reason ? `: ${formatError(reason)}` : "";
  const statusLabel = typeof status === "number" ? ` (status ${status})` : "";
  return new Error(`WhatsApp QA driver connection closed${statusLabel}${details}`);
}

export async function startWhatsAppQaDriverSession(params: {
  authDir: string;
  connectionTimeoutMs?: number;
  waitForPendingNotifications?: boolean;
}): Promise<WhatsAppQaDriverSession> {
  const sock = await createWaSocket(false, false, { authDir: params.authDir });
  const observedMessages: WhatsAppQaDriverObservedMessage[] = [];
  const waiters = new Set<Waiter>();
  let pendingNotificationsWaiter: VoidWaiter | undefined;
  let closed = false;
  let closedError: Error | undefined;
  let receivedPendingNotifications = false;

  const removeWaiter = (waiter: Waiter) => {
    waiters.delete(waiter);
    clearTimeout(waiter.timeout);
  };

  const settlePendingNotifications = (error?: Error) => {
    const waiter = pendingNotificationsWaiter;
    if (!waiter) {
      return;
    }
    pendingNotificationsWaiter = undefined;
    clearTimeout(waiter.timeout);
    if (error) {
      waiter.reject(error);
    } else {
      waiter.resolve();
    }
  };

  const observe = (message: WhatsAppQaDriverObservedMessage) => {
    observedMessages.push(message);
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) {
        continue;
      }
      removeWaiter(waiter);
      waiter.resolve(message);
    }
  };

  const onMessagesUpsert = (event: MessageUpsertEvent) => {
    for (const rawMessage of event.messages ?? []) {
      const observed = normalizeObservedMessage(rawMessage, params.authDir);
      if (observed) {
        observe(observed);
      }
    }
  };

  const onConnectionUpdate = (event: ConnectionUpdateEvent) => {
    if (event.receivedPendingNotifications === true) {
      receivedPendingNotifications = true;
      settlePendingNotifications();
    }
    if (event.connection === "close") {
      closeSessionResources(createConnectionClosedError(event));
    }
  };

  const removeMessageListener = () => {
    sock.ev.off("messages.upsert", onMessagesUpsert);
    sock.ev.off("connection.update", onConnectionUpdate);
  };

  const closeSessionResources = (waiterError?: Error) => {
    if (closed) {
      return;
    }
    closed = true;
    closedError = waiterError;
    settlePendingNotifications(waiterError);
    for (const waiter of waiters) {
      removeWaiter(waiter);
      if (waiterError) {
        waiter.reject(waiterError);
      }
    }
    removeMessageListener();
    void sock.end(undefined);
  };

  sock.ev.on("messages.upsert", onMessagesUpsert);
  sock.ev.on("connection.update", onConnectionUpdate);
  try {
    await waitForWaConnection(sock, { timeoutMs: params.connectionTimeoutMs ?? 45_000 });
    if (params.waitForPendingNotifications) {
      await new Promise<void>((resolve, reject) => {
        if (receivedPendingNotifications) {
          resolve();
          return;
        }
        if (closed) {
          reject(closedError ?? new Error("WhatsApp QA driver session closed"));
          return;
        }
        const timeoutMs = params.connectionTimeoutMs ?? 45_000;
        const waiter: VoidWaiter = {
          resolve,
          reject,
          timeout: setTimeout(() => {
            pendingNotificationsWaiter = undefined;
            reject(
              new Error(
                `timed out after ${timeoutMs}ms waiting for WhatsApp QA driver pending notifications`,
              ),
            );
          }, timeoutMs),
        };
        pendingNotificationsWaiter = waiter;
      });
    }
  } catch (error) {
    closeSessionResources(
      error instanceof Error ? error : new Error("failed starting WhatsApp QA driver session"),
    );
    throw error;
  }

  const sendApi = createWebSendApi({
    sock: createWhatsAppSocketOperationTimeoutAdapter(
      sock,
      DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
    ),
    defaultAccountId: "qa-driver",
    authDir: params.authDir,
  });

  return {
    async close() {
      closeSessionResources(new Error("WhatsApp QA driver session closed"));
    },
    getObservedMessages() {
      return [...observedMessages];
    },
    sendContact(to, contact) {
      return toMessageIdResult(sendApi.sendContact(to, contact));
    },
    sendLocation(to, location) {
      return toMessageIdResult(sendApi.sendLocation(to, location));
    },
    sendMedia(to, text, mediaBuffer, mediaType, options) {
      return toMessageIdResult(sendApi.sendMessage(to, text, mediaBuffer, mediaType, options));
    },
    sendPoll(to, poll) {
      return toMessageIdResult(sendApi.sendPoll(to, poll));
    },
    sendReaction(chatJid, messageId, emoji, options) {
      return toMessageIdResult(
        sendApi.sendReaction(chatJid, messageId, emoji, options.fromMe, options.participant),
      );
    },
    sendSticker(to, stickerBuffer, options) {
      return toMessageIdResult(sendApi.sendSticker(to, stickerBuffer, options));
    },
    sendText(to, text, options) {
      return toMessageIdResult(sendApi.sendMessage(to, text, undefined, undefined, options));
    },
    async waitForMessage(paramsLocal) {
      const predicate = (message: WhatsAppQaDriverObservedMessage) =>
        (!paramsLocal.observedAfter ||
          new Date(message.observedAt).getTime() >= paramsLocal.observedAfter.getTime()) &&
        paramsLocal.match(message);
      const existing = observedMessages.find(predicate);
      if (existing) {
        return existing;
      }
      if (closed) {
        throw closedError ?? new Error("WhatsApp QA driver session closed");
      }
      return await new Promise<WhatsAppQaDriverObservedMessage>((resolve, reject) => {
        const waiter: Waiter = {
          predicate,
          resolve,
          reject,
          timeout: setTimeout(() => {
            removeWaiter(waiter);
            reject(new Error("timed out waiting for WhatsApp QA driver message"));
          }, paramsLocal.timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}

async function toMessageIdResult(
  pending: Promise<{ messageId?: string }>,
): Promise<{ messageId?: string }> {
  const { messageId } = await pending;
  return { messageId };
}
