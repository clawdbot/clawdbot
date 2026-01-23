export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

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
};

export type TelegramUserConfig = TelegramUserAccountConfig & {
  accounts?: Record<string, TelegramUserAccountConfig>;
};

export type CoreConfig = {
  channels?: {
    "telegram-user"?: TelegramUserConfig;
  };
  [key: string]: unknown;
};
