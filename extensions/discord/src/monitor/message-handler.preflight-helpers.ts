// Discord helper module supports message handler.preflight helpers behavior.
import {
  implicitMentionKindWhen,
  matchesMentionWithExplicit,
} from "openclaw/plugin-sdk/channel-inbound";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { findCodeRegions, isInsideCode } from "openclaw/plugin-sdk/text-chunking";
import { ChannelType, type Message } from "../internal/discord.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import type { DiscordChannelInfo } from "./message-utils.js";

const DISCORD_BOUND_THREAD_SYSTEM_PREFIXES = ["⚙️", "🤖", "🧰"];

export function isBoundThreadBotSystemMessage(params: {
  isBoundThreadSession: boolean;
  isBotAuthor: boolean;
  text?: string;
}): boolean {
  if (!params.isBoundThreadSession || !params.isBotAuthor) {
    return false;
  }
  const text = params.text?.trim();
  if (!text) {
    return false;
  }
  return DISCORD_BOUND_THREAD_SYSTEM_PREFIXES.some((prefix) => text.startsWith(prefix));
}

type BoundThreadLookupRecordLike = {
  webhookId?: string | null;
  metadata?: {
    webhookId?: string | null;
  };
};

function isDiscordThreadChannelType(type: ChannelType | undefined): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

export function isDiscordThreadChannelMessage(params: {
  isGuildMessage: boolean;
  message: Message;
  channelInfo: DiscordChannelInfo | null;
}): boolean {
  if (!params.isGuildMessage) {
    return false;
  }
  const channel =
    "channel" in params.message ? (params.message as { channel?: unknown }).channel : undefined;
  return Boolean(
    (channel &&
      typeof channel === "object" &&
      "isThread" in channel &&
      typeof (channel as { isThread?: unknown }).isThread === "function" &&
      (channel as { isThread: () => boolean }).isThread()) ||
    isDiscordThreadChannelType(params.channelInfo?.type),
  );
}

export function resolveInjectedBoundThreadLookupRecord(params: {
  threadBindings: DiscordMessagePreflightParams["threadBindings"];
  threadId: string;
}): BoundThreadLookupRecordLike | undefined {
  const getByThreadId = (params.threadBindings as { getByThreadId?: (threadId: string) => unknown })
    .getByThreadId;
  if (typeof getByThreadId !== "function") {
    return undefined;
  }
  const binding = getByThreadId(params.threadId);
  return binding && typeof binding === "object"
    ? (binding as BoundThreadLookupRecordLike)
    : undefined;
}

export function resolveDiscordMentionState(params: {
  authorIsBot: boolean;
  botId?: string;
  hasAnyMention: boolean;
  isDirectMessage: boolean;
  isExplicitlyMentioned: boolean;
  mentionRegexes: RegExp[];
  mentionText: string;
  mentionedEveryone: boolean;
  referencedAuthorId?: string;
  senderIsPluralKit: boolean;
  transcript?: string;
}) {
  if (params.isDirectMessage) {
    return {
      implicitMentionKinds: [],
      wasMentioned: false,
    };
  }

  const everyoneMentioned =
    params.mentionedEveryone && (!params.authorIsBot || params.senderIsPluralKit);
  const wasMentioned =
    everyoneMentioned ||
    matchesMentionWithExplicit({
      text: params.mentionText,
      mentionRegexes: params.mentionRegexes,
      explicit: {
        hasAnyMention: params.hasAnyMention,
        isExplicitlyMentioned: params.isExplicitlyMentioned,
        canResolveExplicit: Boolean(params.botId),
      },
      transcript: params.transcript,
    });
  const implicitMentionKinds = implicitMentionKindWhen(
    "reply_to_bot",
    Boolean(params.botId) &&
      Boolean(params.referencedAuthorId) &&
      params.referencedAuthorId === params.botId,
  );

  return {
    implicitMentionKinds,
    wasMentioned,
  };
}

export function hasRawDiscordUserMention(text: string, userId?: string): boolean {
  if (!userId) {
    return false;
  }
  const codeRegions = findCodeRegions(text);
  for (const mention of [`<@${userId}>`, `<@!${userId}>`]) {
    let index = text.indexOf(mention);
    while (index >= 0) {
      let precedingBackslashes = 0;
      for (let offset = index - 1; offset >= 0 && text[offset] === "\\"; offset -= 1) {
        precedingBackslashes += 1;
      }
      if (precedingBackslashes % 2 === 0 && !isInsideCode(index, codeRegions)) {
        return true;
      }
      index = text.indexOf(mention, index + mention.length);
    }
  }
  return false;
}

export function resolvePreflightMentionRequirement(params: {
  shouldRequireMention: boolean;
  bypassMentionRequirement: boolean;
}): boolean {
  if (!params.shouldRequireMention) {
    return false;
  }
  return !params.bypassMentionRequirement;
}

export function shouldIgnoreBoundThreadWebhookMessage(params: {
  threadId?: string;
  webhookId?: string | null;
  threadBinding?: BoundThreadLookupRecordLike;
}): boolean {
  const webhookId = normalizeOptionalString(params.webhookId) ?? "";
  if (!webhookId) {
    return false;
  }
  const boundWebhookId =
    normalizeOptionalString(params.threadBinding?.webhookId) ??
    normalizeOptionalString(params.threadBinding?.metadata?.webhookId) ??
    "";
  if (boundWebhookId && webhookId === boundWebhookId) {
    return true;
  }
  const threadId = normalizeOptionalString(params.threadId) ?? "";
  if (!threadId) {
    return false;
  }
  if (params.threadBinding) {
    return true;
  }
  return false;
}
