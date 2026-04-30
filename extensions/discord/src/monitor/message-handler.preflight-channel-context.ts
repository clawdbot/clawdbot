import {
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  type DiscordGuildEntryResolved,
} from "./allow-list.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";

export function resolveDiscordPreflightChannelContext(params: {
  isGuildMessage: boolean;
  messageChannelId: string;
  channelName?: string;
  guildName?: string;
  guildInfo: DiscordGuildEntryResolved | null;
  threadChannel: DiscordMessagePreflightContext["threadChannel"];
  threadParentId?: string;
  threadParentName?: string;
}) {
  const threadName = params.threadChannel?.name;
  const configChannelName = params.threadParentName ?? params.channelName;
  const configChannelSlug = configChannelName ? normalizeDiscordSlug(configChannelName) : "";
  const displayChannelName = threadName ?? params.channelName;
  const displayChannelSlug = displayChannelName ? normalizeDiscordSlug(displayChannelName) : "";
  const guildSlug =
    params.guildInfo?.slug || (params.guildName ? normalizeDiscordSlug(params.guildName) : "");

  const threadChannelSlug = params.channelName ? normalizeDiscordSlug(params.channelName) : "";
  const threadParentSlug = params.threadParentName
    ? normalizeDiscordSlug(params.threadParentName)
    : "";

  const channelConfig = params.isGuildMessage
    ? resolveDiscordChannelConfigWithFallback({
        guildInfo: params.guildInfo,
        channelId: params.messageChannelId,
        channelName: params.channelName,
        channelSlug: threadChannelSlug,
        parentId: params.threadParentId,
        parentName: params.threadParentName,
        parentSlug: threadParentSlug,
        scope: params.threadChannel ? "thread" : "channel",
      })
    : null;

  return {
    threadName,
    configChannelName,
    configChannelSlug,
    displayChannelName,
    displayChannelSlug,
    guildSlug,
    threadChannelSlug,
    threadParentSlug,
    channelConfig,
  };
}
