export type ReplyMode = "text" | "command";
export type SessionScope = "per-sender" | "global";
export type ReplyToMode = "off" | "first" | "all";
export type GroupPolicy = "open" | "disabled" | "allowlist";
export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export type SessionSendPolicyAction = "allow" | "deny";
export type SessionSendPolicyMatch = {
  surface?: string;
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

export type AgentElevatedAllowFromConfig = {
  whatsapp?: string[];
  telegram?: Array<string | number>;
  discord?: Array<string | number>;
  slack?: Array<string | number>;
  signal?: Array<string | number>;
  imessage?: Array<string | number>;
  webchat?: Array<string | number>;
};

export type WhatsAppConfig = {
  /** Optional per-account WhatsApp configuration (multi-account). */
  accounts?: Record<string, WhatsAppAccountConfig>;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
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
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  groups?: Record<
    string,
    {
      requireMention?: boolean;
    }
  >;
};

export type WhatsAppAccountConfig = {
  /** If false, do not start this WhatsApp account provider. Default: true. */
  enabled?: boolean;
  /** Override auth directory (Baileys multi-file auth state). */
  authDir?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  groupPolicy?: GroupPolicy;
  textChunkLimit?: number;
  groups?: Record<
    string,
    {
      requireMention?: boolean;
    }
  >;
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
  channel?:
    | "last"
    | "whatsapp"
    | "telegram"
    | "discord"
    | "slack"
    | "signal"
    | "imessage";
  to?: string;
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
  };
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

export type TelegramConfig = {
  /**
   * Controls how Telegram direct chats (DMs) are handled:
   * - "pairing" (default): unknown senders get a pairing code; owner must approve
   * - "allowlist": only allow senders in allowFrom (or paired allow store)
   * - "open": allow all inbound DMs (requires allowFrom to include "*")
   * - "disabled": ignore all inbound DMs
   */
  dmPolicy?: DmPolicy;
  /** If false, do not start the Telegram provider. Default: true. */
  enabled?: boolean;
  botToken?: string;
  /** Path to file containing bot token (for secret managers like agenix) */
  tokenFile?: string;
  /** Control reply threading when reply tags are present (off|first|all). */
  replyToMode?: ReplyToMode;
  groups?: Record<
    string,
    {
      requireMention?: boolean;
    }
  >;
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
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  mediaMaxMb?: number;
  proxy?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
};

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

export type DiscordSlashCommandConfig = {
  /** Enable handling for the configured slash command (default: false). */
  enabled?: boolean;
  /** Slash command name (default: "clawd"). */
  name?: string;
  /** Session key prefix for slash commands (default: "discord:slash"). */
  sessionPrefix?: string;
  /** Reply ephemerally (default: true). */
  ephemeral?: boolean;
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
};

export type DiscordConfig = {
  /** If false, do not start the Discord provider. Default: true. */
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
  mediaMaxMb?: number;
  historyLimit?: number;
  /** Per-action tool gating (default: true for all). */
  actions?: DiscordActionConfig;
  /** Control reply threading when reply tags are present (off|first|all). */
  replyToMode?: ReplyToMode;
  slashCommand?: DiscordSlashCommandConfig;
  dm?: DiscordDmConfig;
  /** New per-guild config keyed by guild id or slug. */
  guilds?: Record<string, DiscordGuildEntry>;
};

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
  allow?: boolean;
  requireMention?: boolean;
};

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

export type SlackConfig = {
  /** If false, do not start the Slack provider. Default: true. */
  enabled?: boolean;
  botToken?: string;
  appToken?: string;
  /**
   * Controls how channel messages are handled:
   * - "open" (default): channels bypass allowlists; mention-gating applies
   * - "disabled": block all channel messages
   * - "allowlist": only allow channels present in slack.channels
   */
  groupPolicy?: GroupPolicy;
  textChunkLimit?: number;
  mediaMaxMb?: number;
  /** Reaction notification mode (off|own|all|allowlist). Default: own. */
  reactionNotifications?: SlackReactionNotificationMode;
  /** Allowlist for reaction notifications when mode is allowlist. */
  reactionAllowlist?: Array<string | number>;
  actions?: SlackActionConfig;
  slashCommand?: SlackSlashCommandConfig;
  dm?: SlackDmConfig;
  channels?: Record<string, SlackChannelConfig>;
};

export type SignalConfig = {
  /** If false, do not start the Signal provider. Default: true. */
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
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  mediaMaxMb?: number;
};

export type IMessageConfig = {
  /** If false, do not start the iMessage provider. Default: true. */
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
  /** Include attachments + reactions in watch payloads. */
  includeAttachments?: boolean;
  /** Max outbound media size in MB. */
  mediaMaxMb?: number;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  groups?: Record<
    string,
    {
      requireMention?: boolean;
    }
  >;
};

export type QueueMode =
  | "steer"
  | "followup"
  | "collect"
  | "steer-backlog"
  | "steer+backlog"
  | "queue"
  | "interrupt";
export type QueueDropPolicy = "old" | "new" | "summarize";

export type QueueModeBySurface = {
  whatsapp?: QueueMode;
  telegram?: QueueMode;
  discord?: QueueMode;
  slack?: QueueMode;
  signal?: QueueMode;
  imessage?: QueueMode;
  webchat?: QueueMode;
};

export type GroupChatConfig = {
  mentionPatterns?: string[];
  historyLimit?: number;
};

export type RoutingConfig = {
  transcribeAudio?: {
    // Optional CLI to turn inbound audio into text; templated args, must output transcript to stdout.
    command: string[];
    timeoutSeconds?: number;
  };
  groupChat?: GroupChatConfig;
  /** Default agent id when no binding matches. Default: "main". */
  defaultAgentId?: string;
  agentToAgent?: {
    /** Enable agent-to-agent messaging tools. Default: false. */
    enabled?: boolean;
    /** Allowlist of agent ids or patterns (implementation-defined). */
    allow?: string[];
  };
  agents?: Record<
    string,
    {
      workspace?: string;
      agentDir?: string;
      model?: string;
      sandbox?: {
        mode?: "off" | "non-main" | "all";
        perSession?: boolean;
        workspaceRoot?: string;
      };
    }
  >;
  bindings?: Array<{
    agentId: string;
    match: {
      surface: string;
      surfaceAccountId?: string;
      peer?: { kind: "dm" | "group" | "channel"; id: string };
      guildId?: string;
      teamId?: string;
    };
  }>;
  queue?: {
    mode?: QueueMode;
    bySurface?: QueueModeBySurface;
    debounceMs?: number;
    cap?: number;
    drop?: QueueDropPolicy;
  };
};

export type MessagesConfig = {
  messagePrefix?: string; // Prefix added to all inbound messages (default: "[clawdbot]" if no allowFrom, else "")
  responsePrefix?: string; // Prefix auto-added to all outbound replies (e.g., "🦞")
  /** Emoji reaction used to acknowledge inbound messages (empty disables). */
  ackReaction?: string;
  /** When to send ack reactions. Default: "group-mentions". */
  ackReactionScope?: "group-mentions" | "group-all" | "direct" | "all";
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
};

export type GatewayReloadMode = "off" | "restart" | "hot" | "hybrid";

export type GatewayReloadConfig = {
  /** Reload strategy for config changes (default: hybrid). */
  mode?: GatewayReloadMode;
  /** Debounce window for config reloads (ms). Default: 300. */
  debounceMs?: number;
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
  apiKey: string;
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
  mode: "api_key" | "oauth";
  email?: string;
};

export type AuthConfig = {
  profiles?: Record<string, AuthProfileConfig>;
  order?: Record<string, string[]>;
};

export type AgentModelEntryConfig = {
  alias?: string;
};

export type AgentModelListConfig = {
  primary?: string;
  fallbacks?: string[];
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
  };
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
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
  agent?: {
    /** Primary model and fallbacks (provider/model). */
    model?: AgentModelListConfig;
    /** Optional image-capable model and fallbacks (provider/model). */
    imageModel?: AgentModelListConfig;
    /** Model catalog with optional aliases (full provider/model keys). */
    models?: Record<string, AgentModelEntryConfig>;
    /** Agent working directory (preferred). Used as the default cwd for agent runs. */
    workspace?: string;
    /** Optional IANA timezone for the user (used in system prompt; defaults to host timezone). */
    userTimezone?: string;
    /** Optional display-only context window override (used for % in status UIs). */
    contextTokens?: number;
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
    blockStreamingChunk?: {
      minChars?: number;
      maxChars?: number;
      breakPreference?: "paragraph" | "newline" | "sentence";
    };
    timeoutSeconds?: number;
    /** Max inbound media size in MB for agent-visible attachments (text note or future image attach). */
    mediaMaxMb?: number;
    typingIntervalSeconds?: number;
    /** Periodic background heartbeat runs. */
    heartbeat?: {
      /** Heartbeat interval (duration string, default unit: minutes). */
      every?: string;
      /** Heartbeat model override (provider/model). */
      model?: string;
      /** Delivery target (last|whatsapp|telegram|discord|signal|imessage|none). */
      target?:
        | "last"
        | "whatsapp"
        | "telegram"
        | "discord"
        | "slack"
        | "signal"
        | "imessage"
        | "none";
      /** Optional delivery override (E.164 for WhatsApp, chat id for Telegram). */
      to?: string;
      /** Override the heartbeat prompt body (default: "HEARTBEAT"). */
      prompt?: string;
      /** Max chars allowed after HEARTBEAT_OK before delivery (default: 30). */
      ackMaxChars?: number;
    };
    /** Max concurrent agent runs across all conversations. Default: 1 (sequential). */
    maxConcurrent?: number;
    /** Sub-agent defaults (spawned via sessions_spawn). */
    subagents?: {
      /** Max concurrent sub-agent runs (global lane: "subagent"). Default: 1. */
      maxConcurrent?: number;
      /** Tool allow/deny policy for sub-agent sessions (deny wins). */
      tools?: {
        allow?: string[];
        deny?: string[];
      };
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
    /** Elevated bash permissions for the host machine. */
    elevated?: {
      /** Enable or disable elevated mode (default: true). */
      enabled?: boolean;
      /** Approved senders for /elevated (per-surface allowlists). */
      allowFrom?: AgentElevatedAllowFromConfig;
    };
    /** Optional sandbox settings for non-main sessions. */
    sandbox?: {
      /** Enable sandboxing for sessions. */
      mode?: "off" | "non-main" | "all";
      /**
       * Session tools visibility for sandboxed sessions.
       * - "spawned": only allow session tools to target sessions spawned from this session (default)
       * - "all": allow session tools to target any session
       */
      sessionToolsVisibility?: "spawned" | "all";
      /** Use one container per session (recommended for hard isolation). */
      perSession?: boolean;
      /** Root directory for sandbox workspaces. */
      workspaceRoot?: string;
      /** Docker-specific sandbox settings. */
      docker?: {
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
        ulimits?: Record<
          string,
          string | number | { soft?: number; hard?: number }
        >;
        /** Seccomp profile (path or profile name). */
        seccompProfile?: string;
        /** AppArmor profile name. */
        apparmorProfile?: string;
        /** DNS servers (e.g. ["1.1.1.1", "8.8.8.8"]). */
        dns?: string[];
        /** Extra host mappings (e.g. ["api.local:10.0.0.2"]). */
        extraHosts?: string[];
      };
      /** Optional sandboxed browser settings. */
      browser?: {
        enabled?: boolean;
        image?: string;
        containerPrefix?: string;
        cdpPort?: number;
        vncPort?: number;
        noVncPort?: number;
        headless?: boolean;
        enableNoVnc?: boolean;
      };
      /** Tool allow/deny policy (deny wins). */
      tools?: {
        allow?: string[];
        deny?: string[];
      };
      /** Auto-prune sandbox containers. */
      prune?: {
        /** Prune if idle for more than N hours (0 disables). */
        idleHours?: number;
        /** Prune if older than N days (0 disables). */
        maxAgeDays?: number;
      };
    };
    /** Global tool allow/deny policy for all providers (deny wins). */
    tools?: {
      allow?: string[];
      deny?: string[];
    };
  };
  routing?: RoutingConfig;
  messages?: MessagesConfig;
  session?: SessionConfig;
  web?: WebConfig;
  whatsapp?: WhatsAppConfig;
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  slack?: SlackConfig;
  signal?: SignalConfig;
  imessage?: IMessageConfig;
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
