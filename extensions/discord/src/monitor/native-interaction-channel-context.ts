import { ChannelType, type Client } from "@buape/carbon";
import { normalizeDiscordSlug } from "./allow-list.js";
import {
  resolveDiscordChannelNameSafe,
  resolveDiscordChannelParentIdSafe,
} from "./channel-access.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";
import { resolveDiscordThreadParentInfo } from "./threading.js";

type DiscordInteractionChannel = {
  id?: string;
  type?: ChannelType;
};

export type DiscordNativeInteractionChannelContext = {
  channelType?: ChannelType;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isThreadChannel: boolean;
  channelName?: string;
  channelSlug: string;
  rawChannelId: string;
  threadParentId?: string;
  threadParentName?: string;
  threadParentSlug: string;
};

export async function resolveDiscordNativeInteractionChannelContext(params: {
  channel: DiscordInteractionChannel | null | undefined;
  client: Client;
  hasGuild: boolean;
  channelIdFallback: string;
}): Promise<DiscordNativeInteractionChannelContext> {
  const { channel } = params;
  const channelType = channel?.type;
  const isDirectMessage = channelType === ChannelType.DM;
  const isGroupDm = channelType === ChannelType.GroupDM;
  const isThreadChannel =
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread;
  const channelName = resolveDiscordChannelNameSafe(channel);
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const rawChannelId = channel?.id ?? params.channelIdFallback;

  let threadParentId: string | undefined;
  let threadParentName: string | undefined;
  let threadParentSlug = "";
  if (params.hasGuild && channel && isThreadChannel && rawChannelId) {
    const channelInfo = await resolveDiscordChannelInfo(params.client, rawChannelId);
    const parentInfo = await resolveDiscordThreadParentInfo({
      client: params.client,
      threadChannel: {
        id: rawChannelId,
        name: channelName,
        parentId: resolveDiscordChannelParentIdSafe(channel),
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
    isDirectMessage,
    isGroupDm,
    isThreadChannel,
    channelName,
    channelSlug,
    rawChannelId,
    threadParentId,
    threadParentName,
    threadParentSlug,
  };
}
