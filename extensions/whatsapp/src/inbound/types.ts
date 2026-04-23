import type { AnyMessageContent, MiscMessageGenerationOptions } from "@whiskeysockets/baileys";
import type { NormalizedLocation } from "openclaw/plugin-sdk/channel-inbound";
import type { PollInput } from "openclaw/plugin-sdk/media-runtime";
import type { WhatsAppIdentity, WhatsAppReplyContext, WhatsAppSelfIdentity } from "../identity.js";

export type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
};

export type ActiveWebSendOptions = {
  quotedMessageKey?: {
    id: string;
    remoteJid: string;
    fromMe: boolean;
    participant?: string;
    messageText?: string;
  };
  gifPlayback?: boolean;
  accountId?: string;
  fileName?: string;
};

export type ActiveWebListener = {
  sendMessage: (
    to: string,
    text: string,
    mediaBuffer?: Buffer,
    mediaType?: string,
    options?: ActiveWebSendOptions,
  ) => Promise<{ messageId: string }>;
  sendPoll: (to: string, poll: PollInput) => Promise<{ messageId: string }>;
  sendReaction: (
    chatJid: string,
    messageId: string,
    emoji: string,
    fromMe: boolean,
    participant?: string,
  ) => Promise<void>;
  sendComposingTo: (to: string) => Promise<void>;
  close?: () => Promise<void>;
};

export type WhatsAppStructuredContactContext = {
  kind: "contact" | "contacts";
  total: number;
  contacts: Array<{
    name?: string;
    phones?: string[];
  }>;
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
  sender?: WhatsAppIdentity;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  replyTo?: WhatsAppReplyContext;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToSenderJid?: string;
  replyToSenderE164?: string;
  groupSubject?: string;
  groupParticipants?: string[];
  mentions?: string[];
  mentionedJids?: string[];
  self?: WhatsAppSelfIdentity;
  selfJid?: string | null;
  selfLid?: string | null;
  selfE164?: string | null;
  fromMe?: boolean;
  location?: NormalizedLocation;
  sendComposing: () => Promise<void>;
  reply: (text: string, options?: MiscMessageGenerationOptions) => Promise<void>;
  sendMedia: (payload: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<void>;
  mediaPath?: string;
  mediaType?: string;
  mediaFileName?: string;
  mediaUrl?: string;
  untrustedStructuredContext?: Array<{
    label: string;
    source?: string;
    type?: string;
    payload: unknown;
  }>;
  wasMentioned?: boolean;
  isBatched?: boolean;
};
