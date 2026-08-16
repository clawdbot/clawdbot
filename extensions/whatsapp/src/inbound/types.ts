// Whatsapp type declarations define plugin contracts.
import type { AnyMessageContent, MiscMessageGenerationOptions } from "baileys";
import type {
  ChannelInboundMediaInput,
  MediaPlaceholderTextFact,
  NormalizedLocation,
} from "openclaw/plugin-sdk/channel-inbound";
import type { PollInput } from "openclaw/plugin-sdk/poll-runtime";
import type { WhatsAppIdentity, WhatsAppReplyContext, WhatsAppSelfIdentity } from "../identity.js";
import type { WhatsAppQuotedMessageKey } from "../quoted-message.js";
import type { WhatsAppInboundAdmission } from "./admission.js";
import type { WhatsAppSendResult } from "./send-result.js";

export type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
};

export type ActiveWebSendOptions = {
  quotedMessageKey?: WhatsAppQuotedMessageKey;
  gifPlayback?: boolean;
  accountId?: string;
  fileName?: string;
  asDocument?: boolean;
};

export type ActiveWebListener = {
  assertSendReady?: (to: string) => Promise<void>;
  sendMessage: (
    to: string,
    text: string,
    mediaBuffer?: Buffer,
    mediaType?: string,
    options?: ActiveWebSendOptions,
  ) => Promise<WhatsAppSendResult>;
  sendPoll: (to: string, poll: PollInput) => Promise<WhatsAppSendResult>;
  sendReaction: (
    chatJid: string,
    messageId: string,
    emoji: string,
    fromMe: boolean,
    participant?: string,
  ) => Promise<WhatsAppSendResult>;
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

type WhatsAppInboundEvent = {
  id?: string;
  timestamp?: number;
  isBatched?: boolean;
};

type WhatsAppInboundQuote = {
  context?: WhatsAppReplyContext;
  id?: string;
  body?: string;
  media?: MediaPlaceholderTextFact;
  sender?: {
    displayName?: string;
    jid?: string;
    e164?: string;
  };
};

type WhatsAppInboundGroupContext = {
  subject?: string;
  participants?: string[];
  mentions?: {
    text?: string[];
    jids?: string[];
  };
};

type WhatsAppInboundStructuredContextEntry = {
  label: string;
  source?: string;
  type?: string;
  payload: unknown;
};

type WhatsAppInboundPayload = {
  body: string;
  commandBody?: string;
  media?: {
    path?: string;
    type?: string;
    fileName?: string;
    url?: string;
    kind?: ChannelInboundMediaInput["kind"];
  };
  location?: NormalizedLocation;
  channelStructuredContext?: WhatsAppInboundStructuredContextEntry[];
};

type WhatsAppInboundPlatform = {
  chatJid: string;
  recipientJid: string;
  sender?: WhatsAppIdentity;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  pushName?: string;
  self?: WhatsAppSelfIdentity;
  selfJid?: string | null;
  selfLid?: string | null;
  selfE164?: string | null;
  fromMe?: boolean;
  sendComposing: () => Promise<void>;
  reply: (text: string, options?: MiscMessageGenerationOptions) => Promise<WhatsAppSendResult>;
  sendMedia: (
    payload: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ) => Promise<WhatsAppSendResult>;
};

export type WebInboundCallbackMessage = {
  admission: WhatsAppInboundAdmission;
  event: WhatsAppInboundEvent;
  payload: WhatsAppInboundPayload;
  platform: WhatsAppInboundPlatform;
  quote?: WhatsAppInboundQuote;
  group?: WhatsAppInboundGroupContext;
  wasMentioned?: boolean;
  groupMention?: {
    wasMentioned: boolean;
    requireMention: boolean;
  };
};

export type WebInboundMessage = WebInboundCallbackMessage;
export type AdmittedWebInboundMessage = WebInboundCallbackMessage;
export type AdmittedWebInboundCallbackMessage = WebInboundCallbackMessage;
