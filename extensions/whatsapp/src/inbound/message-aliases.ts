import { buildDeprecatedFlatWhatsAppInboundAdmission } from "./admission.js";
import { resolveWhatsAppGroupConversationId } from "./group-conversation.js";
import type {
  DeprecatedWebInboundAdmissionTopLevelFields,
  DeprecatedWebInboundMessageFlatAliases,
  LegacyFlatWebInboundMessage,
  WebInboundCallbackMessage,
  WebInboundMessage,
  WebInboundMessageInput,
  WhatsAppInboundGroupContext,
  WhatsAppInboundQuote,
} from "./types.js";

type QuoteSender = NonNullable<WhatsAppInboundQuote["sender"]>;
type AliasDescriptor = {
  get: () => unknown;
  set: (value: unknown) => void;
};

function normalizeQuoteSender(sender: QuoteSender | undefined): QuoteSender | undefined {
  if (!sender?.displayName && !sender?.jid && !sender?.e164) {
    return undefined;
  }
  return sender;
}

function buildQuoteFromFlatAliases(
  msg: LegacyFlatWebInboundMessage,
): WhatsAppInboundQuote | undefined {
  if (msg.replyTo) {
    return {
      context: msg.replyTo,
      id: msg.replyTo.id,
      body: msg.replyTo.body,
      sender: normalizeQuoteSender({
        displayName: msg.replyTo.sender?.label ?? msg.replyToSender,
        jid: msg.replyTo.sender?.jid ?? msg.replyToSenderJid,
        e164: msg.replyTo.sender?.e164 ?? msg.replyToSenderE164,
      }),
    };
  }
  if (
    !msg.replyToId &&
    !msg.replyToBody &&
    !msg.replyToSender &&
    !msg.replyToSenderJid &&
    !msg.replyToSenderE164
  ) {
    return undefined;
  }
  return {
    id: msg.replyToId,
    body: msg.replyToBody,
    sender: normalizeQuoteSender({
      displayName: msg.replyToSender,
      jid: msg.replyToSenderJid,
      e164: msg.replyToSenderE164,
    }),
  };
}

function buildGroupFromFlatAliases(
  msg: LegacyFlatWebInboundMessage,
): WhatsAppInboundGroupContext | undefined {
  const mentionJids = msg.mentions ?? msg.mentionedJids;
  if (!msg.groupSubject && !msg.groupParticipants?.length && !mentionJids?.length) {
    return undefined;
  }
  return {
    subject: msg.groupSubject,
    participants: msg.groupParticipants,
    mentions: mentionJids?.length ? { jids: mentionJids } : undefined,
  };
}

function ensureQuote(msg: WebInboundCallbackMessage): WhatsAppInboundQuote {
  return (msg.quote ??= {});
}

function ensureQuoteSender(msg: WebInboundCallbackMessage): QuoteSender {
  const quote = ensureQuote(msg);
  return (quote.sender ??= {});
}

function ensureGroup(msg: WebInboundCallbackMessage): WhatsAppInboundGroupContext {
  return (msg.group ??= {});
}

function ensureGroupMentions(msg: WebInboundCallbackMessage): { jids?: string[]; text?: string[] } {
  const group = ensureGroup(msg);
  return (group.mentions ??= {});
}

function ensureMedia(
  msg: WebInboundCallbackMessage,
): NonNullable<WebInboundCallbackMessage["payload"]["media"]> {
  return (msg.payload.media ??= {});
}

function setMediaField<K extends keyof NonNullable<WebInboundCallbackMessage["payload"]["media"]>>(
  msg: WebInboundCallbackMessage,
  key: K,
  value: NonNullable<WebInboundCallbackMessage["payload"]["media"]>[K] | undefined,
) {
  if (value === undefined && !msg.payload.media) {
    return;
  }
  ensureMedia(msg)[key] = value;
}

function defineDeprecatedAccessors<T extends object>(
  msg: T,
  descriptors: Record<string, AliasDescriptor>,
): T {
  Object.defineProperties(
    msg,
    Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [
        key,
        {
          configurable: true,
          enumerable: true,
          get: descriptor.get,
          set: descriptor.set,
        },
      ]),
    ),
  );
  return msg;
}

function defineDeprecatedAliasAccessors<T extends WebInboundCallbackMessage>(
  msg: T,
  descriptors: Record<keyof DeprecatedWebInboundMessageFlatAliases, AliasDescriptor>,
): T & WebInboundMessage {
  defineDeprecatedAccessors(msg, descriptors);
  return msg as T & WebInboundMessage;
}

function defineDeprecatedStructuredContextPayloadAlias(msg: WebInboundCallbackMessage): void {
  const channelStructuredContext =
    msg.payload.channelStructuredContext ?? msg.payload.untrustedStructuredContext;
  if (channelStructuredContext !== undefined) {
    msg.payload.channelStructuredContext = channelStructuredContext;
  }
  Object.defineProperty(msg.payload, "untrustedStructuredContext", {
    configurable: true,
    enumerable: true,
    get: () => msg.payload.channelStructuredContext,
    set: (value) => {
      msg.payload.channelStructuredContext = value;
    },
  });
}

function defineDeprecatedAdmissionTopLevelAccessors<T extends WebInboundCallbackMessage>(
  msg: T,
): T {
  let fallbackConversationId = msg.conversationId || msg.from;
  let fallbackAccountId = msg.accountId;
  let fallbackAccessControlPassed = msg.accessControlPassed;
  let fallbackChatType = msg.chatType;

  const conversationId = () => msg.admission?.conversation.id ?? fallbackConversationId;
  const setConversationId = (value: unknown) => {
    const next = value as string;
    fallbackConversationId = next;
    if (msg.admission) {
      msg.admission.conversation.id = next;
      msg.admission.conversation.groupSessionId = resolveWhatsAppGroupConversationId(next);
    }
  };

  const descriptors: Record<keyof DeprecatedWebInboundAdmissionTopLevelFields, AliasDescriptor> = {
    from: {
      get: conversationId,
      set: setConversationId,
    },
    conversationId: {
      get: conversationId,
      set: setConversationId,
    },
    accountId: {
      get: () => msg.admission?.accountId ?? fallbackAccountId,
      set: (value) => {
        const next = value as string;
        fallbackAccountId = next;
        if (msg.admission) {
          msg.admission.accountId = next;
          msg.admission.account.accountId = next;
        }
      },
    },
    accessControlPassed: {
      get: () =>
        msg.admission ? msg.admission.ingress.decision === "allow" : fallbackAccessControlPassed,
      set: (value) => {
        // The legacy boolean is derived from the ingress graph; writes only preserve
        // no-admission legacy inputs instead of fabricating a partial graph update.
        fallbackAccessControlPassed = value as boolean | undefined;
      },
    },
    chatType: {
      get: () => msg.admission?.conversation.kind ?? fallbackChatType,
      set: (value) => {
        const next = value as "direct" | "group";
        fallbackChatType = next;
        if (msg.admission) {
          msg.admission.conversation.kind = next;
        }
      },
    },
  };

  return defineDeprecatedAccessors(msg, descriptors);
}

export function withDeprecatedWebInboundMessageFlatAliases<T extends WebInboundCallbackMessage>(
  msg: T,
): T & WebInboundMessage {
  // Keep the shipped callback shape alive while nested/admission contexts remain canonical.
  defineDeprecatedStructuredContextPayloadAlias(msg);
  const withAdmissionAliases = defineDeprecatedAdmissionTopLevelAccessors(msg);
  return defineDeprecatedAliasAccessors(withAdmissionAliases, {
    id: { get: () => msg.event.id, set: (value) => (msg.event.id = value as string | undefined) },
    to: {
      get: () => msg.platform.recipientJid,
      set: (value) => (msg.platform.recipientJid = value as string),
    },
    body: { get: () => msg.payload.body, set: (value) => (msg.payload.body = value as string) },
    pushName: {
      get: () => msg.platform.pushName,
      set: (value) => (msg.platform.pushName = value as string | undefined),
    },
    timestamp: {
      get: () => msg.event.timestamp,
      set: (value) => (msg.event.timestamp = value as number | undefined),
    },
    chatId: {
      get: () => msg.platform.chatJid,
      set: (value) => (msg.platform.chatJid = value as string),
    },
    sender: {
      get: () => msg.platform.sender,
      set: (value) => (msg.platform.sender = value as typeof msg.platform.sender),
    },
    senderJid: {
      get: () => msg.platform.senderJid,
      set: (value) => (msg.platform.senderJid = value as string | undefined),
    },
    senderE164: {
      get: () => msg.platform.senderE164,
      set: (value) => (msg.platform.senderE164 = value as string | undefined),
    },
    senderName: {
      get: () => msg.platform.senderName,
      set: (value) => (msg.platform.senderName = value as string | undefined),
    },
    replyTo: {
      get: () => msg.quote?.context,
      set: (value) => (ensureQuote(msg).context = value as WhatsAppInboundQuote["context"]),
    },
    replyToId: {
      get: () => msg.quote?.id ?? msg.quote?.context?.id,
      set: (value) => (ensureQuote(msg).id = value as string | undefined),
    },
    replyToBody: {
      get: () => msg.quote?.body ?? msg.quote?.context?.body,
      set: (value) => (ensureQuote(msg).body = value as string | undefined),
    },
    replyToSender: {
      get: () => msg.quote?.context?.sender?.label ?? msg.quote?.sender?.displayName,
      set: (value) => {
        const sender = ensureQuoteSender(msg);
        sender.displayName = value as string | undefined;
        if (msg.quote?.context?.sender) {
          msg.quote.context.sender.label = value as string | undefined;
        }
      },
    },
    replyToSenderJid: {
      get: () => msg.quote?.context?.sender?.jid ?? msg.quote?.sender?.jid,
      set: (value) => {
        const jid = value as string | undefined;
        ensureQuoteSender(msg).jid = jid;
        if (msg.quote?.context?.sender) {
          msg.quote.context.sender.jid = jid;
        }
      },
    },
    replyToSenderE164: {
      get: () => msg.quote?.context?.sender?.e164 ?? msg.quote?.sender?.e164,
      set: (value) => {
        const e164 = value as string | undefined;
        ensureQuoteSender(msg).e164 = e164;
        if (msg.quote?.context?.sender) {
          msg.quote.context.sender.e164 = e164;
        }
      },
    },
    groupSubject: {
      get: () => msg.group?.subject,
      set: (value) => (ensureGroup(msg).subject = value as string | undefined),
    },
    groupParticipants: {
      get: () => msg.group?.participants,
      set: (value) => (ensureGroup(msg).participants = value as string[] | undefined),
    },
    mentions: {
      get: () => msg.group?.mentions?.jids,
      set: (value) => (ensureGroupMentions(msg).jids = value as string[] | undefined),
    },
    mentionedJids: {
      get: () => msg.group?.mentions?.jids,
      set: (value) => (ensureGroupMentions(msg).jids = value as string[] | undefined),
    },
    self: {
      get: () => msg.platform.self,
      set: (value) => (msg.platform.self = value as typeof msg.platform.self),
    },
    selfJid: {
      get: () => msg.platform.selfJid,
      set: (value) => (msg.platform.selfJid = value as string | null | undefined),
    },
    selfLid: {
      get: () => msg.platform.selfLid,
      set: (value) => (msg.platform.selfLid = value as string | null | undefined),
    },
    selfE164: {
      get: () => msg.platform.selfE164,
      set: (value) => (msg.platform.selfE164 = value as string | null | undefined),
    },
    fromMe: {
      get: () => msg.platform.fromMe,
      set: (value) => (msg.platform.fromMe = value as boolean | undefined),
    },
    location: {
      get: () => msg.payload.location,
      set: (value) => (msg.payload.location = value as typeof msg.payload.location),
    },
    sendComposing: {
      get: () => msg.platform.sendComposing,
      set: (value) => (msg.platform.sendComposing = value as typeof msg.platform.sendComposing),
    },
    reply: {
      get: () => msg.platform.reply,
      set: (value) => (msg.platform.reply = value as typeof msg.platform.reply),
    },
    sendMedia: {
      get: () => msg.platform.sendMedia,
      set: (value) => (msg.platform.sendMedia = value as typeof msg.platform.sendMedia),
    },
    mediaPath: {
      get: () => msg.payload.media?.path,
      set: (value) => setMediaField(msg, "path", value as string | undefined),
    },
    mediaType: {
      get: () => msg.payload.media?.type,
      set: (value) => setMediaField(msg, "type", value as string | undefined),
    },
    mediaFileName: {
      get: () => msg.payload.media?.fileName,
      set: (value) => setMediaField(msg, "fileName", value as string | undefined),
    },
    mediaUrl: {
      get: () => msg.payload.media?.url,
      set: (value) => setMediaField(msg, "url", value as string | undefined),
    },
    channelStructuredContext: {
      get: () => msg.payload.channelStructuredContext,
      set: (value) =>
        (msg.payload.channelStructuredContext =
          value as typeof msg.payload.channelStructuredContext),
    },
    untrustedStructuredContext: {
      get: () => msg.payload.channelStructuredContext,
      set: (value) =>
        (msg.payload.channelStructuredContext =
          value as typeof msg.payload.channelStructuredContext),
    },
    isBatched: {
      get: () => msg.event.isBatched,
      set: (value) => (msg.event.isBatched = value as boolean | undefined),
    },
  });
}

function normalizeLegacyFlatWebInboundMessage(msg: LegacyFlatWebInboundMessage): WebInboundMessage {
  const media =
    msg.mediaPath || msg.mediaType || msg.mediaFileName || msg.mediaUrl
      ? {
          path: msg.mediaPath,
          type: msg.mediaType,
          fileName: msg.mediaFileName,
          url: msg.mediaUrl,
        }
      : undefined;
  return withDeprecatedWebInboundMessageFlatAliases({
    ...msg,
    admission: msg.admission ?? buildDeprecatedFlatWhatsAppInboundAdmission(msg),
    event: {
      id: msg.id,
      timestamp: msg.timestamp,
      isBatched: msg.isBatched,
    },
    payload: {
      body: msg.body,
      media,
      location: msg.location,
      channelStructuredContext: msg.channelStructuredContext ?? msg.untrustedStructuredContext,
    },
    platform: {
      chatJid: msg.chatId,
      recipientJid: msg.to,
      sender: msg.sender,
      senderJid: msg.senderJid,
      senderE164: msg.senderE164,
      senderName: msg.senderName,
      pushName: msg.pushName,
      self: msg.self,
      selfJid: msg.selfJid,
      selfLid: msg.selfLid,
      selfE164: msg.selfE164,
      fromMe: msg.fromMe,
      sendComposing: msg.sendComposing,
      reply: msg.reply,
      sendMedia: msg.sendMedia,
    },
    quote: buildQuoteFromFlatAliases(msg),
    group: buildGroupFromFlatAliases(msg),
  });
}

export function normalizeWebInboundMessage(msg: WebInboundMessageInput): WebInboundMessage {
  if (msg.event && msg.payload && msg.platform) {
    return withDeprecatedWebInboundMessageFlatAliases(msg);
  }

  if (msg.event || msg.payload || msg.platform || msg.quote || msg.group) {
    throw new Error(
      "WhatsApp inbound messages must be either legacy flat or canonical nested; partial nested contexts are not supported.",
    );
  }

  return normalizeLegacyFlatWebInboundMessage(msg);
}
