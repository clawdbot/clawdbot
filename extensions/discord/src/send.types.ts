import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import type { RequestClient } from "./internal/discord.js";

export class DiscordSendError extends Error {
  kind?: "missing-permissions" | "dm-blocked";
  channelId?: string;
  missingPermissions?: string[];
  discordCode?: number;
  status?: number;

  constructor(message: string, opts?: Partial<DiscordSendError>) {
    super(message);
    this.name = "DiscordSendError";
    if (opts) {
      Object.assign(this, opts);
    }
  }

  override toString() {
    return this.message;
  }
}

export const DISCORD_MAX_EMOJI_BYTES = 256 * 1024;
export const DISCORD_MAX_STICKER_BYTES = 512 * 1024;
export const DISCORD_MAX_EVENT_COVER_BYTES = 8 * 1024 * 1024;

export type DiscordSendResult = {
  messageId: string;
  channelId: string;
};

export type DiscordRuntimeAccountContext = {
  cfg: OpenClawConfig;
  accountId: string;
};

export type DiscordReactOpts = {
  cfg: OpenClawConfig;
  accountId?: string;
  token?: string;
  rest?: RequestClient;
  verbose?: boolean;
  retry?: RetryConfig;
};

export type DiscordReactionRuntimeContext = DiscordRuntimeAccountContext & {
  rest: RequestClient;
};

export type DiscordReactionUser = {
  id: string;
  username?: string;
  tag?: string;
};

export type DiscordReactionSummary = {
  emoji: { id?: string | null; name?: string | null; raw: string };
  count: number;
  users: DiscordReactionUser[];
};

export type DiscordPermissionsSummary = {
  channelId: string;
  guildId?: string;
  permissions: string[];
  raw: string;
  isDm: boolean;
  channelType?: number;
};

export type DiscordMessageQuery = {
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
};

export type DiscordMessageEdit = {
  content?: string;
};

export type DiscordThreadCreate = {
  messageId?: string;
  name: string;
  autoArchiveMinutes?: number;
  content?: string;
  /** Discord thread type (default: PublicThread for standalone threads). */
  type?: number;
  /** Tag IDs to apply when creating a forum/media thread (Discord `applied_tags`). */
  appliedTags?: string[];
};

export type DiscordThreadList = {
  guildId: string;
  channelId?: string;
  includeArchived?: boolean;
  before?: string;
  limit?: number;
};

export type DiscordSearchQuery = {
  guildId: string;
  content: string;
  channelIds?: string[];
  authorIds?: string[];
  limit?: number;
};

export type DiscordRoleChange = {
  guildId: string;
  userId: string;
  roleId: string;
};

export type DiscordModerationTarget = {
  guildId: string;
  userId: string;
  reason?: string;
};

export type DiscordTimeoutTarget = DiscordModerationTarget & {
  until?: string;
  durationMinutes?: number;
};

export type DiscordEmojiUpload = {
  guildId: string;
  name: string;
  mediaUrl: string;
  roleIds?: string[];
};

export type DiscordStickerUpload = {
  guildId: string;
  name: string;
  description: string;
  tags: string;
  mediaUrl: string;
};

export type DiscordChannelCreate = {
  guildId: string;
  name: string;
  type?: number;
  parentId?: string;
  topic?: string;
  position?: number;
  nsfw?: boolean;
};

type DiscordForumTag = {
  id?: string;
  name: string;
  moderated?: boolean;
  emoji_id?: string | null;
  emoji_name?: string | null;
};

export type DiscordChannelEdit = {
  channelId: string;
  name?: string;
  topic?: string;
  position?: number;
  parentId?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number;
  archived?: boolean;
  locked?: boolean;
  autoArchiveDuration?: number;
  availableTags?: DiscordForumTag[];
};

export type DiscordChannelMove = {
  guildId: string;
  channelId: string;
  parentId?: string | null;
  position?: number;
};

export type DiscordChannelPermissionSet = {
  channelId: string;
  targetId: string;
  targetType: 0 | 1;
  allow?: string;
  deny?: string;
};
