import type {
  ChannelPreviewStreamingConfig,
  ContextVisibilityMode,
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
  OutboundRetryConfig,
  ReplyToMode,
  SessionThreadBindingsConfig,
} from "./types.base.js";
import type {
  ChannelHealthMonitorConfig,
  ChannelHeartbeatVisibilityConfig,
} from "./types.channels.js";
import type { DmConfig, ProviderCommandsConfig } from "./types.messages.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type TelegramActionConfig = {
  reactions?: boolean;
  sendMessage?: boolean;
  /** Enable poll creation. Requires sendMessage to also be enabled. */
  poll?: boolean;
  deleteMessage?: boolean;
  editMessage?: boolean;
  /** Enable sticker actions (send and search). */
  sticker?: boolean;
  /** Enable forum topic creation. */
  createForumTopic?: boolean;
  /** Enable forum topic editing (rename / change icon). */
  editForumTopic?: boolean;
};

export type TelegramThreadBindingsConfig = SessionThreadBindingsConfig & {
  /**
   * @deprecated Use spawnSessions instead.
   */
  spawnSubagentSessions?: boolean;
  /**
   * @deprecated Use spawnSessions instead.
   */
  spawnAcpSessions?: boolean;
};

export type TelegramNetworkConfig = {
  /** Override Node's autoSelectFamily behavior (true = enable, false = disable). */
  autoSelectFamily?: boolean;
  /**
   * DNS result order for network requests ("ipv4first" | "verbatim").
   * Set to "ipv4first" to prioritize IPv4 addresses and work around IPv6 issues.
   * Default: "ipv4first" on Node 22+ to avoid common fetch failures.
   */
  dnsResultOrder?: "ipv4first" | "verbatim";
  /**
   * Dangerous opt-in for Telegram media downloads in trusted fake-IP or
   * transparent-proxy environments that resolve api.telegram.org to
   * private/internal/special-use addresses.
   */
  dangerouslyAllowPrivateNetwork?: boolean;
};

export type TelegramInlineButtonsScope = "off" | "dm" | "group" | "all" | "allowlist";
export type TelegramStreamingMode = "off" | "partial" | "block" | "progress";
export type TelegramExecApprovalTarget = "dm" | "channel" | "both";

export type TelegramExecApprovalConfig = {
  /** Enable mode for Telegram exec approvals on this account. Default: auto when approvers can be resolved; false disables. */
  enabled?: import("./types.approvals.js").NativeExecApprovalEnableMode;
  /** Telegram user IDs allowed to approve exec requests. Optional: falls back to numeric owner IDs inferred from commands.ownerAllowFrom when possible. */
  approvers?: Array<string | number>;
  /** Only forward approvals for these agent IDs. Omit = all agents. */
  agentFilter?: string[];
  /** Only forward approvals matching these session key patterns (substring or regex). */
  sessionFilter?: string[];
  /** Where to send approval prompts. Default: "dm". */
  target?: TelegramExecApprovalTarget;
};

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
  /** Telegram-native exec approval delivery + approver authorization. */
  execApprovals?: TelegramExecApprovalConfig;
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
  /** Path to a regular file containing the bot token; symlinks are rejected. */
  tokenFile?: string;
  /** Control reply threading when reply tags are present (off|first|all|batched). */
  replyToMode?: ReplyToMode;
  /** Direct-message threading behavior. Defaults to flat DM sessions. */
  dm?: TelegramDmConfig;
  groups?: Record<string, TelegramGroupConfig>;
  /** Per-DM configuration for Telegram DM topics (key is chat ID). */
  direct?: Record<string, TelegramDirectConfig>;
  /** DM allowlist (numeric Telegram user IDs). Onboarding can resolve @username to IDs. */
  allowFrom?: Array<string | number>;
  /** Default delivery target for CLI `--deliver` when no explicit `--reply-to` is provided. */
  defaultTo?: string | number;
  /** Optional allowlist for Telegram group senders (numeric Telegram user IDs). */
  groupAllowFrom?: Array<string | number>;
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
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, DmConfig>;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Streaming + chunking settings. Prefer this nested shape over legacy flat keys. */
  streaming?: ChannelPreviewStreamingConfig;
  mediaMaxMb?: number;
  /** Telegram API client timeout in seconds (grammY ApiClientOptions). */
  timeoutSeconds?: number;
  /** Buffer window for Telegram media groups/albums before dispatching them as one inbound message. Default: 500ms. */
  mediaGroupFlushMs?: number;
  /** Telegram polling watchdog threshold in milliseconds. Default: 120000. */
  pollingStallThresholdMs?: number;
  /** Retry policy for outbound Telegram API calls. */
  retry?: OutboundRetryConfig;
  /** Network transport overrides for Telegram. */
  network?: TelegramNetworkConfig;
  proxy?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
  /** Local webhook listener bind host (default: 127.0.0.1). */
  webhookHost?: string;
  /** Local webhook listener bind port (default: 8787). */
  webhookPort?: number;
  /** Path to the self-signed certificate (PEM) to upload to Telegram during webhook registration. */
  webhookCertPath?: string;
  /** Per-action tool gating (default: true for all). */
  actions?: TelegramActionConfig;
  /** Telegram thread/conversation binding overrides. */
  threadBindings?: TelegramThreadBindingsConfig;
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
  /** Channel health monitor overrides for this channel/account. */
  healthMonitor?: ChannelHealthMonitorConfig;
  /** Controls whether link previews are shown in outbound messages. Default: true. */
  linkPreview?: boolean;
  /** Send Telegram bot error replies silently (no notification sound). Default: false. */
  silentErrorReplies?: boolean;
  /** Controls outbound error reporting: always, once per cooldown window, or silent. */
  errorPolicy?: "always" | "once" | "silent";
  /** Cooldown window for `errorPolicy: "once"` in milliseconds. */
  errorCooldownMs?: number;
  /**
   * Per-channel outbound response prefix override.
   *
   * When set, this takes precedence over the global `messages.responsePrefix`.
   * Use `""` to explicitly disable a global prefix for this channel.
   * Use `"auto"` to derive `[{identity.name}]` from the routed agent.
   */
  responsePrefix?: string;
  /**
   * Per-channel ack reaction override.
   * Telegram expects unicode emoji (e.g., "👀") rather than shortcodes.
   */
  ackReaction?: string;
  /** Custom Telegram Bot API root URL (e.g. "https://my-proxy.example.com" or a local Bot API server), not a /bot<TOKEN> endpoint. */
  apiRoot?: string;
  /** Trusted local filesystem roots for self-hosted Telegram Bot API absolute file_path values. */
  trustedLocalFileRoots?: string[];
  /** Auto-rename DM forum topics on first message using LLM. Default: true. */
  autoTopicLabel?: AutoTopicLabelConfig;
};

export type TelegramDmThreadReplies = "off" | "inbound" | "always";

export type TelegramDmConfig = {
  /** DM-only session threading override for message_thread_id (off|inbound|always). Default: off. */
  threadReplies?: TelegramDmThreadReplies;
};

export type TelegramTopicConfig = {
  requireMention?: boolean;
  /** Emit internal message hooks for mention-skipped topic messages. */
  ingest?: boolean;
  /** Per-topic override for group message policy (open|disabled|allowlist). */
  groupPolicy?: GroupPolicy;
  /** If specified, only load these skills for this topic. Omit = all skills; empty = no skills. */
  skills?: string[];
  /** If false, disable the bot for this topic. */
  enabled?: boolean;
  /** Optional allowlist for topic senders (numeric Telegram user IDs). */
  allowFrom?: Array<string | number>;
  /** Optional system prompt snippet for this topic. */
  systemPrompt?: string;
  /** If true, skip automatic voice-note transcription for mention detection in this topic. */
  disableAudioPreflight?: boolean;
  /** Route this topic to a specific agent (overrides group-level and binding routing). */
  agentId?: string;
  /** Controls outbound error reporting for this topic. */
  errorPolicy?: "always" | "once" | "silent";
  /** Cooldown window for `errorPolicy: "once"` in milliseconds. */
  errorCooldownMs?: number;
};

export type TelegramGroupConfig = {
  requireMention?: boolean;
  /** Emit internal message hooks for mention-skipped group messages. */
  ingest?: boolean;
  /** Per-group override for group message policy (open|disabled|allowlist). */
  groupPolicy?: GroupPolicy;
  /** Optional tool policy overrides for this group. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** If specified, only load these skills for this group (when no topic). Omit = all skills; empty = no skills. */
  skills?: string[];
  /** Per-topic configuration (key is message_thread_id as string) */
  topics?: Record<string, TelegramTopicConfig>;
  /** If false, disable the bot for this group (and its topics). */
  enabled?: boolean;
  /** Optional allowlist for group senders (numeric Telegram user IDs). */
  allowFrom?: Array<string | number>;
  /** Optional system prompt snippet for this group. */
  systemPrompt?: string;
  /** If true, skip automatic voice-note transcription for mention detection in this group. */
  disableAudioPreflight?: boolean;
  /** Controls outbound error reporting for this group. */
  errorPolicy?: "always" | "once" | "silent";
  /** Cooldown window for `errorPolicy: "once"` in milliseconds. */
  errorCooldownMs?: number;
};

/** Config for LLM-based auto-topic labeling. */
export type AutoTopicLabelConfig =
  | boolean
  | {
      enabled?: boolean;
      /** Custom prompt for LLM-based topic naming. */
      prompt?: string;
    };

export type TelegramDirectConfig = {
  /** Per-DM override for DM message policy (open|disabled|allowlist). */
  dmPolicy?: DmPolicy;
  /** Controls whether Telegram DM message_thread_id values split sessions. Default: off unless topic config requires it. */
  threadReplies?: "off" | "inbound" | "always";
  /** Optional tool policy overrides for this DM. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** If specified, only load these skills for this DM (when no topic). Omit = all skills; empty = no skills. */
  skills?: string[];
  /** Per-topic configuration for DM topics (key is message_thread_id as string) */
  topics?: Record<string, TelegramTopicConfig>;
  /** If false, disable the bot for this DM (and its topics). */
  enabled?: boolean;
  /** If true, require messages to be from a topic when topics are enabled. */
  requireTopic?: boolean;
  /** Optional allowlist for DM senders (numeric Telegram user IDs). */
  allowFrom?: Array<string | number>;
  /** Optional system prompt snippet for this DM. */
  systemPrompt?: string;
  /** Controls outbound error reporting for this DM. */
  errorPolicy?: "always" | "once" | "silent";
  /** Cooldown window for `errorPolicy: "once"` in milliseconds. */
  errorCooldownMs?: number;
  /** Auto-rename DM forum topics on first message using LLM. Default: true. */
  autoTopicLabel?: AutoTopicLabelConfig;
};

export type TelegramConfig = {
  /** Optional per-account Telegram configuration (multi-account). */
  accounts?: Record<string, TelegramAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & TelegramAccountConfig;

declare module "./types.channels.js" {
  interface ChannelsConfig {
    telegram?: TelegramConfig;
  }
}
