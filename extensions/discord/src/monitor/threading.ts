import { ChannelType, type Client } from "@buape/carbon";
import { Routes, type APIAttachment, type APIStickerItem } from "discord-api-types/v10";
import {
  resolveChannelModelOverride,
  type OpenClawConfig,
  type ReplyToMode,
} from "openclaw/plugin-sdk/config-runtime";
import { createReplyReferencePlanner } from "openclaw/plugin-sdk/reply-reference";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
  truncateUtf16Safe,
} from "openclaw/plugin-sdk/text-runtime";
import type { DiscordChannelConfigResolved } from "./allow-list.js";
import type { DiscordMessageEvent } from "./listeners.js";
import {
  resolveDiscordChannelInfo,
  resolveDiscordEmbedText,
  resolveDiscordForwardedMessagesTextFromSnapshots,
  resolveDiscordMessageChannelId,
} from "./message-utils.js";
import { generateThreadTitle } from "./thread-title.js";

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
  authorId?: string;
  authorName?: string;
  authorTag?: string;
  memberRoleIds?: string[];
  timestamp?: number;
};

type DiscordThreadParentInfo = {
  id?: string;
  name?: string;
  type?: ChannelType;
};

type DiscordThreadStarterRestEmbed = {
  title?: string | null;
  description?: string | null;
};

type DiscordThreadStarterRestSnapshotMessage = {
  content?: string | null;
  attachments?: APIAttachment[] | null;
  embeds?: DiscordThreadStarterRestEmbed[] | null;
  sticker_items?: APIStickerItem[] | null;
};

type DiscordThreadStarterRestAuthor = {
  id?: string | null;
  username?: string | null;
  discriminator?: string | null;
};

type DiscordThreadStarterRestMember = {
  nick?: string | null;
  displayName?: string | null;
  roles?: string[];
};

type DiscordThreadStarterRestMessage = {
  content?: string | null;
  embeds?: DiscordThreadStarterRestEmbed[] | null;
  message_snapshots?: Array<{ message?: DiscordThreadStarterRestSnapshotMessage | null }> | null;
  member?: DiscordThreadStarterRestMember | null;
  author?: DiscordThreadStarterRestAuthor | null;
  timestamp?: string | null;
};

// Cache entry with timestamp for TTL-based eviction
type DiscordThreadStarterCacheEntry = {
  value: DiscordThreadStarter;
  updatedAt: number;
};

// Cache configuration: 5 minute TTL (thread starters rarely change), max 500 entries
const DISCORD_THREAD_STARTER_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCORD_THREAD_STARTER_CACHE_MAX = 500;

const DISCORD_THREAD_STARTER_CACHE = new Map<string, DiscordThreadStarterCacheEntry>();

export function __resetDiscordThreadStarterCacheForTest() {
  DISCORD_THREAD_STARTER_CACHE.clear();
}

// Get cached entry with TTL check, refresh LRU position on hit
function getCachedThreadStarter(key: string, now: number): DiscordThreadStarter | undefined {
  const entry = DISCORD_THREAD_STARTER_CACHE.get(key);
  if (!entry) {
    return undefined;
  }
  // Check TTL expiry
  if (now - entry.updatedAt > DISCORD_THREAD_STARTER_CACHE_TTL_MS) {
    DISCORD_THREAD_STARTER_CACHE.delete(key);
    return undefined;
  }
  // Refresh LRU position by re-inserting (Map maintains insertion order)
  DISCORD_THREAD_STARTER_CACHE.delete(key);
  DISCORD_THREAD_STARTER_CACHE.set(key, { ...entry, updatedAt: now });
  return entry.value;
}

// Set cached entry with LRU eviction when max size exceeded
function setCachedThreadStarter(key: string, value: DiscordThreadStarter, now: number): void {
  // Remove existing entry first (to update LRU position)
  DISCORD_THREAD_STARTER_CACHE.delete(key);
  DISCORD_THREAD_STARTER_CACHE.set(key, { value, updatedAt: now });
  // Evict oldest entries (first in Map) when over max size
  while (DISCORD_THREAD_STARTER_CACHE.size > DISCORD_THREAD_STARTER_CACHE_MAX) {
    const iter = DISCORD_THREAD_STARTER_CACHE.keys().next();
    if (iter.done) {
      break;
    }
    DISCORD_THREAD_STARTER_CACHE.delete(iter.value);
  }
}

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

function resolveTrimmedDiscordMessageChannelId(params: {
  message: DiscordMessageEvent["message"];
  messageChannelId?: string;
}) {
  return (
    params.messageChannelId ||
    resolveDiscordMessageChannelId({
      message: params.message,
    })
  ).trim();
}

export function resolveDiscordThreadChannel(params: {
  isGuildMessage: boolean;
  message: DiscordMessageEvent["message"];
  channelInfo: import("./message-utils.js").DiscordChannelInfo | null;
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
  client: Client;
  threadChannel: DiscordThreadChannel;
  channelInfo: import("./message-utils.js").DiscordChannelInfo | null;
}): Promise<DiscordThreadParentInfo> {
  const { threadChannel, channelInfo, client } = params;
  let parentId =
    threadChannel.parentId ?? threadChannel.parent?.id ?? channelInfo?.parentId ?? undefined;
  if (!parentId && threadChannel.id) {
    const threadInfo = await resolveDiscordChannelInfo(client, threadChannel.id);
    parentId = threadInfo?.parentId ?? undefined;
  }
  if (!parentId) {
    return {};
  }
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
  const starter = await params.client.rest.get(
    Routes.channelMessage(params.messageChannelId, params.threadId),
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
  const createdThreadId = normalizeOptionalStringifiedId(params.createdThreadId) ?? "";
  if (!createdThreadId) {
    return null;
  }
  const messageChannelId = normalizeOptionalString(params.messageChannelId) ?? "";
  if (!messageChannelId) {
    return null;
  }

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

type MaybeCreateDiscordAutoThreadParams = {
  client: Client;
  message: DiscordMessageEvent["message"];
  messageChannelId?: string;
  channel?: string;
  isGuildMessage: boolean;
  channelConfig?: DiscordChannelConfigResolved | null;
  threadChannel?: DiscordThreadChannel | null;
  channelType?: ChannelType;
  channelName?: string;
  channelDescription?: string;
  baseText: string;
  combinedBody: string;
  cfg?: OpenClawConfig;
  agentId?: string;
};

export async function resolveDiscordAutoThreadReplyPlan(
  params: MaybeCreateDiscordAutoThreadParams & {
    replyToMode: ReplyToMode;
    agentId: string;
    channel: string;
    cfg?: OpenClawConfig;
  },
): Promise<DiscordAutoThreadReplyPlan> {
  const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
  // Prefer the resolved thread channel ID when available so replies stay in-thread.
  const targetChannelId = params.threadChannel?.id ?? (messageChannelId || "unknown");
  const originalReplyTarget = `channel:${targetChannelId}`;
  const createdThreadId = await maybeCreateDiscordAutoThread({
    client: params.client,
    message: params.message,
    messageChannelId: messageChannelId || undefined,
    channel: params.channel,
    isGuildMessage: params.isGuildMessage,
    channelConfig: params.channelConfig,
    threadChannel: params.threadChannel,
    channelType: params.channelType,
    channelName: params.channelName,
    channelDescription: params.channelDescription,
    baseText: params.baseText,
    combinedBody: params.combinedBody,
    cfg: params.cfg,
    agentId: params.agentId,
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
        messageChannelId,
        createdThreadId,
      })
    : null;
  return { ...deliveryPlan, createdThreadId, autoThreadContext };
}

export async function maybeCreateDiscordAutoThread(
  params: MaybeCreateDiscordAutoThreadParams,
): Promise<string | undefined> {
  if (!params.isGuildMessage) {
    return undefined;
  }
  if (!params.channelConfig?.autoThread) {
    return undefined;
  }
  if (params.threadChannel) {
    return undefined;
  }
  // Avoid creating threads in channels that don't support it or are already forums
  if (
    params.channelType === ChannelType.GuildForum ||
    params.channelType === ChannelType.GuildMedia ||
    params.channelType === ChannelType.GuildVoice ||
    params.channelType === ChannelType.GuildStageVoice
  ) {
    return undefined;
  }

  const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
  if (!messageChannelId) {
    return undefined;
  }
  try {
    const rawThreadSource = params.baseText || params.combinedBody || "Thread";
    const threadName = sanitizeDiscordThreadName(rawThreadSource, params.message.id);

    // Parse archive duration from config, default to 60 minutes
    const archiveDuration = params.channelConfig?.autoArchiveDuration
      ? Number(params.channelConfig.autoArchiveDuration)
      : 60;

    const created = (await params.client.rest.post(
      `${Routes.channelMessage(messageChannelId, params.message.id)}/threads`,
      {
        body: {
          name: threadName,
          auto_archive_duration: archiveDuration,
        },
      },
    )) as { id?: string };
    const createdId = created?.id || "";
    if (
      createdId &&
      params.channelConfig?.autoThreadName === "generated" &&
      params.cfg &&
      params.agentId
    ) {
      const modelRef = resolveDiscordThreadTitleModelRef({
        cfg: params.cfg,
        channel: params.channel,
        agentId: params.agentId,
        threadId: createdId,
        messageChannelId,
        channelName: params.channelName,
      });
      void maybeRenameDiscordAutoThread({
        client: params.client,
        threadId: createdId,
        currentName: threadName,
        fallbackId: params.message.id,
        sourceText: rawThreadSource,
        modelRef,
        channelName: params.channelName,
        channelDescription: params.channelDescription,
        cfg: params.cfg,
        agentId: params.agentId,
      });
    }
    return createdId || undefined;
  } catch (err) {
    logVerbose(
      `discord: autoThread creation failed for ${messageChannelId}/${params.message.id}: ${String(err)}`,
    );
    // Race condition: another agent may have already created a thread on this
    // message. Re-fetch the message to check for an existing thread.
    try {
      const msg = (await params.client.rest.get(
        Routes.channelMessage(messageChannelId, params.message.id),
      )) as { thread?: { id?: string } };
      const existingThreadId = msg?.thread?.id || "";
      if (existingThreadId) {
        logVerbose(
          `discord: autoThread reusing existing thread ${existingThreadId} on ${messageChannelId}/${params.message.id}`,
        );
        return existingThreadId;
      }
    } catch {
      // If the refetch also fails, fall through to return undefined.
    }
    return undefined;
  }
}

function resolveDiscordThreadTitleModelRef(params: {
  cfg: OpenClawConfig;
  channel?: string;
  agentId: string;
  threadId: string;
  messageChannelId: string;
  channelName?: string;
}): string | undefined {
  const channel = params.channel?.trim();
  if (!channel) {
    return undefined;
  }
  const parentSessionKey = buildAgentSessionKey({
    agentId: params.agentId,
    channel,
    peer: { kind: "channel", id: params.messageChannelId },
  });
  const channelLabel = params.channelName?.trim();
  const groupChannel = channelLabel ? `#${channelLabel}` : undefined;
  const channelOverride = resolveChannelModelOverride({
    cfg: params.cfg,
    channel,
    groupId: params.threadId,
    groupChatType: "channel",
    groupChannel,
    groupSubject: groupChannel,
    parentSessionKey,
  });
  return channelOverride?.model;
}

async function maybeRenameDiscordAutoThread(params: {
  client: Client;
  threadId: string;
  currentName: string;
  fallbackId: string;
  sourceText: string;
  modelRef?: string;
  channelName?: string;
  channelDescription?: string;
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  try {
    const fallbackName = sanitizeDiscordThreadName("", params.fallbackId);
    const generated = await generateThreadTitle({
      cfg: params.cfg,
      agentId: params.agentId,
      messageText: params.sourceText,
      modelRef: params.modelRef,
      channelName: params.channelName,
      channelDescription: params.channelDescription,
    });
    if (!generated) {
      return;
    }
    const nextName = sanitizeDiscordThreadName(generated, params.fallbackId);
    if (!nextName || nextName === params.currentName || nextName === fallbackName) {
      return;
    }
    await params.client.rest.patch(Routes.channel(params.threadId), {
      body: { name: nextName },
    });
  } catch (err) {
    logVerbose(`discord: autoThread rename failed for ${params.threadId}: ${String(err)}`);
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

  // When a new thread was created, route to the new thread.
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
