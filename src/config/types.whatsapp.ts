import type { ReactionLevel } from "../utils/reaction-level.js";
import type {
  BlockStreamingCoalesceConfig,
  ContextVisibilityMode,
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
} from "./types.base.js";
import type {
  ChannelHealthMonitorConfig,
  ChannelHeartbeatVisibilityConfig,
} from "./types.channels.js";
import type { DmConfig } from "./types.messages.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type WhatsAppActionConfig = {
  reactions?: boolean;
  sendMessage?: boolean;
  polls?: boolean;
};

export type WhatsAppReactionLevel = ReactionLevel;

export type WhatsAppGroupConfig = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** Optional system prompt for this group. */
  systemPrompt?: string;
};

export type WhatsAppDirectConfig = {
  /** Optional system prompt for this direct chat. */
  systemPrompt?: string;
};

export type WhatsAppAckReactionConfig = {
  /** Emoji to use for acknowledgment (e.g., "👀"). Empty = disabled. */
  emoji?: string;
  /** Send reactions in direct chats. Default: true. */
  direct?: boolean;
  /**
   * Send reactions in group chats:
   * - "always": react to all group messages
   * - "mentions": react only when bot is mentioned
   * - "never": never react in groups
   * Default: "mentions"
   */
  group?: "always" | "mentions" | "never";
};

type WhatsAppSharedConfig = {
  /** Whether the WhatsApp channel is enabled. */
  enabled?: boolean;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Same-phone setup (bot uses your personal WhatsApp number). */
  selfChatMode?: boolean;
  /** Optional allowlist for WhatsApp direct chats (E.164). */
  allowFrom?: string[];
  /** Default delivery target for CLI `--deliver` when no explicit `--reply-to` is provided (E.164 or group JID). */
  defaultTo?: string;
  /** Optional allowlist for WhatsApp group senders (E.164). */
  groupAllowFrom?: string[];
  /**
   * Controls how group messages are handled:
   * - "open": groups bypass allowFrom, only mention-gating applies
   * - "disabled": block all group messages entirely
   * - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Supplemental context visibility policy (all|allowlist|allowlist_quote). */
  contextVisibility?: ContextVisibilityMode;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM history overrides keyed by user ID. */
  dms?: Record<string, DmConfig>;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Maximum media file size in MB. Default: 50. */
  mediaMaxMb?: number;
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  groups?: Record<string, WhatsAppGroupConfig>;
  /** Per-direct-chat prompt overrides keyed by user ID or `*` wildcard. */
  direct?: Record<string, WhatsAppDirectConfig>;
  /** Acknowledgment reaction sent immediately upon message receipt. */
  ackReaction?: WhatsAppAckReactionConfig;
  /**
   * Controls agent reaction behavior:
   * - "off": No reactions
   * - "ack": Only automatic ack reactions
   * - "minimal" (default): Agent can react sparingly
   * - "extensive": Agent can react liberally
   */
  reactionLevel?: WhatsAppReactionLevel;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Heartbeat visibility settings. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /** Channel health monitor overrides for this channel/account. */
  healthMonitor?: ChannelHealthMonitorConfig;
};

type WhatsAppConfigCore = {
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Inbound message prefix override (WhatsApp only). */
  messagePrefix?: string;
  /** Outbound response prefix override. */
  responsePrefix?: string;
};

export type WhatsAppConfig = WhatsAppConfigCore &
  WhatsAppSharedConfig & {
    /** Optional per-account WhatsApp configuration (multi-account). */
    accounts?: Record<string, WhatsAppAccountConfig>;
    /** Optional default account id when multiple accounts are configured. */
    defaultAccount?: string;
    /** Per-action tool gating (default: true for all). */
    actions?: WhatsAppActionConfig;
  };

export type WhatsAppAccountConfig = WhatsAppConfigCore &
  WhatsAppSharedConfig & {
    /** Optional display name for this account (used in CLI/UI lists). */
    name?: string;
    /** If false, do not start this WhatsApp account provider. Default: true. */
    enabled?: boolean;
    /** Override auth directory (Baileys multi-file auth state). */
    authDir?: string;
  };

declare module "./types.channels.js" {
  interface ChannelsConfig {
    whatsapp?: WhatsAppConfig;
  }
}
