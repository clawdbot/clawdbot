import { ChannelType } from "discord-api-types/v10";

export function isDiscordThreadChannelType(channelType: unknown): boolean {
  return (
    channelType === ChannelType.AnnouncementThread ||
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread
  );
}
