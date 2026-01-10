export type ReplyMode = "text" | "command";
export type TypingMode = "never" | "instant" | "thinking" | "message";
export type SessionScope = "per-sender" | "global";
export type ReplyToMode = "off" | "first" | "all";
export type GroupPolicy = "open" | "disabled" | "allowlist";
export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export type OutboundRetryConfig = {
  /** Max retry attempts for outbound requests (default: 3). */
  attempts?: number;
  /** Minimum retry delay in ms (default: 300-500ms depending on provider). */
  minDelayMs?: number;
  /** Maximum retry delay cap in ms (default: 30000). */
  maxDelayMs?: number;
  /** Jitter factor (0-1) applied to delays (default: 0.1). */
  jitter?: number;
};

export type BlockStreamingCoalesceConfig = {
  minChars?: number;
  maxChars?: number;
  idleMs?: number;
};

export type BlockStreamingChunkConfig = {
  minChars?: number;
  maxChars?: number;
  breakPreference?: "paragraph" | "newline" | "sentence";
};

export type HumanDelayConfig = {
  /** Delay style for block replies (off|natural|custom). */
  mode?: "off" | "natural" | "custom";
  /** Minimum delay in milliseconds (default: 800). */
  minMs?: number;
  /** Maximum delay in milliseconds (default: 2500). */
  maxMs?: number;
};

export type SessionSendPolicyAction = "allow" | "deny";
export type SessionSendPolicyMatch = {
  provider?: string;
  chatType?: "direct" | "group" | "room";
  keyPrefix?: string;
};
export type SessionSendPolicyRule = {
  action: SessionSendPolicyAction;
  match?: SessionSendPolicyMatch;
};
export type SessionSendPolicyConfig = {
  default?: SessionSendPolicyAction;
  rules?: SessionSendPolicyRule[];
};

export type SessionConfig = {
  scope?: SessionScope;
  resetTriggers?: string[];
  idleMinutes?: number;
  heartbeatIdleMinutes?: number;
  store?: string;
  typingIntervalSeconds?: number;
  typingMode?: TypingMode;
  mainKey?: string;
  sendPolicy?: SessionSendPolicyConfig;
  agentToAgent?: {
    /** Max ping-pong turns between requester/target (0–5). Default: 5. */
    maxPingPongTurns?: number;
  };
};

export type LoggingConfig = {
  level?: "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  file?: string;
  consoleLevel?:
    | "silent"
    | "fatal"
    | "error"
    | "warn"
    | "info"
    | "debug"
    | "trace";
  consoleStyle?: "pretty" | "compact" | "json";
  /** Redact sensitive tokens in tool summaries. Default: "tools". */
  redactSensitive?: "off" | "tools";
  /** Regex patterns used to redact sensitive tokens (defaults apply when unset). */
  redactPatterns?: string[];
};

export type WebReconnectConfig = {
  initialMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: number;
  maxAttempts?: number; // 0 = unlimited
};

export type WebConfig = {
  /** If false, do not start the WhatsApp web provider. Default: true. */
  enabled?: boolean;
  heartbeatSeconds?: number;
  reconnect?: WebReconnectConfig;
};

// Provider docking: allowlists keyed by provider id (and internal "webchat").
export type AgentElevatedAllowFromConfig = Partial<
  Record<string, Array<string | number>>
>;

export type IdentityConfig = {
  name?: string;
  theme?: string;
  emoji?: string;
};

export type WhatsAppActionConfig = {
  reactions?: boolean;
  sendMessage?: boolean;
  polls?: boolean;
};

export type WhatsAppConfig = {
  /** Optional per-account WhatsApp configuration (multi-account). */
  accounts?: Record<string, WhatsAppAccountConfig>;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /**
   * Inbound message prefix (WhatsApp only).
   * Default: `[{agents.list[].identity.name}]` (or `[clawdbot]`) when allowFrom is empty, else `""`.
   */
  messagePrefix?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /**
   * Same-phone setup (bot uses your personal WhatsApp number).
   */
  selfChatMode?: boolean;
  /** Optional allowlist for WhatsApp direct chats (E.164). */
  allowFrom?: string[];
  /** Optional allowlist for WhatsApp group senders (E.164). */
  groupAllowFrom?: string[];
  /**
   * Controls how group messages are handled:
   * - "open" (default): groups bypass allowFrom, only mention-gating applies
   * - "disabled": block all group messages entirely
   * - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Maximum media file size in MB. Default: 50. */
  mediaMaxMb?: number;
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Per-action tool gating (default: true for all). */
  actions?: WhatsAppActionConfig;
  groups?: Record<
    string,
    {
      requireMention?: boolean;
    }
  >;
  /** Acknowledgment reaction sent immediately upon message receipt. */
  ackReaction?: {
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
};

export type WhatsAppAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** If false, do not start this WhatsApp account provider. Default: true. */
  enabled?: boolean;
  /** Inbound message prefix override for this account (WhatsApp only). */
  messagePrefix?: string;
  /** Override auth directory (Baileys multi-file auth state). */
  authDir?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Same-phone setup for this account (bot uses your personal WhatsApp number). */
  selfChatMode?: boolean;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  groupPolicy?: GroupPolicy;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  textChunkLimit?: number;
  mediaMaxMb?: number;
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  groups?: Record<
    string,
    {
      requireMention?: boolean;
    }
  >;
  /** Acknowledgment reaction sent immediately upon message receipt. */
  ackReaction?: {
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
};

export type BrowserProfileConfig = {
  /** CDP port for this profile. Allocated once at creation, persisted permanently. */
  cdpPort?: number;
  /** CDP URL for this profile (use for remote Chrome). */
  cdpUrl?: string;
  /** Profile color (hex). Auto-assigned at creation. */
  color: string;
};
export type BrowserConfig = {
  enabled?: boolean;
  /** Base URL of the clawd browser control server. Default: http://127.0.0.1:18791 */
  controlUrl?: string;
  /** Base URL of the CDP endpoint. Default: controlUrl with port + 1. */
  cdpUrl?: string;
  /** Accent color for the clawd browser profile (hex). Default: #FF4500 */
  color?: string;
  /** Override the browser executable path (macOS/Linux). */
  executablePath?: string;
  /** Start Chrome headless (best-effort). Default: false */
  headless?: boolean;
  /** Pass --no-sandbox to Chrome (Linux containers). Default: false */
  noSandbox?: boolean;
  /** If true: never launch; only attach to an existing browser. Default: false */
  attachOnly?: boolean;
  /** Default profile to use when profile param is omitted. Default: "clawd" */
  defaultProfile?: string;
  /** Named browser profiles with explicit CDP ports or URLs. */
  profiles?: Record<string, BrowserProfileConfig>;
};

export type CronConfig = {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
};

export type HookMappingMatch = {
  path?: string;
  source?: string;
};

export type HookMappingTransform = {
  module: string;
  export?: string;
};

export type HookMappingConfig = {
  id?: string;
  match?: HookMappingMatch;
  action?: "wake" | "agent";
  wakeMode?: "now" | "next-heartbeat";
  name?: string;
  sessionKey?: string;
  messageTemplate?: string;
  textTemplate?: string;
  deliver?: boolean;
  provider?:
    | "last"
    | "whatsapp"
    | "telegram"
    | "discord"
    | "slack"
    | "signal"
    | "imessage"
    | "msteams";
  to?: string;
  /** Override model for this hook (provider/model or alias). */
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  transform?: HookMappingTransform;
};

export type HooksGmailTailscaleMode = "off" | "serve" | "funnel";

export type HooksGmailConfig = {
  account?: string;
  label?: string;
  topic?: string;
  subscription?: string;
  pushToken?: string;
  hookUrl?: string;
  includeBody?: boolean;
  maxBytes?: number;
  renewEveryMinutes?: number;
  serve?: {
    bind?: string;
    port?: number;
    path?: string;
  };
  tailscale?: {
    mode?: HooksGmailTailscaleMode;
    path?: string;
    /** Optional tailscale serve/funnel target (port, host:port, or full URL). */
    target?: string;
  };
  /** Optional model override for Gmail hook processing (provider/model or alias). */
  model?: string;
  /** Optional thinking level override for Gmail hook processing. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
};

export type HooksConfig = {
  enabled?: boolean;
  path?: string;
  token?: string;
  maxBodyBytes?: number;
  presets?: string[];
  transformsDir?: string;
  mappings?: HookMappingConfig[];
  gmail?: HooksGmailConfig;
};

export type TelegramActionConfig = {
  reactions?: boolean;
  sendMessage?: boolean;
};

export type TelegramAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
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
   * - "open" (default): groups bypass allowFrom, only mention-gating applies
   * - "disabled": block all group messages entirely
   * - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Chunking config for draft streaming in `streamMode: "block"`. */
  draftChunk?: BlockStreamingChunkConfig;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Draft streaming mode for Telegram (off|partial|block). Default: partial. */
  streamMode?: "off" | "partial" | "block";
  mediaMaxMb?: number;
  /** Retry policy for outbound Telegram API calls. */
  retry?: OutboundRetryConfig;
  proxy?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
  /** Per-action tool gating (default: true for all). */
  actions?: TelegramActionConfig;
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

export type DiscordReactionNotificationMode =
  | "off"
  | "own"
  | "all"
  | "allowlist";

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
  /** If false, do not start this Discord account. Default: true. */
  enabled?: boolean;
  token?: string;
  /**
   * Controls how guild channel messages are handled:
   * - "open" (default): guild channels bypass allowlists; mention-gating applies
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

export type SlackDmConfig = {
  /** If false, ignore all incoming Slack DMs. Default: true. */
  enabled?: boolean;
  /** Direct message access policy (default: pairing). */
  policy?: DmPolicy;
  /** Allowlist for DM senders (ids). */
  allowFrom?: Array<string | number>;
  /** If true, allow group DMs (default: false). */
  groupEnabled?: boolean;
  /** Optional allowlist for group DM channels (ids or slugs). */
  groupChannels?: Array<string | number>;
};

export type SlackChannelConfig = {
  /** If false, disable the bot in this channel. (Alias for allow: false.) */
  enabled?: boolean;
  /** Legacy channel allow toggle; prefer enabled. */
  allow?: boolean;
  /** Require mentioning the bot to trigger replies. */
  requireMention?: boolean;
  /** Allow bot-authored messages to trigger replies (default: false). */
  allowBots?: boolean;
  /** Allowlist of users that can invoke the bot in this channel. */
  users?: Array<string | number>;
  /** Optional skill filter for this channel. */
  skills?: string[];
  /** Optional system prompt for this channel. */
  systemPrompt?: string;
};

export type SignalReactionNotificationMode =
  | "off"
  | "own"
  | "all"
  | "allowlist";

export type SlackReactionNotificationMode = "off" | "own" | "all" | "allowlist";

export type SlackActionConfig = {
  reactions?: boolean;
  messages?: boolean;
  pins?: boolean;
  search?: boolean;
  permissions?: boolean;
  memberInfo?: boolean;
  channelInfo?: boolean;
  emojiList?: boolean;
};

export type SlackSlashCommandConfig = {
  /** Enable handling for the configured slash command (default: false). */
  enabled?: boolean;
  /** Slash command name (default: "clawd"). */
  name?: string;
  /** Session key prefix for slash commands (default: "slack:slash"). */
  sessionPrefix?: string;
  /** Reply ephemerally (default: true). */
  ephemeral?: boolean;
};

export type SlackAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** If false, do not start this Slack account. Default: true. */
  enabled?: boolean;
  botToken?: string;
  appToken?: string;
  /** Allow bot-authored messages to trigger replies (default: false). */
  allowBots?: boolean;
  /**
   * Controls how channel messages are handled:
   * - "open" (default): channels bypass allowlists; mention-gating applies
   * - "disabled": block all channel messages
   * - "allowlist": only allow channels present in slack.channels
   */
  groupPolicy?: GroupPolicy;
  /** Max channel messages to keep as history context (0 disables). */
  historyLimit?: number;
  textChunkLimit?: number;
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  mediaMaxMb?: number;
  /** Reaction notification mode (off|own|all|allowlist). Default: own. */
  reactionNotifications?: SlackReactionNotificationMode;
  /** Allowlist for reaction notifications when mode is allowlist. */
  reactionAllowlist?: Array<string | number>;
  /** Control reply threading when reply tags are present (off|first|all). */
  replyToMode?: ReplyToMode;
  actions?: SlackActionConfig;
  slashCommand?: SlackSlashCommandConfig;
  dm?: SlackDmConfig;
  channels?: Record<string, SlackChannelConfig>;
};

export type SlackConfig = {
  /** Optional per-account Slack configuration (multi-account). */
  accounts?: Record<string, SlackAccountConfig>;
} & SlackAccountConfig;

export type SignalAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** If false, do not start this Signal account. Default: true. */
  enabled?: boolean;
  /** Optional explicit E.164 account for signal-cli. */
  account?: string;
  /** Optional full base URL for signal-cli HTTP daemon. */
  httpUrl?: string;
  /** HTTP host for signal-cli daemon (default 127.0.0.1). */
  httpHost?: string;
  /** HTTP port for signal-cli daemon (default 8080). */
  httpPort?: number;
  /** signal-cli binary path (default: signal-cli). */
  cliPath?: string;
  /** Auto-start signal-cli daemon (default: true if httpUrl not set). */
  autoStart?: boolean;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  /** Optional allowlist for Signal group senders (E.164). */
  groupAllowFrom?: Array<string | number>;
  /**
   * Controls how group messages are handled:
   * - "open" (default): groups bypass allowFrom, no extra gating
   * - "disabled": block all group messages
   * - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  mediaMaxMb?: number;
  /** Reaction notification mode (off|own|all|allowlist). Default: own. */
  reactionNotifications?: SignalReactionNotificationMode;
  /** Allowlist for reaction notifications when mode is allowlist. */
  reactionAllowlist?: Array<string | number>;
};

export type SignalConfig = {
  /** Optional per-account Signal configuration (multi-account). */
  accounts?: Record<string, SignalAccountConfig>;
} & SignalAccountConfig;

export type MSTeamsWebhookConfig = {
  /** Port for the webhook server. Default: 3978. */
  port?: number;
  /** Path for the messages endpoint. Default: /api/messages. */
  path?: string;
};

/** Reply style for MS Teams messages. */
export type MSTeamsReplyStyle = "thread" | "top-level";

/** Channel-level config for MS Teams. */
export type MSTeamsChannelConfig = {
  /** Require @mention to respond. Default: true. */
  requireMention?: boolean;
  /** Reply style: "thread" replies to the message, "top-level" posts a new message. */
  replyStyle?: MSTeamsReplyStyle;
};

/** Team-level config for MS Teams. */
export type MSTeamsTeamConfig = {
  /** Default requireMention for channels in this team. */
  requireMention?: boolean;
  /** Default reply style for channels in this team. */
  replyStyle?: MSTeamsReplyStyle;
  /** Per-channel overrides. Key is conversation ID (e.g., "19:...@thread.tacv2"). */
  channels?: Record<string, MSTeamsChannelConfig>;
};

export type MSTeamsConfig = {
  /** If false, do not start the MS Teams provider. Default: true. */
  enabled?: boolean;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Azure Bot App ID (from Azure Bot registration). */
  appId?: string;
  /** Azure Bot App Password / Client Secret. */
  appPassword?: string;
  /** Azure AD Tenant ID (for single-tenant bots). */
  tenantId?: string;
  /** Webhook server configuration. */
  webhook?: MSTeamsWebhookConfig;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Allowlist for DM senders (AAD object IDs or UPNs). */
  allowFrom?: Array<string>;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /**
   * Allowed host suffixes for inbound attachment downloads.
   * Use ["*"] to allow any host (not recommended).
   */
  mediaAllowHosts?: Array<string>;
  /** Default: require @mention to respond in channels/groups. */
  requireMention?: boolean;
  /** Max group/channel messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Default reply style: "thread" replies to the message, "top-level" posts a new message. */
  replyStyle?: MSTeamsReplyStyle;
  /** Per-team config. Key is team ID (from the /team/ URL path segment). */
  teams?: Record<string, MSTeamsTeamConfig>;
};

export type IMessageAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** If false, do not start this iMessage account. Default: true. */
  enabled?: boolean;
  /** imsg CLI binary path (default: imsg). */
  cliPath?: string;
  /** Optional Messages db path override. */
  dbPath?: string;
  /** Optional default send service (imessage|sms|auto). */
  service?: "imessage" | "sms" | "auto";
  /** Optional default region (used when sending SMS). */
  region?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Optional allowlist for inbound handles or chat_id targets. */
  allowFrom?: Array<string | number>;
  /** Optional allowlist for group senders or chat_id targets. */
  groupAllowFrom?: Array<string | number>;
  /**
   * Controls how group messages are handled:
   * - "open" (default): groups bypass allowFrom; mention-gating applies
   * - "disabled": block all group messages entirely
   * - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Include attachments + reactions in watch payloads. */
  includeAttachments?: boolean;
  /** Max outbound media size in MB. */
  mediaMaxMb?: number;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  groups?: Record<
    string,
    {
      requireMention?: boolean;
    }
  >;
};

export type IMessageConfig = {
  /** Optional per-account iMessage configuration (multi-account). */
  accounts?: Record<string, IMessageAccountConfig>;
} & IMessageAccountConfig;

export type QueueMode =
  | "steer"
  | "followup"
  | "collect"
  | "steer-backlog"
  | "steer+backlog"
  | "queue"
  | "interrupt";
export type QueueDropPolicy = "old" | "new" | "summarize";

export type QueueModeByProvider = {
  whatsapp?: QueueMode;
  telegram?: QueueMode;
  discord?: QueueMode;
  slack?: QueueMode;
  signal?: QueueMode;
  imessage?: QueueMode;
  msteams?: QueueMode;
  webchat?: QueueMode;
};

export type SandboxDockerSettings = {
  /** Docker image to use for sandbox containers. */
  image?: string;
  /** Prefix for sandbox container names. */
  containerPrefix?: string;
  /** Container workdir mount path (default: /workspace). */
  workdir?: string;
  /** Run container rootfs read-only. */
  readOnlyRoot?: boolean;
  /** Extra tmpfs mounts for read-only containers. */
  tmpfs?: string[];
  /** Container network mode (bridge|none|custom). */
  network?: string;
  /** Container user (uid:gid). */
  user?: string;
  /** Drop Linux capabilities. */
  capDrop?: string[];
  /** Extra environment variables for sandbox exec. */
  env?: Record<string, string>;
  /** Optional setup command run once after container creation. */
  setupCommand?: string;
  /** Limit container PIDs (0 = Docker default). */
  pidsLimit?: number;
  /** Limit container memory (e.g. 512m, 2g, or bytes as number). */
  memory?: string | number;
  /** Limit container memory swap (same format as memory). */
  memorySwap?: string | number;
  /** Limit container CPU shares (e.g. 0.5, 1, 2). */
  cpus?: number;
  /**
   * Set ulimit values by name (e.g. nofile, nproc).
   * Use "soft:hard" string, a number, or { soft, hard }.
   */
  ulimits?: Record<string, string | number | { soft?: number; hard?: number }>;
  /** Seccomp profile (path or profile name). */
  seccompProfile?: string;
  /** AppArmor profile name. */
  apparmorProfile?: string;
  /** DNS servers (e.g. ["1.1.1.1", "8.8.8.8"]). */
  dns?: string[];
  /** Extra host mappings (e.g. ["api.local:10.0.0.2"]). */
  extraHosts?: string[];
};

export type SandboxBrowserSettings = {
  enabled?: boolean;
  image?: string;
  containerPrefix?: string;
  cdpPort?: number;
  vncPort?: number;
  noVncPort?: number;
  headless?: boolean;
  enableNoVnc?: boolean;
  /**
   * Allow sandboxed sessions to target the host browser control server.
   * Default: false.
   */
  allowHostControl?: boolean;
  /**
   * Allowlist of exact control URLs for target="custom".
   * When set, any custom controlUrl must match this list.
   */
  allowedControlUrls?: string[];
  /**
   * Allowlist of hostnames for control URLs (hostname only, no ports).
   * When set, controlUrl hostname must match.
   */
  allowedControlHosts?: string[];
  /**
   * Allowlist of ports for control URLs.
   * When set, controlUrl port must match (defaults: http=80, https=443).
   */
  allowedControlPorts?: number[];
  /**
   * When true (default), sandboxed browser control will try to start/reattach to
   * the sandbox browser container when a tool call needs it.
   */
  autoStart?: boolean;
  /** Max time to wait for CDP to become reachable after auto-start (ms). */
  autoStartTimeoutMs?: number;
};

export type SandboxPruneSettings = {
  /** Prune if idle for more than N hours (0 disables). */
  idleHours?: number;
  /** Prune if older than N days (0 disables). */
  maxAgeDays?: number;
};

export type GroupChatConfig = {
  mentionPatterns?: string[];
  historyLimit?: number;
};

export type QueueConfig = {
  mode?: QueueMode;
  byProvider?: QueueModeByProvider;
  debounceMs?: number;
  cap?: number;
  drop?: QueueDropPolicy;
};

export type AgentToolsConfig = {
  allow?: string[];
  deny?: string[];
  /** Per-agent elevated bash gate (can only further restrict global tools.elevated). */
  elevated?: {
    /** Enable or disable elevated mode for this agent (default: true). */
    enabled?: boolean;
    /** Approved senders for /elevated (per-provider allowlists). */
    allowFrom?: AgentElevatedAllowFromConfig;
  };
  sandbox?: {
    tools?: {
      allow?: string[];
      deny?: string[];
    };
  };
};

export type ToolsConfig = {
  allow?: string[];
  deny?: string[];
  audio?: {
    transcription?: {
      /** CLI args (template-enabled). */
      args?: string[];
      timeoutSeconds?: number;
    };
  };
  agentToAgent?: {
    /** Enable agent-to-agent messaging tools. Default: false. */
    enabled?: boolean;
    /** Allowlist of agent ids or patterns (implementation-defined). */
    allow?: string[];
  };
  /** Elevated bash permissions for the host machine. */
  elevated?: {
    /** Enable or disable elevated mode (default: true). */
    enabled?: boolean;
    /** Approved senders for /elevated (per-provider allowlists). */
    allowFrom?: AgentElevatedAllowFromConfig;
  };
  /** Bash tool defaults. */
  bash?: {
    /** Default time (ms) before a bash command auto-backgrounds. */
    backgroundMs?: number;
    /** Default timeout (seconds) before auto-killing bash commands. */
    timeoutSec?: number;
    /** How long to keep finished sessions in memory (ms). */
    cleanupMs?: number;
  };
  /** Sub-agent tool policy defaults (deny wins). */
  subagents?: {
    tools?: {
      allow?: string[];
      deny?: string[];
    };
  };
  /** Sandbox tool policy defaults (deny wins). */
  sandbox?: {
    tools?: {
      allow?: string[];
      deny?: string[];
    };
  };
};

export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: string;
  /** Human-like delay between block replies for this agent. */
  humanDelay?: HumanDelayConfig;
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  subagents?: {
    /** Allow spawning sub-agents under other agent ids. Use "*" to allow any. */
    allowAgents?: string[];
  };
  sandbox?: {
    mode?: "off" | "non-main" | "all";
    /** Agent workspace access inside the sandbox. */
    workspaceAccess?: "none" | "ro" | "rw";
    /**
     * Session tools visibility for sandboxed sessions.
     * - "spawned": only allow session tools to target sessions spawned from this session (default)
     * - "all": allow session tools to target any session
     */
    sessionToolsVisibility?: "spawned" | "all";
    /** Container/workspace scope for sandbox isolation. */
    scope?: "session" | "agent" | "shared";
    /** Legacy alias for scope ("session" when true, "shared" when false). */
    perSession?: boolean;
    workspaceRoot?: string;
    /** Docker-specific sandbox overrides for this agent. */
    docker?: SandboxDockerSettings;
    /** Optional sandboxed browser overrides for this agent. */
    browser?: SandboxBrowserSettings;
    /** Auto-prune overrides for this agent. */
    prune?: SandboxPruneSettings;
  };
  tools?: AgentToolsConfig;
};

export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
};

export type AgentBinding = {
  agentId: string;
  match: {
    provider: string;
    accountId?: string;
    peer?: { kind: "dm" | "group" | "channel"; id: string };
    guildId?: string;
    teamId?: string;
  };
};

export type BroadcastStrategy = "parallel" | "sequential";

export type BroadcastConfig = {
  /** Default processing strategy for broadcast peers. */
  strategy?: BroadcastStrategy;
  /**
   * Map peer IDs to arrays of agent IDs that should ALL process messages.
   *
   * Note: the index signature includes `undefined` so `strategy?: ...` remains type-safe.
   */
  [peerId: string]: string[] | BroadcastStrategy | undefined;
};

export type AudioConfig = {
  /** @deprecated Use tools.audio.transcription instead. */
  transcription?: {
    // Optional CLI to turn inbound audio into text; templated args, must output transcript to stdout.
    command: string[];
    timeoutSeconds?: number;
  };
};

export type MessagesConfig = {
  /** @deprecated Use `whatsapp.messagePrefix` (WhatsApp-only inbound prefix). */
  messagePrefix?: string;
  /**
   * Prefix auto-added to all outbound replies.
   * - string: explicit prefix
   * - special value: `"auto"` derives `[{agents.list[].identity.name}]` for the routed agent (when set)
   * Default: none
   */
  responsePrefix?: string;
  groupChat?: GroupChatConfig;
  queue?: QueueConfig;
  /** Emoji reaction used to acknowledge inbound messages (empty disables). */
  ackReaction?: string;
  /** When to send ack reactions. Default: "group-mentions". */
  ackReactionScope?: "group-mentions" | "group-all" | "direct" | "all";
  /** Remove ack reaction after reply is sent (default: false). */
  removeAckAfterReply?: boolean;
};

export type CommandsConfig = {
  /** Enable native command registration when supported (default: false). */
  native?: boolean;
  /** Enable text command parsing (default: true). */
  text?: boolean;
  /** Allow /config command (default: false). */
  config?: boolean;
  /** Allow /debug command (default: false). */
  debug?: boolean;
  /** Allow restart commands/tools (default: false). */
  restart?: boolean;
  /** Enforce access-group allowlists/policies for commands (default: true). */
  useAccessGroups?: boolean;
};

export type BridgeBindMode = "auto" | "lan" | "tailnet" | "loopback";

export type BridgeConfig = {
  enabled?: boolean;
  port?: number;
  /**
   * Bind address policy for the node bridge server.
   * - auto: prefer tailnet IP when present, else LAN (0.0.0.0)
   * - lan:  0.0.0.0 (reachable on local network + any forwarded interfaces)
   * - tailnet: bind to the Tailscale interface IP (100.64.0.0/10) plus loopback
   * - loopback: 127.0.0.1
   */
  bind?: BridgeBindMode;
};

export type WideAreaDiscoveryConfig = {
  enabled?: boolean;
};

export type DiscoveryConfig = {
  wideArea?: WideAreaDiscoveryConfig;
};

export type CanvasHostConfig = {
  enabled?: boolean;
  /** Directory to serve (default: ~/clawd/canvas). */
  root?: string;
  /** HTTP port to listen on (default: 18793). */
  port?: number;
  /** Enable live-reload file watching + WS reloads (default: true). */
  liveReload?: boolean;
};

export type TalkConfig = {
  /** Default ElevenLabs voice ID for Talk mode. */
  voiceId?: string;
  /** Optional voice name -> ElevenLabs voice ID map. */
  voiceAliases?: Record<string, string>;
  /** Default ElevenLabs model ID for Talk mode. */
  modelId?: string;
  /** Default ElevenLabs output format (e.g. mp3_44100_128). */
  outputFormat?: string;
  /** ElevenLabs API key (optional; falls back to ELEVENLABS_API_KEY). */
  apiKey?: string;
  /** Stop speaking when user starts talking (default: true). */
  interruptOnSpeech?: boolean;
};

export type GatewayControlUiConfig = {
  /** If false, the Gateway will not serve the Control UI (default /). */
  enabled?: boolean;
  /** Optional base path prefix for the Control UI (e.g. "/clawdbot"). */
  basePath?: string;
};

export type GatewayAuthMode = "token" | "password";

export type GatewayAuthConfig = {
  /** Authentication mode for Gateway connections. Defaults to token when set. */
  mode?: GatewayAuthMode;
  /** Shared token for token mode (stored locally for CLI auth). */
  token?: string;
  /** Shared password for password mode (consider env instead). */
  password?: string;
  /** Allow Tailscale identity headers when serve mode is enabled. */
  allowTailscale?: boolean;
};

export type GatewayTailscaleMode = "off" | "serve" | "funnel";

export type GatewayTailscaleConfig = {
  /** Tailscale exposure mode for the Gateway control UI. */
  mode?: GatewayTailscaleMode;
  /** Reset serve/funnel configuration on shutdown. */
  resetOnExit?: boolean;
};

export type GatewayRemoteConfig = {
  /** Remote Gateway WebSocket URL (ws:// or wss://). */
  url?: string;
  /** Token for remote auth (when the gateway requires token auth). */
  token?: string;
  /** Password for remote auth (when the gateway requires password auth). */
  password?: string;
  /** SSH target for tunneling remote Gateway (user@host). */
  sshTarget?: string;
  /** SSH identity file path for tunneling remote Gateway. */
  sshIdentity?: string;
};

export type GatewayReloadMode = "off" | "restart" | "hot" | "hybrid";

export type GatewayReloadConfig = {
  /** Reload strategy for config changes (default: hybrid). */
  mode?: GatewayReloadMode;
  /** Debounce window for config reloads (ms). Default: 300. */
  debounceMs?: number;
};

export type GatewayHttpChatCompletionsConfig = {
  /**
   * If false, the Gateway will not serve `POST /v1/chat/completions`.
   * Default: false when absent.
   */
  enabled?: boolean;
};

export type GatewayHttpEndpointsConfig = {
  chatCompletions?: GatewayHttpChatCompletionsConfig;
};

export type GatewayHttpConfig = {
  endpoints?: GatewayHttpEndpointsConfig;
};

export type GatewayConfig = {
  /** Single multiplexed port for Gateway WS + HTTP (default: 18789). */
  port?: number;
  /**
   * Explicit gateway mode. When set to "remote", local gateway start is disabled.
   * When set to "local", the CLI may start the gateway locally.
   */
  mode?: "local" | "remote";
  /**
   * Bind address policy for the Gateway WebSocket + Control UI HTTP server.
   * Default: loopback (127.0.0.1).
   */
  bind?: BridgeBindMode;
  controlUi?: GatewayControlUiConfig;
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
  remote?: GatewayRemoteConfig;
  reload?: GatewayReloadConfig;
  http?: GatewayHttpConfig;
};

export type SkillConfig = {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
};

export type SkillsLoadConfig = {
  /**
   * Additional skill folders to scan (lowest precedence).
   * Each directory should contain skill subfolders with `SKILL.md`.
   */
  extraDirs?: string[];
};

export type SkillsInstallConfig = {
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "yarn" | "bun";
};

export type SkillsConfig = {
  /** Optional bundled-skill allowlist (only affects bundled skills). */
  allowBundled?: string[];
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  entries?: Record<string, SkillConfig>;
};

export type ModelApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type ModelCompatConfig = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
};

export type ModelDefinitionConfig = {
  id: string;
  name: string;
  api?: ModelApi;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ModelCompatConfig;
};

export type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: string;
  api?: ModelApi;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: ModelDefinitionConfig[];
};

export type ModelsConfig = {
  mode?: "merge" | "replace";
  providers?: Record<string, ModelProviderConfig>;
};

export type AuthProfileConfig = {
  provider: string;
  /**
   * Credential type expected in auth-profiles.json for this profile id.
   * - api_key: static provider API key
   * - oauth: refreshable OAuth credentials (access+refresh+expires)
   * - token: static bearer-style token (optionally expiring; no refresh)
   */
  mode: "api_key" | "oauth" | "token";
  email?: string;
};

export type AuthConfig = {
  profiles?: Record<string, AuthProfileConfig>;
  order?: Record<string, string[]>;
  cooldowns?: {
    /** Default billing backoff (hours). Default: 5. */
    billingBackoffHours?: number;
    /** Optional per-provider billing backoff (hours). */
    billingBackoffHoursByProvider?: Record<string, number>;
    /** Billing backoff cap (hours). Default: 24. */
    billingMaxHours?: number;
    /**
     * Failure window for backoff counters (hours). If no failures occur within
     * this window, counters reset. Default: 24.
     */
    failureWindowHours?: number;
  };
};

export type AgentModelEntryConfig = {
  alias?: string;
  /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
  params?: Record<string, unknown>;
};

export type AgentModelListConfig = {
  primary?: string;
  fallbacks?: string[];
};

export type AgentContextPruningConfig = {
  mode?: "off" | "adaptive" | "aggressive";
  keepLastAssistants?: number;
  softTrimRatio?: number;
  hardClearRatio?: number;
  minPrunableToolChars?: number;
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  softTrim?: {
    maxChars?: number;
    headChars?: number;
    tailChars?: number;
  };
  hardClear?: {
    enabled?: boolean;
    placeholder?: string;
  };
};

export type CliBackendConfig = {
  /** CLI command to execute (absolute path or on PATH). */
  command: string;
  /** Base args applied to every invocation. */
  args?: string[];
  /** Output parsing mode (default: json). */
  output?: "json" | "text" | "jsonl";
  /** Output parsing mode when resuming a CLI session. */
  resumeOutput?: "json" | "text" | "jsonl";
  /** Prompt input mode (default: arg). */
  input?: "arg" | "stdin";
  /** Max prompt length for arg mode (if exceeded, stdin is used). */
  maxPromptArgChars?: number;
  /** Extra env vars injected for this CLI. */
  env?: Record<string, string>;
  /** Env vars to remove before launching this CLI. */
  clearEnv?: string[];
  /** Flag used to pass model id (e.g. --model). */
  modelArg?: string;
  /** Model aliases mapping (config model id → CLI model id). */
  modelAliases?: Record<string, string>;
  /** Flag used to pass session id (e.g. --session-id). */
  sessionArg?: string;
  /** Extra args used when resuming a session (use {sessionId} placeholder). */
  sessionArgs?: string[];
  /** Alternate args to use when resuming a session (use {sessionId} placeholder). */
  resumeArgs?: string[];
  /** When to pass session ids. */
  sessionMode?: "always" | "existing" | "none";
  /** JSON fields to read session id from (in order). */
  sessionIdFields?: string[];
  /** Flag used to pass system prompt. */
  systemPromptArg?: string;
  /** System prompt behavior (append vs replace). */
  systemPromptMode?: "append" | "replace";
  /** When to send system prompt. */
  systemPromptWhen?: "first" | "always" | "never";
  /** Flag used to pass image paths. */
  imageArg?: string;
  /** How to pass multiple images. */
  imageMode?: "repeat" | "list";
  /** Serialize runs for this CLI. */
  serialize?: boolean;
};

export type AgentDefaultsConfig = {
  /** Primary model and fallbacks (provider/model). */
  model?: AgentModelListConfig;
  /** Optional image-capable model and fallbacks (provider/model). */
  imageModel?: AgentModelListConfig;
  /** Model catalog with optional aliases (full provider/model keys). */
  models?: Record<string, AgentModelEntryConfig>;
  /** Agent working directory (preferred). Used as the default cwd for agent runs. */
  workspace?: string;
  /** Skip bootstrap (BOOTSTRAP.md creation, etc.) for pre-configured deployments. */
  skipBootstrap?: boolean;
  /** Optional IANA timezone for the user (used in system prompt; defaults to host timezone). */
  userTimezone?: string;
  /** Optional display-only context window override (used for % in status UIs). */
  contextTokens?: number;
  /** Optional CLI backends for text-only fallback (claude-cli, etc.). */
  cliBackends?: Record<string, CliBackendConfig>;
  /** Opt-in: prune old tool results from the LLM context to reduce token usage. */
  contextPruning?: AgentContextPruningConfig;
  /** Default thinking level when no /think directive is present. */
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high";
  /** Default verbose level when no /verbose directive is present. */
  verboseDefault?: "off" | "on";
  /** Default elevated level when no /elevated directive is present. */
  elevatedDefault?: "off" | "on";
  /** Default block streaming level when no override is present. */
  blockStreamingDefault?: "off" | "on";
  /**
   * Block streaming boundary:
   * - "text_end": end of each assistant text content block (before tool calls)
   * - "message_end": end of the whole assistant message (may include tool blocks)
   */
  blockStreamingBreak?: "text_end" | "message_end";
  /** Soft block chunking for streamed replies (min/max chars, prefer paragraph/newline). */
  blockStreamingChunk?: BlockStreamingChunkConfig;
  /**
   * Block reply coalescing (merge streamed chunks before send).
   * idleMs: wait time before flushing when idle.
   */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Human-like delay between block replies. */
  humanDelay?: HumanDelayConfig;
  timeoutSeconds?: number;
  /** Max inbound media size in MB for agent-visible attachments (text note or future image attach). */
  mediaMaxMb?: number;
  typingIntervalSeconds?: number;
  /** Typing indicator start mode (never|instant|thinking|message). */
  typingMode?: TypingMode;
  /** Periodic background heartbeat runs. */
  heartbeat?: {
    /** Heartbeat interval (duration string, default unit: minutes; default: 30m). */
    every?: string;
    /** Heartbeat model override (provider/model). */
    model?: string;
    /** Delivery target (last|whatsapp|telegram|discord|slack|msteams|signal|imessage|none). */
    target?:
      | "last"
      | "whatsapp"
      | "telegram"
      | "discord"
      | "slack"
      | "msteams"
      | "signal"
      | "imessage"
      | "none";
    /** Optional delivery override (E.164 for WhatsApp, chat id for Telegram). */
    to?: string;
    /** Override the heartbeat prompt body (default: "Read HEARTBEAT.md if exists. Consider outstanding tasks. Checkup sometimes on your human during (user local) day time."). */
    prompt?: string;
    /** Max chars allowed after HEARTBEAT_OK before delivery (default: 30). */
    ackMaxChars?: number;
    /**
     * When enabled, deliver the model's reasoning payload for heartbeat runs (when available)
     * as a separate message prefixed with `Reasoning:` (same as `/reasoning on`).
     *
     * Default: false (only the final heartbeat payload is delivered).
     */
    includeReasoning?: boolean;
  };
  /** Max concurrent agent runs across all conversations. Default: 1 (sequential). */
  maxConcurrent?: number;
  /** Sub-agent defaults (spawned via sessions_spawn). */
  subagents?: {
    /** Max concurrent sub-agent runs (global lane: "subagent"). Default: 1. */
    maxConcurrent?: number;
    /** Auto-archive sub-agent sessions after N minutes (default: 60). */
    archiveAfterMinutes?: number;
  };
  /** Optional sandbox settings for non-main sessions. */
  sandbox?: {
    /** Enable sandboxing for sessions. */
    mode?: "off" | "non-main" | "all";
    /**
     * Agent workspace access inside the sandbox.
     * - "none": do not mount the agent workspace into the container; use a sandbox workspace under workspaceRoot
     * - "ro": mount the agent workspace read-only; disables write/edit tools
     * - "rw": mount the agent workspace read/write; enables write/edit tools
     */
    workspaceAccess?: "none" | "ro" | "rw";
    /**
     * Session tools visibility for sandboxed sessions.
     * - "spawned": only allow session tools to target sessions spawned from this session (default)
     * - "all": allow session tools to target any session
     */
    sessionToolsVisibility?: "spawned" | "all";
    /** Container/workspace scope for sandbox isolation. */
    scope?: "session" | "agent" | "shared";
    /** Legacy alias for scope ("session" when true, "shared" when false). */
    perSession?: boolean;
    /** Root directory for sandbox workspaces. */
    workspaceRoot?: string;
    /** Docker-specific sandbox settings. */
    docker?: SandboxDockerSettings;
    /** Optional sandboxed browser settings. */
    browser?: SandboxBrowserSettings;
    /** Auto-prune sandbox containers. */
    prune?: SandboxPruneSettings;
  };
};

export type ClawdbotConfig = {
  auth?: AuthConfig;
  env?: {
    /** Opt-in: import missing secrets from a login shell environment (exec `$SHELL -l -c 'env -0'`). */
    shellEnv?: {
      enabled?: boolean;
      /** Timeout for the login shell exec (ms). Default: 15000. */
      timeoutMs?: number;
    };
    /** Inline env vars to apply when not already present in the process env. */
    vars?: Record<string, string>;
    /** Sugar: allow env vars directly under env (string values only). */
    [key: string]:
      | string
      | Record<string, string>
      | { enabled?: boolean; timeoutMs?: number }
      | undefined;
  };
  wizard?: {
    lastRunAt?: string;
    lastRunVersion?: string;
    lastRunCommit?: string;
    lastRunCommand?: string;
    lastRunMode?: "local" | "remote";
  };
  logging?: LoggingConfig;
  browser?: BrowserConfig;
  ui?: {
    /** Accent color for Clawdbot UI chrome (hex). */
    seamColor?: string;
  };
  skills?: SkillsConfig;
  models?: ModelsConfig;
  agents?: AgentsConfig;
  tools?: ToolsConfig;
  bindings?: AgentBinding[];
  broadcast?: BroadcastConfig;
  audio?: AudioConfig;
  messages?: MessagesConfig;
  commands?: CommandsConfig;
  session?: SessionConfig;
  web?: WebConfig;
  whatsapp?: WhatsAppConfig;
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  slack?: SlackConfig;
  signal?: SignalConfig;
  imessage?: IMessageConfig;
  msteams?: MSTeamsConfig;
  cron?: CronConfig;
  hooks?: HooksConfig;
  bridge?: BridgeConfig;
  discovery?: DiscoveryConfig;
  canvasHost?: CanvasHostConfig;
  talk?: TalkConfig;
  gateway?: GatewayConfig;
};

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export type LegacyConfigIssue = {
  path: string;
  message: string;
};

export type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  valid: boolean;
  config: ClawdbotConfig;
  issues: ConfigValidationIssue[];
  legacyIssues: LegacyConfigIssue[];
};
