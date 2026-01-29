import type { RequestClient } from "@buape/carbon";

import type { RetryConfig } from "../infra/retry.js";

export class DiscordSendError extends Error {
  kind?: "missing-permissions" | "dm-blocked";
  channelId?: string;
  missingPermissions?: string[];

  constructor(message: string, opts?: Partial<DiscordSendError>) {
    super(message);
    this.name = "DiscordSendError";
    if (opts) Object.assign(this, opts);
  }

  override toString() {
    return this.message;
  }
}

export const DISCORD_MAX_EMOJI_BYTES = 256 * 1024;
export const DISCORD_MAX_STICKER_BYTES = 512 * 1024;

export type DiscordSendResult = {
  messageId: string;
  channelId: string;
};

export type DiscordReactOpts = {
  token?: string;
  accountId?: string;
  rest?: RequestClient;
  verbose?: boolean;
  retry?: RetryConfig;
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
  /** Optional message id to start a thread from (for classic threads). */
  messageId?: string;
  /** Thread / forum post title. */
  name: string;
  /** Auto-archive duration in minutes. */
  autoArchiveMinutes?: number;
  /** Optional initial post content (required for forum post creation). */
  content?: string;
  /** Optional forum tag ids (applied tags). */
  appliedTagIds?: string[];
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

export type DiscordChannelEdit = {
  channelId: string;
  name?: string;
  topic?: string;
  position?: number;
  parentId?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number;
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
