// Defines WhatsApp channel configuration types.
import type { ReactionLevel } from "../utils/reaction-level.js";
import type {
  ChannelReactionConfig,
  ChannelReadReceiptConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type WhatsAppActionConfig = {
  reactions?: boolean;
  sendMessage?: boolean;
  polls?: boolean;
  /** Enable the experimental requester-bound voice-call tool. Default: false. */
  calls?: boolean;
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

type WhatsAppSharedConfig = CommonChannelMessagingConfig<string[], string> &
  ChannelReadReceiptConfig &
  ChannelReactionConfig<never, WhatsAppReactionLevel, WhatsAppAckReactionConfig> & {
    /** Same-phone setup (bot uses your personal WhatsApp number). */
    selfChatMode?: boolean;
    groups?: Record<string, WhatsAppGroupConfig>;
    /** Per-direct-chat prompt overrides keyed by user ID or `*` wildcard. */
    direct?: Record<string, WhatsAppDirectConfig>;
  };

type WhatsAppSpecificConfig = {
  /** @deprecated Doctor-only legacy input. */
  messagePrefix?: string;
};

export type WhatsAppConfig = Omit<WhatsAppSharedConfig, "name"> &
  WhatsAppSpecificConfig & {
    /** Optional per-account WhatsApp configuration (multi-account). */
    accounts?: Record<string, WhatsAppAccountConfig>;
    /** Optional default account id when multiple accounts are configured. */
    defaultAccount?: string;
    /** Per-action tool gating. Calls default to false; existing actions default to true. */
    actions?: WhatsAppActionConfig;
    /** Plugin hook opt-in configuration for privacy-sensitive inbound events. */
    pluginHooks?: {
      /** Enable message_received hooks to broadcast inbound WhatsApp messages to plugins. */
      messageReceived?: boolean;
      /** Enable poll_vote_received hooks to broadcast decoded WhatsApp poll votes to plugins. */
      pollVoteReceived?: boolean;
    };
    /**
     * How long (in milliseconds) poll ownership/decryption state stays
     * durably retained after a poll is created, so a vote arriving after a
     * gateway restart can still be decoded. Default: 600000 (10 minutes).
     */
    pollVoteRetentionMs?: number;
  };

export type WhatsAppAccountConfig = WhatsAppSpecificConfig &
  WhatsAppSharedConfig & {
    /** Optional display name for this account (used in CLI/UI lists). */
    name?: string;
    /** Override auth directory (Baileys multi-file auth state). */
    authDir?: string;
    /** Plugin hook opt-in configuration for privacy-sensitive inbound events. */
    pluginHooks?: {
      /** Enable message_received hooks to broadcast inbound WhatsApp messages to plugins. */
      messageReceived?: boolean;
      /** Enable poll_vote_received hooks to broadcast decoded WhatsApp poll votes to plugins. */
      pollVoteReceived?: boolean;
    };
    /**
     * How long (in milliseconds) poll ownership/decryption state stays
     * durably retained after a poll is created, so a vote arriving after a
     * gateway restart can still be decoded. Overrides the channel-level
     * default. Default: 600000 (10 minutes).
     */
    pollVoteRetentionMs?: number;
  };
