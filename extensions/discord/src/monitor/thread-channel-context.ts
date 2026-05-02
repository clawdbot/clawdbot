import { ChannelType } from "../internal/discord.js";
import { normalizeDiscordSlug } from "./allow-list.js";
import {
  resolveDiscordChannelIdSafe,
  resolveDiscordChannelInfoSafe,
  resolveDiscordChannelParentIdSafe,
} from "./channel-access.js";
import {
  resolveDiscordChannelInfo,
  type DiscordChannelInfo,
  type DiscordChannelInfoClient,
} from "./message-utils.js";
import { resolveDiscordThreadParentInfo } from "./threading.js";

type DiscordThreadLikeChannelContext = {
  channelType?: ChannelType;
  isThreadChannel: boolean;
  channelId: string;
  channelName?: string;
  channelSlug: string;
  parentId?: string;
  threadParentId?: string;
  threadParentName?: string;
  threadParentSlug: string;
  channelInfo: DiscordChannelInfo | null;
};

function isDiscordThreadChannelType(type: ChannelType | number | undefined): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

function buildFetchedChannelInfo(channel: unknown): DiscordChannelInfo | null {
  const channelInfo = resolveDiscordChannelInfoSafe(channel);
  if (channelInfo.type === undefined) {
    return null;
  }
  return {
    type: channelInfo.type as ChannelType,
    name: channelInfo.name,
    topic: channelInfo.topic,
    parentId: channelInfo.parentId,
    ownerId: channelInfo.ownerId,
  };
}

export async function resolveDiscordThreadLikeChannelContext(params: {
  client: DiscordChannelInfoClient;
  channel: unknown;
  channelIdFallback?: string;
  channelInfo?: DiscordChannelInfo | null;
}): Promise<DiscordThreadLikeChannelContext> {
  const safeChannelInfo = resolveDiscordChannelInfoSafe(params.channel);
  const channelId = resolveDiscordChannelIdSafe(params.channel) ?? params.channelIdFallback ?? "";
  const channelInfo =
    params.channelInfo !== undefined
      ? params.channelInfo
      : channelId
        ? await resolveDiscordChannelInfo(params.client, channelId)
        : null;
  const channelType = (safeChannelInfo.type as ChannelType | undefined) ?? channelInfo?.type;
  const channelName = safeChannelInfo.name ?? channelInfo?.name;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const parentId = resolveDiscordChannelParentIdSafe(params.channel) ?? channelInfo?.parentId;
  const isThreadChannel = isDiscordThreadChannelType(channelType);

  let threadParentId: string | undefined;
  let threadParentName: string | undefined;
  let threadParentSlug = "";
  if (channelId && isThreadChannel) {
    const parentInfo = await resolveDiscordThreadParentInfo({
      client: params.client,
      threadChannel: {
        id: channelId,
        name: channelName,
        parentId,
        parent: undefined,
      },
      channelInfo,
    });
    threadParentId = parentInfo.id;
    threadParentName = parentInfo.name;
    threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";
  }

  return {
    channelType,
    isThreadChannel,
    channelId,
    channelName,
    channelSlug,
    parentId,
    threadParentId,
    threadParentName,
    threadParentSlug,
    channelInfo,
  };
}

export async function resolveFetchedDiscordThreadLikeChannelContext(params: {
  client: DiscordChannelInfoClient;
  channel: unknown;
  channelIdFallback?: string;
}): Promise<DiscordThreadLikeChannelContext> {
  return await resolveDiscordThreadLikeChannelContext({
    ...params,
    channelInfo: buildFetchedChannelInfo(params.channel),
  });
}
