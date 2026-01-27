import type {
  BlockStreamingChunkConfig,
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
  OutboundRetryConfig,
  ReplyToMode,
} from "./types.base.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";
import type { DmConfig, ProviderCommandsConfig } from "./types.messages.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type TelegramActionConfig = {
  reactions?: boolean;
  sendMessage?: boolean;
  deleteMessage?: boolean;
  editMessage?: boolean;
};

export type TelegramNetworkConfig = {
  /** Override Node's autoSelectFamily behavior (true = enable, false = disable). */
  autoSelectFamily?: boolean;
};

export type TelegramInlineButtonsScope = "off" | "dm" | "group" | "all" | "allowlist";

export type TelegramCapabilitiesConfig =
  | string[]
  | {
      inlineButtons?: TelegramInlineButtonsScope;
    };

/** Custom command definition for Telegram bot menu. */
export type TelegramCustomCommand = {
  /** Command name (without leading /). */
  command: string;
  /** Description shown in Telegram command menu. */
  description: string;
};

export type TelegramAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: TelegramCapabilitiesConfig;
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Override native command registration for Telegram (bool or "auto"). */
  commands?: ProviderCommandsConfig;
  /** Custom commands to register in Telegram's command menu (merged with native). */
  customCommands?: TelegramCustomCommand[];
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /**
   * Controls how Telegram direct chats (DMs) are handled:
   * - "pairing" (default): unknown senders get a pairing code; owner must approve
   * - "allowlist": only allow senders in allowFrom (or paired allow store)
   * - "open": allow all inbound DMs (requires allowFrom to include "*")
   * - "disabled": ignore all inbound DMs
   */
  dmPolicy?: DmPolicy;
  /** If false, do not start this Telegram account. Default: true. */
  enabled?: boolean;
  botToken?: string;
  /** Path to file containing bot token (for secret managers like agenix). */
  tokenFile?: string;
  /** Control reply threading when reply tags are present (off|first|all). */
  replyToMode?: ReplyToMode;
  groups?: Record<string, TelegramGroupConfig>;
  allowFrom?: Array<string | number>;
  /** Optional allowlist for Telegram group senders (user ids or usernames). */
  groupAllowFrom?: Array<string | number>;
  /**
   * Controls how group messages are handled:
   * - "open": groups bypass allowFrom, only mention-gating applies
   * - "disabled": block all group messages entirely
   * - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, DmConfig>;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Chunking config for draft streaming in `streamMode: "block"`. */
  draftChunk?: BlockStreamingChunkConfig;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Draft streaming mode for Telegram (off|partial|block). Default: partial. */
  streamMode?: "off" | "partial" | "block";
  mediaMaxMb?: number;
  /** Telegram API client timeout in seconds (grammY ApiClientOptions). */
  timeoutSeconds?: number;
  /** Retry policy for outbound Telegram API calls. */
  retry?: OutboundRetryConfig;
  /** Network transport overrides for Telegram. */
  network?: TelegramNetworkConfig;
  proxy?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
  /** Per-action tool gating (default: true for all). */
  actions?: TelegramActionConfig;
  /**
   * Controls which user reactions trigger notifications:
   * - "off" (default): ignore all reactions
   * - "own": notify when users react to bot messages
   * - "all": notify agent of all reactions
   */
  reactionNotifications?: "off" | "own" | "all";
  /**
   * Controls agent's reaction capability:
   * - "off": agent cannot react
   * - "ack" (default): bot sends acknowledgment reactions (👀 while processing)
   * - "minimal": agent can react sparingly (guideline: 1 per 5-10 exchanges)
   * - "extensive": agent can react liberally when appropriate
   */
  reactionLevel?: "off" | "ack" | "minimal" | "extensive";
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /** Controls whether link previews are shown in outbound messages. Default: true. */
  linkPreview?: boolean;
};

export type TelegramTopicConfig = {
  requireMention?: boolean;
  /** If specified, only load these skills for this topic. Omit = all skills; empty = no skills. */
  skills?: string[];
  /** If false, disable the bot for this topic. */
  enabled?: boolean;
  /** Optional allowlist for topic senders (ids or usernames). */
  allowFrom?: Array<string | number>;
  /** Optional system prompt snippet for this topic. */
  systemPrompt?: string;
};

export type TelegramGroupConfig = {
  requireMention?: boolean;
  /** Optional tool policy overrides for this group. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** If specified, only load these skills for this group (when no topic). Omit = all skills; empty = no skills. */
  skills?: string[];
  /** Per-topic configuration (key is message_thread_id as string) */
  topics?: Record<string, TelegramTopicConfig>;
  /** If false, disable the bot for this group (and its topics). */
  enabled?: boolean;
  /** Optional allowlist for group senders (ids or usernames). */
  allowFrom?: Array<string | number>;
  /** Optional system prompt snippet for this group. */
  systemPrompt?: string;
};

export type TelegramConfig = {
  /** Optional per-account Telegram configuration (multi-account). */
  accounts?: Record<string, TelegramAccountConfig>;
} & TelegramAccountConfig;
