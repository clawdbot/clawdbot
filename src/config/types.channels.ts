// Defines channel configuration types shared by channel plugins.
import type { ContextVisibilityMode, GroupPolicy } from "./types.base.js";
import type { ChannelBotLoopProtectionConfig } from "./types.bot-loop-protection.js";
import type {
  ChannelHealthMonitorConfig,
  ChannelHeartbeatVisibilityConfig,
} from "./types.channel-health.js";
import type { DiscordConfig } from "./types.discord.js";
import type { GoogleChatConfig } from "./types.googlechat.js";
import type { IMessageConfig } from "./types.imessage.js";
import type { IrcConfig } from "./types.irc.js";
import type { MentionPatternsPolicyConfig } from "./types.messages.js";
import type { MSTeamsConfig } from "./types.msteams.js";
import type { SignalConfig } from "./types.signal.js";
import type { SlackConfig } from "./types.slack.js";
import type { TelegramConfig } from "./types.telegram.js";
import type { WhatsAppConfig } from "./types.whatsapp.js";

export type {
  ChannelHealthMonitorConfig,
  ChannelHeartbeatVisibilityConfig,
} from "./types.channel-health.js";
export type { ChannelBotLoopProtectionConfig } from "./types.bot-loop-protection.js";

export type ChannelDefaultsConfig = {
  /** Default group-chat admission policy inherited by channels that support groups. */
  groupPolicy?: GroupPolicy;
  /** Default history/context visibility inherited by channel configs. */
  contextVisibility?: ContextVisibilityMode;
  /** Default heartbeat visibility for all channels. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /** Default pair loop guard settings for channels that support bot loop protection. */
  botLoopProtection?: ChannelBotLoopProtectionConfig;
};

/** Provider/channel/target model override map used by channel dispatch. */
export type ChannelModelByChannelConfig = Record<string, Record<string, string>>;

export type ExtensionNestedPolicyConfig = {
  /** Channel/plugin-owned nested policy mode, such as dm/group allowlist policy. */
  policy?: string;
  /** Sender ids, usernames, or platform ids accepted by the nested policy. */
  allowFrom?: Array<string | number> | ReadonlyArray<string | number>;
  /** Plugin-owned config keys that are intentionally outside the core schema. */
  [key: string]: unknown;
};

export type ExtensionAccountConfig = ExtensionNestedPolicyConfig & {
  /** Account-scoped default delivery target for CLI --deliver. */
  defaultTo?: string | number;
  /** Account-scoped direct-message policy override. */
  dmPolicy?: string;
  /** Nested DM policy/config owned by the plugin. */
  dm?: ExtensionNestedPolicyConfig;
  /** Account-scoped media size limit in megabytes. */
  mediaMaxMb?: number;
  /** Whether channel setup/doctor flows may write this account config. */
  configWrites?: boolean;
};

/** JSON-compatible open-world channel section for plugin ids unknown to core. */
type OpenWorldChannelConfig = ReturnType<typeof JSON.parse>;

/**
 * Base type for extension channel config sections.
 * Extensions can use this as a starting point for their channel config.
 */
export type ExtensionChannelConfig = {
  /** Enables this plugin-owned channel section. */
  enabled?: boolean;
  /** Sender ids, usernames, or platform ids allowed by the channel policy. */
  allowFrom?: Array<string | number> | ReadonlyArray<string | number>;
  /** Default delivery target for CLI --deliver when no explicit --reply-to is provided. */
  defaultTo?: string | number;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
  /** Plugin-owned direct-message policy mode. */
  dmPolicy?: string;
  /** Plugin-owned group admission policy mode. */
  groupPolicy?: GroupPolicy;
  /** Mention include/exclude policy shared by channels with group support. */
  mentionPatterns?: MentionPatternsPolicyConfig | string[];
  /** Channel-specific context visibility override. */
  contextVisibility?: ContextVisibilityMode;
  /** Channel health-monitor settings exposed through the shared channel contract. */
  healthMonitor?: ChannelHealthMonitorConfig;
  /** Nested direct-message config owned by the channel plugin. */
  dm?: ExtensionNestedPolicyConfig;
  /** Plugin-owned network config, including private-network controls when supported. */
  network?: Record<string, unknown>;
  /** Plugin-owned group config keyed by platform group id/name. */
  groups?: Record<string, unknown>;
  /** Plugin-owned room config keyed by platform room id/name. */
  rooms?: Record<string, unknown>;
  /** Channel-wide media size limit in megabytes. */
  mediaMaxMb?: number;
  /** Base callback URL used by interaction/webhook-capable channel plugins. */
  callbackBaseUrl?: string;
  /** Interaction callback config; callbackBaseUrl mirrors the top-level fallback. */
  interactions?: { callbackBaseUrl?: string; [key: string]: unknown };
  /** Plugin-owned native exec approval routing config. */
  execApprovals?: Record<string, unknown>;
  threadBindings?: {
    /** Enables thread-bound session routing for this channel. */
    enabled?: boolean;
    /** Allows sessions_spawn/native spawn flows to bind spawned sessions to threads. */
    spawnSessions?: boolean;
    /** Default context mode for thread-bound native subagent spawns. */
    defaultSpawnContext?: "isolated" | "fork";
    /** @deprecated Use spawnSessions instead. */
    spawnAcpSessions?: boolean;
    /** @deprecated Use spawnSessions instead. */
    spawnSubagentSessions?: boolean;
  };
  /** Channel-specific bot loop guard settings. */
  botLoopProtection?: ChannelBotLoopProtectionConfig;
  /** @deprecated Use threadBindings.spawnSessions instead. */
  spawnSubagentSessions?: boolean;
  /** Explicit opt-in for channels that need private network callbacks or media fetches. */
  dangerouslyAllowPrivateNetwork?: boolean;
  /** Account-scoped channel config keyed by plugin-defined account id. */
  accounts?: Record<string, ExtensionAccountConfig>;
  /** Plugin-owned config keys intentionally stay open-world at this boundary. */
  [key: string]: unknown;
};

export interface ChannelsConfig {
  /** Shared defaults inherited by channel sections unless they override them. */
  defaults?: ChannelDefaultsConfig;
  /** Map provider -> channel id -> model override. */
  modelByChannel?: ChannelModelByChannelConfig;
  discord?: DiscordConfig;
  googlechat?: GoogleChatConfig;
  imessage?: IMessageConfig;
  irc?: IrcConfig;
  msteams?: MSTeamsConfig;
  signal?: SignalConfig;
  slack?: SlackConfig;
  telegram?: TelegramConfig;
  whatsapp?: WhatsAppConfig;
  /**
   * Channel sections are plugin-owned and keyed by arbitrary channel ids.
   * Open-world config keeps SDK/plugin-owned sections ergonomic for dynamic ids.
   */
  [key: string]: OpenWorldChannelConfig;
}
