import type { Guild, User } from "@buape/carbon";

export function resolveDiscordSystemLocation(params: {
  isDirectMessage: boolean;
  isGroupDm: boolean;
  guild?: Guild;
  channelName: string;
}) {
  const { isDirectMessage, isGroupDm, guild, channelName } = params;
  if (isDirectMessage) {
    return "DM";
  }
  if (isGroupDm) {
    return `Group DM #${channelName}`;
  }
  return guild?.name ? `${guild.name} #${channelName}` : `#${channelName}`;
}

export function formatDiscordReactionEmoji(emoji: { id?: string | null; name?: string | null }) {
  if (emoji.id && emoji.name) {
    // Custom guild emoji in Discord-renderable form.
    return `<:${emoji.name}:${emoji.id}>`;
  }
  if (emoji.id) {
    // Keep id visible even when name is missing (instead of opaque "emoji").
    return `emoji:${emoji.id}`;
  }
  return emoji.name ?? "emoji";
}

export function formatDiscordUserTag(user: User) {
  const discriminator = (user.discriminator ?? "").trim();
  if (discriminator && discriminator !== "0") {
    return `${user.username}#${discriminator}`;
  }
  return user.username ?? user.id;
}

export function resolveTimestampMs(timestamp?: string | null) {
  if (!timestamp) {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}
