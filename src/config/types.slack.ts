// Defines Slack channel configuration types.
import type {
  ChannelStreamingBlockConfig,
  ChannelStreamingProgressConfig,
  ChannelStreamingPreviewConfig,
  ReplyToMode,
  StreamingMode,
  TextChunkMode,
} from "./types.base.js";
import type { ChannelBotLoopProtectionConfig } from "./types.bot-loop-protection.js";
import type {
  ChannelBotInteractionConfig,
  ChannelExecApprovalConfig,
  ChannelExecApprovalTarget,
  ChannelReactionConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";
import type { ChannelImplicitMentionsConfig } from "./types.implicit-mentions.js";
import type { ProviderCommandsConfig } from "./types.messages.js";
import type { SecretInput } from "./types.secrets.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type SlackDmConfig = {
  /** If false, ignore all incoming Slack DMs. Default: true. */
  enabled?: boolean;
  /** If true, allow group DMs (default: false). */
  groupEnabled?: boolean;
  /** Optional allowlist for group DM channels (ids or slugs). */
  groupChannels?: Array<string | number>;
};

export type SlackChannelConfig = {
  /** If false, disable the bot in this channel. */
  enabled?: boolean;
  /** Require mentioning the bot to trigger replies. */
  requireMention?: boolean;
  /**
   * Ignore room messages that mention another user or user group but not this bot.
   * Requires a resolved bot user ID. Default: false.
   */
  ignoreOtherMentions?: boolean;
  /** Override Slack reply/thread behavior for this channel. */
  replyToMode?: ReplyToMode;
  /** Optional tool policy overrides for this channel. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** Allow bot-authored messages to trigger replies (default: false). Set to "mentions" to only allow bot messages that @mention this bot. */
  allowBots?: boolean | "mentions";
  /** Sliding-window bot-pair loop guard for accepted bot-authored Slack messages. */
  botLoopProtection?: ChannelBotLoopProtectionConfig;
  /** Allowlist of users that can invoke the bot in this channel. */
  users?: Array<string | number>;
  /** Optional skill filter for this channel. */
  skills?: string[];
  /** Optional system prompt for this channel. */
  systemPrompt?: string;
  /** Slack presence polling and agent wake mode for this channel. */
  presenceEvents?: SlackPresenceEventsConfig;
};

type SlackPresenceEventsMode = "off" | "auto" | "on";

type SlackPresenceEventsConfig = {
  /** Presence wake mode. Default: off. */
  mode?: SlackPresenceEventsMode;
};

export type SlackReactionNotificationMode = "off" | "own" | "all" | "allowlist";
export type SlackStreamingMode = "off" | "partial" | "block" | "progress";
export type SlackStreamingProgressConfig = ChannelStreamingProgressConfig & {
  /** Opt in to Slack-native task cards for progress mode. Default: false. */
  nativeTaskCards?: boolean;
};
export type SlackChannelStreamingConfig = {
  mode?: StreamingMode;
  chunkMode?: TextChunkMode;
  nativeTransport?: boolean;
  preview?: ChannelStreamingPreviewConfig;
  progress?: SlackStreamingProgressConfig;
  block?: ChannelStreamingBlockConfig;
};
export type SlackExecApprovalTarget = ChannelExecApprovalTarget;
export type SlackExecApprovalConfig = ChannelExecApprovalConfig;
export type SlackCapabilitiesConfig =
  | string[]
  | {
      interactiveReplies?: boolean;
    };

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
  /** Slash command name (default: "openclaw"). */
  name?: string;
  /** Session key prefix for slash commands (default: "slack:slash"). */
  sessionPrefix?: string;
  /** Reply ephemerally (default: true). */
  ephemeral?: boolean;
};

export type SlackThreadConfig = {
  /** Scope for thread history context (thread|channel). Default: thread. */
  historyScope?: "thread" | "channel";
  /** If true, thread sessions inherit the parent channel transcript. Default: false. */
  inheritParent?: boolean;
  /** Maximum number of thread messages to fetch as context when starting a new thread session (default: 20). Set to 0 to disable thread history fetching. */
  initialHistoryLimit?: number;
};

export type SlackRelayConfig = {
  /** Full relay websocket URL, including the route path. */
  url?: string;
  /** Bearer token used to authenticate the gateway websocket to the Slack relay. */
  authToken?: SecretInput;
  /** Gateway destination id registered with openclaw-slack-router. */
  gatewayId?: string;
};

export type SlackAccountConfig = Omit<
  CommonChannelMessagingConfig<
    SlackCapabilitiesConfig,
    string | number,
    string,
    SlackChannelStreamingConfig
  >,
  "groupAllowFrom"
> &
  ChannelBotInteractionConfig &
  ChannelReactionConfig<SlackReactionNotificationMode, never, string, true> & {
    /** @deprecated Doctor-only legacy input. */
    identity?: "bot" | "user";
    /** @deprecated Doctor-only legacy input. */
    socketMode?: {
      clientPingTimeout?: number;
      serverPingTimeout?: number;
      pingPongLoggingEnabled?: boolean;
    };
    /** Slack author identity. Default: bot. */
    postAs?: "bot" | "user";
    /** Slack connection mode (socket|http|relay). Default: socket. */
    mode?: "socket" | "http" | "relay";
    /**
     * Treat this account as one Slack Enterprise Grid org-wide installation.
     * The declaration is verified against auth.test during monitor startup.
     * DMs must be disabled or use dmPolicy="open" with effective allowFrom containing "*".
     */
    enterpriseOrgInstall?: boolean;
    /** Slack SDK Socket Mode transport options. Ignored in HTTP mode. */
    /** Relay-delivered Slack event source. Used when mode is "relay". */
    relay?: SlackRelayConfig;
    /** Slack signing secret (required for HTTP mode). */
    signingSecret?: SecretInput;
    /** Slack Events API webhook path (default: /slack/events). */
    webhookPath?: string;
    /** Slack-native exec approval delivery + approver authorization. */
    execApprovals?: SlackExecApprovalConfig;
    /** Override native command registration for Slack (bool or "auto"). */
    commands?: ProviderCommandsConfig;
    botToken?: SecretInput;
    appToken?: SecretInput;
    userToken?: SecretInput;
    /** If true, restrict user token to read operations only. Default: true. */
    userTokenReadOnly?: boolean;
    /** Default mention requirement for channel messages (default: true). */
    requireMention?: boolean;
    /** Implicit mention policy for replies, quotes, and participated threads. */
    implicitMentions?: ChannelImplicitMentionsConfig;
    /** Pass through Slack chat.postMessage link unfurl control. Default: false. */
    unfurlLinks?: boolean;
    /** Pass through Slack chat.postMessage media unfurl control. Omitted by default. */
    unfurlMedia?: boolean;
    /**
     * Optional per-chat-type reply threading overrides.
     * Example: { direct: "all", group: "first", channel: "off" }.
     */
    replyToModeByChatType?: Partial<Record<"direct" | "group" | "channel", ReplyToMode>>;
    /** Thread session behavior. */
    thread?: SlackThreadConfig;
    /** Poll Slack presence and wake the routed agent on away-to-active transitions. Default: off. */
    presenceEvents?: SlackPresenceEventsConfig;
    actions?: SlackActionConfig;
    slashCommand?: SlackSlashCommandConfig;
    dm?: SlackDmConfig;
    channels?: Record<string, SlackChannelConfig>;
    /** Reaction emoji added while processing a reply (e.g. "hourglass_flowing_sand"). Removed when done. Useful as a typing indicator fallback when assistant mode is not enabled. */
    typingReaction?: string;
  };

export type SlackConfig = {
  /** Optional per-account Slack configuration (multi-account). */
  accounts?: Record<string, SlackAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & SlackAccountConfig;
