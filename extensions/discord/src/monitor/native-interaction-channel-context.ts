import { ChannelType } from "../internal/discord.js";
import type { DiscordChannelInfoClient } from "./message-utils.js";
import { resolveDiscordThreadLikeChannelContext } from "./thread-channel-context.js";

type DiscordInteractionChannel = {
  id?: string;
  type?: ChannelType;
};

type DiscordNativeInteractionChannelContext = {
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
  client: DiscordChannelInfoClient;
  hasGuild: boolean;
  channelIdFallback: string;
}): Promise<DiscordNativeInteractionChannelContext> {
  const channelContext = await resolveDiscordThreadLikeChannelContext({
    client: params.client,
    channel: params.channel,
    channelIdFallback: params.channelIdFallback,
  });
  const channelType = channelContext.channelType;
  const isDirectMessage = channelType === ChannelType.DM;
  const isGroupDm = channelType === ChannelType.GroupDM;

  return {
    channelType,
    isDirectMessage,
    isGroupDm,
    isThreadChannel: channelContext.isThreadChannel,
    channelName: channelContext.channelName,
    channelSlug: channelContext.channelSlug,
    rawChannelId: channelContext.channelId,
    threadParentId: params.hasGuild ? channelContext.threadParentId : undefined,
    threadParentName: params.hasGuild ? channelContext.threadParentName : undefined,
    threadParentSlug: params.hasGuild ? channelContext.threadParentSlug : "",
  };
}
