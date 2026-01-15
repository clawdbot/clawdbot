import type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
  OutboundRetryConfig,
  ReplyToMode,
} from "./types.base.js";
import type { DmConfig, ProviderCommandsConfig } from "./types.messages.js";

export type DiscordDmConfig = {
  /** If false, ignore all incoming Discord DMs. Default: true. */
  enabled?: boolean;
  /** Direct message access policy (default: pairing). */
  policy?: DmPolicy;
  /** Allowlist for DM senders (ids or names). */
  allowFrom?: Array<string | number>;
  /** If true, allow group DMs (default: false). */
  groupEnabled?: boolean;
  /** Optional allowlist for group DM channels (ids or slugs). */
  groupChannels?: Array<string | number>;
};

export type DiscordGuildChannelConfig = {
  allow?: boolean;
  requireMention?: boolean;
  /** If specified, only load these skills for this channel. Omit = all skills; empty = no skills. */
  skills?: string[];
  /** If false, disable the bot for this channel. */
  enabled?: boolean;
  /** Optional allowlist for channel senders (ids or names). */
  users?: Array<string | number>;
  /** Optional system prompt snippet for this channel. */
  systemPrompt?: string;
};

export type DiscordReactionNotificationMode = "off" | "own" | "all" | "allowlist";

export type DiscordGuildEntry = {
  slug?: string;
  requireMention?: boolean;
  /** Reaction notification mode (off|own|all|allowlist). Default: own. */
  reactionNotifications?: DiscordReactionNotificationMode;
  users?: Array<string | number>;
  channels?: Record<string, DiscordGuildChannelConfig>;
};

export type DiscordActionConfig = {
  reactions?: boolean;
  stickers?: boolean;
  polls?: boolean;
  permissions?: boolean;
  messages?: boolean;
  threads?: boolean;
  pins?: boolean;
  search?: boolean;
  memberInfo?: boolean;
  roleInfo?: boolean;
  roles?: boolean;
  channelInfo?: boolean;
  voiceStatus?: boolean;
  events?: boolean;
  moderation?: boolean;
  emojiUploads?: boolean;
  stickerUploads?: boolean;
  channels?: boolean;
};

export type DiscordAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Override native command registration for Discord (bool or "auto"). */
  commands?: ProviderCommandsConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this Discord account. Default: true. */
  enabled?: boolean;
  token?: string;
  /** Allow bot-authored messages to trigger replies (default: false). */
  allowBots?: boolean;
  /**
   * Controls how guild channel messages are handled:
   * - "open": guild channels bypass allowlists; mention-gating applies
   * - "disabled": block all guild channel messages
   * - "allowlist": only allow channels present in discord.guilds.*.channels
   */
  groupPolicy?: GroupPolicy;
  /** Outbound text chunk size (chars). Default: 2000. */
  textChunkLimit?: number;
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /**
   * Soft max line count per Discord message.
   * Discord clients can clip/collapse very tall messages; splitting by lines
   * keeps replies readable in-channel. Default: 17.
   */
  maxLinesPerMessage?: number;
  mediaMaxMb?: number;
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, DmConfig>;
  /** Retry policy for outbound Discord API calls. */
  retry?: OutboundRetryConfig;
  /** Per-action tool gating (default: true for all). */
  actions?: DiscordActionConfig;
  /** Control reply threading when reply tags are present (off|first|all). */
  replyToMode?: ReplyToMode;
  dm?: DiscordDmConfig;
  /** New per-guild config keyed by guild id or slug. */
  guilds?: Record<string, DiscordGuildEntry>;
};

export type DiscordConfig = {
  /** Optional per-account Discord configuration (multi-account). */
  accounts?: Record<string, DiscordAccountConfig>;
} & DiscordAccountConfig;
