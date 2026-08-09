import type { ChannelType } from "../internal/discord.js";

export type DiscordChannelInfo = {
  type: ChannelType;
  name?: string;
  topic?: string;
  parentId?: string;
  ownerId?: string;
};

export const discordChannelInfoCacheState = {
  entries: new Map<string, { value: DiscordChannelInfo | null; expiresAt: number }>(),
};
