import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { createReplyReferencePlanner } from "openclaw/plugin-sdk/reply-reference";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { ChannelType, getChannelMessage, type Client } from "../internal/discord.js";
import {
  resolveDiscordChannelIdSafe,
  resolveDiscordChannelNameSafe,
  resolveDiscordChannelParentIdSafe,
  resolveDiscordChannelParentSafe,
} from "./channel-access.js";
import {
  resolveDiscordChannelInfo,
  resolveDiscordEmbedText,
  resolveDiscordForwardedMessagesTextFromSnapshots,
  resolveDiscordMessageChannelId,
  type DiscordChannelInfo,
  type DiscordChannelInfoClient,
} from "./message-utils.js";
import { getCachedThreadStarter, setCachedThreadStarter } from "./threading.cache.js";
import type {
  DiscordMessageEvent,
  DiscordReplyDeliveryPlan,
  DiscordThreadChannel,
  DiscordThreadParentInfo,
  DiscordThreadStarter,
  DiscordThreadStarterRestAuthor,
  DiscordThreadStarterRestMember,
  DiscordThreadStarterRestMessage,
} from "./threading.types.js";

function isDiscordThreadType(type: ChannelType | undefined): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

function isDiscordForumParentType(parentType: ChannelType | undefined): boolean {
  return parentType === ChannelType.GuildForum || parentType === ChannelType.GuildMedia;
}

export function resolveDiscordThreadChannel(params: {
  isGuildMessage: boolean;
  message: DiscordMessageEvent["message"];
  channelInfo: DiscordChannelInfo | null;
  messageChannelId?: string;
}): DiscordThreadChannel | null {
  if (!params.isGuildMessage) {
    return null;
  }
  const { message, channelInfo } = params;
  const channel = "channel" in message ? (message as { channel?: unknown }).channel : undefined;
  const isThreadChannel =
    channel &&
    typeof channel === "object" &&
    "isThread" in channel &&
    typeof (channel as { isThread?: unknown }).isThread === "function" &&
    (channel as { isThread: () => boolean }).isThread();
  if (isThreadChannel) {
    return channel as unknown as DiscordThreadChannel;
  }
  if (!isDiscordThreadType(channelInfo?.type)) {
    return null;
  }
  const messageChannelId =
    params.messageChannelId ||
    resolveDiscordMessageChannelId({
      message,
    });
  if (!messageChannelId) {
    return null;
  }
  return {
    id: messageChannelId,
    name: channelInfo?.name ?? undefined,
    parentId: channelInfo?.parentId ?? undefined,
    parent: undefined,
    ownerId: channelInfo?.ownerId ?? undefined,
  };
}

export async function resolveDiscordThreadParentInfo(params: {
  client: DiscordChannelInfoClient;
  threadChannel: DiscordThreadChannel;
  channelInfo: DiscordChannelInfo | null;
}): Promise<DiscordThreadParentInfo> {
  const { threadChannel, channelInfo, client } = params;
  const parent = resolveDiscordChannelParentSafe(threadChannel);
  let parentId =
    resolveDiscordChannelParentIdSafe(threadChannel) ??
    resolveDiscordChannelIdSafe(parent) ??
    channelInfo?.parentId ??
    undefined;
  if (!parentId && threadChannel.id) {
    const threadInfo = await resolveDiscordChannelInfo(client, threadChannel.id);
    parentId = threadInfo?.parentId ?? undefined;
  }
  if (!parentId) {
    return {};
  }
  let parentName = resolveDiscordChannelNameSafe(parent);
  const parentInfo = await resolveDiscordChannelInfo(client, parentId);
  parentName = parentName ?? parentInfo?.name;
  const parentType = parentInfo?.type;
  return { id: parentId, name: parentName, type: parentType };
}

export async function resolveDiscordThreadStarter(params: {
  channel: DiscordThreadChannel;
  client: Client;
  parentId?: string;
  parentType?: ChannelType;
  resolveTimestampMs: (value?: string | null) => number | undefined;
}): Promise<DiscordThreadStarter | null> {
  const cacheKey = params.channel.id;
  const now = Date.now();
  const cached = getCachedThreadStarter(cacheKey, now);
  if (cached) {
    return cached;
  }
  try {
    const messageChannelId = resolveDiscordThreadStarterMessageChannelId(params);
    if (!messageChannelId) {
      return null;
    }
    const starter = await fetchDiscordThreadStarterMessage({
      client: params.client,
      messageChannelId,
      threadId: params.channel.id,
    });
    if (!starter) {
      return null;
    }
    const payload = buildDiscordThreadStarterPayload({
      starter,
      resolveTimestampMs: params.resolveTimestampMs,
    });
    if (!payload) {
      return null;
    }
    setCachedThreadStarter(cacheKey, payload, Date.now());
    return payload;
  } catch {
    return null;
  }
}

function resolveDiscordThreadStarterMessageChannelId(params: {
  channel: DiscordThreadChannel;
  parentId?: string;
  parentType?: ChannelType;
}): string | undefined {
  return isDiscordForumParentType(params.parentType) ? params.channel.id : params.parentId;
}

async function fetchDiscordThreadStarterMessage(params: {
  client: Client;
  messageChannelId: string;
  threadId: string;
}): Promise<DiscordThreadStarterRestMessage | null> {
  const starter = await getChannelMessage(
    params.client.rest,
    params.messageChannelId,
    params.threadId,
  );
  return starter ? (starter as DiscordThreadStarterRestMessage) : null;
}

function buildDiscordThreadStarterPayload(params: {
  starter: DiscordThreadStarterRestMessage;
  resolveTimestampMs: (value?: string | null) => number | undefined;
}): DiscordThreadStarter | null {
  const text = resolveDiscordThreadStarterText(params.starter);
  if (!text) {
    return null;
  }
  return {
    text,
    ...resolveDiscordThreadStarterIdentity(params.starter),
    timestamp: params.resolveTimestampMs(params.starter.timestamp) ?? undefined,
  };
}

function resolveDiscordThreadStarterText(starter: DiscordThreadStarterRestMessage): string {
  const content = normalizeOptionalString(starter.content) ?? "";
  const embedText = resolveDiscordEmbedText(starter.embeds?.[0]);
  const forwardedText = resolveDiscordForwardedMessagesTextFromSnapshots(starter.message_snapshots);
  return content || embedText || forwardedText;
}

function resolveDiscordThreadStarterIdentity(
  starter: DiscordThreadStarterRestMessage,
): Omit<DiscordThreadStarter, "text" | "timestamp"> {
  const author = resolveDiscordThreadStarterAuthor(starter);
  return {
    author,
    authorId: starter.author?.id ?? undefined,
    authorName: starter.author?.username ?? undefined,
    authorTag: resolveDiscordThreadStarterAuthorTag(starter.author),
    memberRoleIds: resolveDiscordThreadStarterRoleIds(starter.member),
  };
}

function resolveDiscordThreadStarterAuthor(starter: DiscordThreadStarterRestMessage): string {
  return (
    starter.member?.nick ??
    starter.member?.displayName ??
    resolveDiscordThreadStarterAuthorTag(starter.author) ??
    starter.author?.username ??
    starter.author?.id ??
    "Unknown"
  );
}

function resolveDiscordThreadStarterAuthorTag(
  author: DiscordThreadStarterRestAuthor | null | undefined,
): string | undefined {
  if (!author?.username || !author.discriminator) {
    return undefined;
  }
  if (author.discriminator !== "0") {
    return `${author.username}#${author.discriminator}`;
  }
  return author.username;
}

function resolveDiscordThreadStarterRoleIds(
  member: DiscordThreadStarterRestMember | null | undefined,
): string[] | undefined {
  return Array.isArray(member?.roles) ? member.roles : undefined;
}

export function resolveDiscordReplyTarget(opts: {
  replyToMode: ReplyToMode;
  replyToId?: string;
  hasReplied: boolean;
}): string | undefined {
  if (opts.replyToMode === "off") {
    return undefined;
  }
  const replyToId = normalizeOptionalString(opts.replyToId);
  if (!replyToId) {
    return undefined;
  }
  if (opts.replyToMode === "all") {
    return replyToId;
  }
  return opts.hasReplied ? undefined : replyToId;
}

export function sanitizeDiscordThreadName(rawName: string, fallbackId: string): string {
  const cleanedName = rawName
    .replace(/<@!?\d+>/g, "")
    .replace(/<@&\d+>/g, "")
    .replace(/<#\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const baseSource = cleanedName || `Thread ${fallbackId}`;
  const base = truncateUtf16Safe(baseSource, 80);
  return truncateUtf16Safe(base, 100) || `Thread ${fallbackId}`;
}

export function resolveDiscordReplyDeliveryPlan(params: {
  replyTarget: string;
  replyToMode: ReplyToMode;
  messageId: string;
  threadChannel?: DiscordThreadChannel | null;
  createdThreadId?: string | null;
}): DiscordReplyDeliveryPlan {
  const originalReplyTarget = params.replyTarget;
  let deliverTarget = originalReplyTarget;
  let replyTarget = originalReplyTarget;

  if (params.createdThreadId) {
    deliverTarget = `channel:${params.createdThreadId}`;
    replyTarget = deliverTarget;
  }
  const allowReference = deliverTarget === originalReplyTarget;
  const replyReference = createReplyReferencePlanner({
    replyToMode: allowReference ? params.replyToMode : "off",
    existingId: params.threadChannel ? params.messageId : undefined,
    startId: params.messageId,
    allowReference,
  });
  return { deliverTarget, replyTarget, replyReference };
}
