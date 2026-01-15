export type ZaloAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this Zalo account. Default: true. */
  enabled?: boolean;
  /** Bot token from Zalo Bot Creator. */
  botToken?: string;
  /** Path to file containing the bot token. */
  tokenFile?: string;
  /** Webhook URL for receiving updates (HTTPS required). */
  webhookUrl?: string;
  /** Webhook secret token (8-256 chars) for request verification. */
  webhookSecret?: string;
  /** Webhook path for the gateway HTTP server (defaults to webhook URL path). */
  webhookPath?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  /** Allowlist for DM senders (Zalo user IDs). */
  allowFrom?: Array<string | number>;
  /** Max inbound media size in MB. */
  mediaMaxMb?: number;
  /** Proxy URL for API requests. */
  proxy?: string;
};

export type ZaloConfig = {
  /** Optional per-account Zalo configuration (multi-account). */
  accounts?: Record<string, ZaloAccountConfig>;
  /** Default account ID when multiple accounts are configured. */
  defaultAccount?: string;
} & ZaloAccountConfig;

export type ZaloTokenSource = "env" | "config" | "configFile" | "none";

export type ResolvedZaloAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  token: string;
  tokenSource: ZaloTokenSource;
  config: ZaloAccountConfig;
};

export type CoreConfig = {
  channels?: {
    zalo?: ZaloConfig;
  };
  [key: string]: unknown;
};
