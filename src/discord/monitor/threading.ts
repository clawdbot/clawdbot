import { ChannelType, type Client } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { createReplyReferencePlanner } from "../../auto-reply/reply/reply-reference.js";
import type { ReplyToMode } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { DiscordChannelConfigResolved } from "./allow-list.js";
import type { DiscordMessageEvent } from "./listeners.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";

export type DiscordThreadChannel = {
  id: string;
  name?: string | null;
  parentId?: string | null;
  parent?: { id?: string; name?: string };
  ownerId?: string | null;
};

export type DiscordThreadStarter = {
  text: string;
  author: string;
  timestamp?: number;
};

type DiscordThreadParentInfo = {
  id?: string;
  name?: string;
  type?: ChannelType;
};

const DISCORD_THREAD_STARTER_CACHE = new Map<string, DiscordThreadStarter>();

export function __resetDiscordThreadStarterCacheForTest() {
  DISCORD_THREAD_STARTER_CACHE.clear();
}

function isDiscordThreadType(type: ChannelType | undefined): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

export function resolveDiscordThreadChannel(params: {
  isGuildMessage: boolean;
  message: DiscordMessageEvent["message"];
  channelInfo: import("./message-utils.js").DiscordChannelInfo | null;
}): DiscordThreadChannel | null {
  if (!params.isGuildMessage) return null;
  const { message, channelInfo } = params;
  const channel = "channel" in message ? (message as { channel?: unknown }).channel : undefined;
  const isThreadChannel =
    channel &&
    typeof channel === "object" &&
    "isThread" in channel &&
    typeof (channel as { isThread?: unknown }).isThread === "function" &&
    (channel as { isThread: () => boolean }).isThread();
  if (isThreadChannel) return channel as unknown as DiscordThreadChannel;
  if (!isDiscordThreadType(channelInfo?.type)) return null;
  return {
    id: message.channelId,
    name: channelInfo?.name ?? undefined,
    parentId: channelInfo?.parentId ?? undefined,
    parent: undefined,
    ownerId: channelInfo?.ownerId ?? undefined,
  };
}

export async function resolveDiscordThreadParentInfo(params: {
  client: Client;
  threadChannel: DiscordThreadChannel;
  channelInfo: import("./message-utils.js").DiscordChannelInfo | null;
}): Promise<DiscordThreadParentInfo> {
  const { threadChannel, channelInfo, client } = params;
  const parentId =
    threadChannel.parentId ?? threadChannel.parent?.id ?? channelInfo?.parentId ?? undefined;
  if (!parentId) return {};
  let parentName = threadChannel.parent?.name;
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
  const cached = DISCORD_THREAD_STARTER_CACHE.get(cacheKey);
  if (cached) return cached;
  try {
    const parentType = params.parentType;
    const isForumParent =
      parentType === ChannelType.GuildForum || parentType === ChannelType.GuildMedia;
    const messageChannelId = isForumParent ? params.channel.id : params.parentId;
    if (!messageChannelId) return null;
    const starter = (await params.client.rest.get(
      Routes.channelMessage(messageChannelId, params.channel.id),
    )) as {
      content?: string | null;
      embeds?: Array<{ description?: string | null }>;
      member?: { nick?: string | null; displayName?: string | null };
      author?: {
        id?: string | null;
        username?: string | null;
        discriminator?: string | null;
      };
      timestamp?: string | null;
    };
    if (!starter) return null;
    const text = starter.content?.trim() ?? starter.embeds?.[0]?.description?.trim() ?? "";
    if (!text) return null;
    const author =
      starter.member?.nick ??
      starter.member?.displayName ??
      (starter.author
        ? starter.author.discriminator && starter.author.discriminator !== "0"
          ? `${starter.author.username ?? "Unknown"}#${starter.author.discriminator}`
          : (starter.author.username ?? starter.author.id ?? "Unknown")
        : "Unknown");
    const timestamp = params.resolveTimestampMs(starter.timestamp);
    const payload: DiscordThreadStarter = {
      text,
      author,
      timestamp: timestamp ?? undefined,
    };
    DISCORD_THREAD_STARTER_CACHE.set(cacheKey, payload);
    return payload;
  } catch {
    return null;
  }
}

export function resolveDiscordReplyTarget(opts: {
  replyToMode: ReplyToMode;
  replyToId?: string;
  hasReplied: boolean;
}): string | undefined {
  if (opts.replyToMode === "off") return undefined;
  const replyToId = opts.replyToId?.trim();
  if (!replyToId) return undefined;
  if (opts.replyToMode === "all") return replyToId;
  return opts.hasReplied ? undefined : replyToId;
}

export function sanitizeDiscordThreadName(rawName: string, fallbackId: string): string {
  const cleanedName = rawName
    .replace(/<@!?\d+>/g, "") // user mentions
    .replace(/<@&\d+>/g, "") // role mentions
    .replace(/<#\d+>/g, "") // channel mentions
    .replace(/\s+/g, " ")
    .trim();
  const baseSource = cleanedName || `Thread ${fallbackId}`;
  const base = truncateUtf16Safe(baseSource, 80);
  return truncateUtf16Safe(base, 100) || `Thread ${fallbackId}`;
}

type DiscordReplyDeliveryPlan = {
  deliverTarget: string;
  replyTarget: string;
  replyReference: ReturnType<typeof createReplyReferencePlanner>;
};

export type DiscordAutoThreadContext = {
  createdThreadId: string;
  From: string;
  To: string;
  OriginatingTo: string;
  SessionKey: string;
  ParentSessionKey: string;
};

export function resolveDiscordAutoThreadContext(params: {
  agentId: string;
  channel: string;
  messageChannelId: string;
  createdThreadId?: string | null;
}): DiscordAutoThreadContext | null {
  const createdThreadId = String(params.createdThreadId ?? "").trim();
  if (!createdThreadId) return null;
  const messageChannelId = params.messageChannelId.trim();
  if (!messageChannelId) return null;

  const threadSessionKey = buildAgentSessionKey({
    agentId: params.agentId,
    channel: params.channel,
    peer: { kind: "channel", id: createdThreadId },
  });
  const parentSessionKey = buildAgentSessionKey({
    agentId: params.agentId,
    channel: params.channel,
    peer: { kind: "channel", id: messageChannelId },
  });

  return {
    createdThreadId,
    From: `${params.channel}:channel:${createdThreadId}`,
    To: `channel:${createdThreadId}`,
    OriginatingTo: `channel:${createdThreadId}`,
    SessionKey: threadSessionKey,
    ParentSessionKey: parentSessionKey,
  };
}

export type DiscordAutoThreadReplyPlan = DiscordReplyDeliveryPlan & {
  createdThreadId?: string;
  autoThreadContext: DiscordAutoThreadContext | null;
};

export async function resolveDiscordAutoThreadReplyPlan(params: {
  client: Client;
  message: DiscordMessageEvent["message"];
  isGuildMessage: boolean;
  channelConfig?: DiscordChannelConfigResolved | null;
  threadChannel?: DiscordThreadChannel | null;
  baseText: string;
  combinedBody: string;
  replyToMode: ReplyToMode;
  agentId: string;
  channel: string;
}): Promise<DiscordAutoThreadReplyPlan> {
  const originalReplyTarget = `channel:${params.message.channelId}`;
  const createdThreadId = await maybeCreateDiscordAutoThread({
    client: params.client,
    message: params.message,
    isGuildMessage: params.isGuildMessage,
    channelConfig: params.channelConfig,
    threadChannel: params.threadChannel,
    baseText: params.baseText,
    combinedBody: params.combinedBody,
  });
  const deliveryPlan = resolveDiscordReplyDeliveryPlan({
    replyTarget: originalReplyTarget,
    replyToMode: params.replyToMode,
    messageId: params.message.id,
    threadChannel: params.threadChannel,
    createdThreadId,
  });
  const autoThreadContext = params.isGuildMessage
    ? resolveDiscordAutoThreadContext({
        agentId: params.agentId,
        channel: params.channel,
        messageChannelId: params.message.channelId,
        createdThreadId,
      })
    : null;
  return { ...deliveryPlan, createdThreadId, autoThreadContext };
}

export async function maybeCreateDiscordAutoThread(params: {
  client: Client;
  message: DiscordMessageEvent["message"];
  isGuildMessage: boolean;
  channelConfig?: DiscordChannelConfigResolved | null;
  threadChannel?: DiscordThreadChannel | null;
  baseText: string;
  combinedBody: string;
}): Promise<string | undefined> {
  if (!params.isGuildMessage) return undefined;
  if (!params.channelConfig?.autoThread) return undefined;
  if (params.threadChannel) return undefined;
  try {
    const threadName = sanitizeDiscordThreadName(
      params.baseText || params.combinedBody || "Thread",
      params.message.id,
    );
    const created = (await params.client.rest.post(
      `${Routes.channelMessage(params.message.channelId, params.message.id)}/threads`,
      {
        body: {
          name: threadName,
          auto_archive_duration: 60,
        },
      },
    )) as { id?: string };
    const createdId = created?.id ? String(created.id) : "";
    return createdId || undefined;
  } catch (err) {
    logVerbose(
      `discord: autoThread failed for ${params.message.channelId}/${params.message.id}: ${String(err)}`,
    );
    return undefined;
  }
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
