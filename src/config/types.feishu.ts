import type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
  ReplyToMode,
} from "./types.base.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";
import type { DmConfig } from "./types.messages.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type FeishuDmConfig = {
  /** If false, ignore all incoming Feishu DMs. Default: true. */
  enabled?: boolean;
  /** Direct message access policy (default: pairing). */
  policy?: DmPolicy;
  /** Allowlist for DM senders (ids). */
  allowFrom?: Array<string | number>;
};

export type FeishuGroupConfig = {
  /** If false, disable the bot in this chat. (Alias for allow: false.) */
  enabled?: boolean;
  /** Legacy group allow toggle; prefer enabled. */
  allow?: boolean;
  /** Require mentioning the bot to trigger replies. */
  requireMention?: boolean;
  /** Optional tool policy overrides for this chat. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** Allowlist of users that can invoke the bot in this chat. */
  users?: Array<string | number>;
  /** Optional system prompt for this chat. */
  systemPrompt?: string;
};

export type FeishuAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this Feishu account. Default: true. */
  enabled?: boolean;
  /** Feishu app id. */
  appId?: string;
  /** Feishu app secret. */
  appSecret?: string;
  /** Allow bot-authored messages to trigger replies (default: false). */
  allowBots?: boolean;
  /** Default mention requirement for group chats (default: true). */
  requireMention?: boolean;
  /**
   * Controls how group chats are handled:
   * - "open": chats bypass allowlists; mention-gating applies
   * - "disabled": block all group chats
   * - "allowlist": only allow chats present in channels.feishu.groups
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
  /** Merge streamed block replies before sending. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Max media size in MB. */
  mediaMaxMb?: number;
  /** Control reply threading when reply tags are present (off|first|all). */
  replyToMode?: ReplyToMode;
  dm?: FeishuDmConfig;
  groups?: Record<string, FeishuGroupConfig>;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

export type FeishuConfig = {
  /** Optional per-account Feishu configuration (multi-account). */
  accounts?: Record<string, FeishuAccountConfig>;
} & FeishuAccountConfig;
