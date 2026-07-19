import type { NativeExecApprovalEnableMode } from "./types.approvals.js";
// Defines common channel messaging configuration types.
import type {
  ChannelDeliveryStreamingConfig,
  ContextVisibilityMode,
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
  ReplyToMode,
} from "./types.base.js";
import type { ChannelBotLoopProtectionConfig } from "./types.bot-loop-protection.js";
import type {
  ChannelHealthMonitorConfig,
  ChannelHeartbeatVisibilityConfig,
} from "./types.channel-health.js";
import type { DmConfig, MentionPatternsPolicyConfig } from "./types.messages.js";

export type CommonChannelMessagingConfig<
  TCapabilities = string[],
  TAllowFromEntry = string | number,
  TDefaultTo = string,
  TStreaming = ChannelDeliveryStreamingConfig,
> = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: TCapabilities;
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this account. Default: true. */
  enabled?: boolean;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Optional allowlist for inbound DM senders. */
  allowFrom?: TAllowFromEntry[];
  /** Default delivery target for CLI --deliver when no explicit --reply-to is provided. */
  defaultTo?: TDefaultTo;
  /** Optional allowlist for group/channel senders. */
  groupAllowFrom?: TAllowFromEntry[];
  /** Group/channel message handling policy. */
  groupPolicy?: GroupPolicy;
  /** Scope configured mention patterns to selected conversations. */
  mentionPatterns?: MentionPatternsPolicyConfig;
  /**
   * Supplemental context visibility policy for fetched/group context.
   * - "all": include all quoted/thread/history context
   * - "allowlist": only include context from allowlisted senders
   * - "allowlist_quote": same as allowlist, but keep explicit quote/reply context
   */
  contextVisibility?: ContextVisibilityMode;
  /** Max group/channel messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by sender ID. */
  dms?: Record<string, DmConfig>;
  /** Outbound text chunk size (chars). */
  textChunkLimit?: number;
  /** Delivery streaming config: chunk mode plus block streaming controls. */
  streaming?: TStreaming;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /** Channel health monitor overrides for this channel/account. */
  healthMonitor?: ChannelHealthMonitorConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /** Max outbound media size in MB. */
  mediaMaxMb?: number;
  /** Native reply-threading mode for automatic replies. */
  replyToMode?: ReplyToMode;
};

export type ChannelExecApprovalTarget = "dm" | "channel" | "both";

export type ChannelExecApprovalConfig<TApprover = string | number> = {
  enabled?: NativeExecApprovalEnableMode;
  approvers?: TApprover[];
  agentFilter?: string[];
  sessionFilter?: string[];
  target?: ChannelExecApprovalTarget;
};

export type ChannelBotInteractionConfig<TAllowBots = boolean | "mentions"> = {
  allowBots?: TAllowBots;
  botLoopProtection?: ChannelBotLoopProtectionConfig;
  dangerouslyAllowNameMatching?: boolean;
};

export type ChannelReadReceiptConfig = {
  sendReadReceipts?: boolean;
};

export type ChannelMentionPatternsConfig<TArraySugar extends boolean = false> =
  TArraySugar extends true ? string[] : MentionPatternsPolicyConfig;

export type ChannelReactionConfig<
  TNotification = never,
  TLevel = never,
  TAckReaction = never,
  TAllowlist extends boolean = false,
> = {
  reactionNotifications?: TNotification;
  reactionLevel?: TLevel;
  ackReaction?: TAckReaction;
} & (TAllowlist extends true
  ? { reactionAllowlist?: Array<string | number> }
  : Record<never, never>);
