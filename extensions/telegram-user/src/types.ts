import type { DmPolicy, GroupPolicy } from "clawdbot/plugin-sdk";

export type TelegramUserTopicConfig = {
  requireMention?: boolean;
  skills?: string[];
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  systemPrompt?: string;
};

export type TelegramUserGroupConfig = {
  requireMention?: boolean;
  skills?: string[];
  topics?: Record<string, TelegramUserTopicConfig>;
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  systemPrompt?: string;
};

export type TelegramUserAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this Telegram user account. Default: true. */
  enabled?: boolean;
  /** Telegram API ID from my.telegram.org. */
  apiId?: number;
  /** Telegram API hash from my.telegram.org. */
  apiHash?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Allowlist for DM senders (user ids or usernames, or "*"). */
  allowFrom?: Array<string | number>;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Max outbound media size in MB. */
  mediaMaxMb?: number;
  /** Optional allowlist for Telegram group senders (user ids or usernames). */
  groupAllowFrom?: Array<string | number>;
  /** Controls how group messages are handled (open | disabled | allowlist). */
  groupPolicy?: GroupPolicy;
  /** Group-specific overrides (keyed by chat id). */
  groups?: Record<string, TelegramUserGroupConfig>;
};

export type TelegramUserConfig = TelegramUserAccountConfig & {
  accounts?: Record<string, TelegramUserAccountConfig>;
};

export type CoreConfig = {
  channels?: {
    defaults?: {
      groupPolicy?: GroupPolicy;
    };
    "telegram-user"?: TelegramUserConfig;
  };
  commands?: {
    useAccessGroups?: boolean;
  };
  messages?: {
    ackReactionScope?: "off" | "group-mentions" | "group-all" | "direct" | "all";
    removeAckAfterReply?: boolean;
  };
  [key: string]: unknown;
};
