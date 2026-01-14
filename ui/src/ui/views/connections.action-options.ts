import type { DiscordActionForm, SlackActionForm } from "../ui-types";

export const discordActionOptions = [
  { key: "reactions", label: "Reactions" },
  { key: "stickers", label: "Stickers" },
  { key: "polls", label: "Polls" },
  { key: "permissions", label: "Permissions" },
  { key: "messages", label: "Messages" },
  { key: "threads", label: "Threads" },
  { key: "pins", label: "Pins" },
  { key: "search", label: "Search" },
  { key: "memberInfo", label: "Member info" },
  { key: "roleInfo", label: "Role info" },
  { key: "channelInfo", label: "Channel info" },
  { key: "voiceStatus", label: "Voice status" },
  { key: "events", label: "Events" },
  { key: "roles", label: "Role changes" },
  { key: "moderation", label: "Moderation" },
] satisfies Array<{ key: keyof DiscordActionForm; label: string }>;

export const slackActionOptions = [
  { key: "reactions", label: "Reactions" },
  { key: "messages", label: "Messages" },
  { key: "pins", label: "Pins" },
  { key: "memberInfo", label: "Member info" },
  { key: "emojiList", label: "Emoji list" },
] satisfies Array<{ key: keyof SlackActionForm; label: string }>;

