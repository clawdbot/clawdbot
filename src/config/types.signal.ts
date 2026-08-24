// Defines Signal channel configuration types.
import type { ReplyToMode } from "./types.base.js";
import type {
  ChannelReactionConfig,
  ChannelReadReceiptConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type SignalReactionNotificationMode = "off" | "own" | "all" | "allowlist";
export type SignalReactionLevel = "off" | "ack" | "minimal" | "extensive";
export type SignalTransportConfig =
  | {
      kind: "managed-native";
      /** Optional signal-cli config directory path (passed as --config). */
      configPath?: string;
      /** Native daemon connection URL when it differs from the managed bind endpoint. */
      url?: string;
      /** HTTP host for the managed signal-cli daemon (default 127.0.0.1). */
      httpHost?: string;
      /** HTTP port for the managed signal-cli daemon (default 8080). */
      httpPort?: number;
      /** signal-cli binary path (default: signal-cli). */
      cliPath?: string;
      /** Max time to wait for signal-cli daemon startup (ms, cap 120000). */
      startupTimeoutMs?: number;
      receiveMode?: "on-start" | "manual";
      ignoreStories?: boolean;
    }
  | {
      kind: "external-native";
      /** Base URL for an externally managed native signal-cli HTTP daemon. */
      url: string;
    }
  | {
      kind: "container";
      /** Base URL for bbernhard/signal-cli-rest-api. */
      url: string;
    };

export type SignalGroupConfig = {
  requireMention?: boolean;
  /** Emit internal message hooks for mention-skipped group messages. */
  ingest?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

export type SignalAccountConfig = Omit<CommonChannelMessagingConfig, "mentionPatterns"> &
  ChannelReadReceiptConfig &
  ChannelReactionConfig<SignalReactionNotificationMode, SignalReactionLevel, never, true> & {
    /** Optional explicit E.164 account for signal-cli. */
    account?: string;
    /** Optional account UUID for signal-cli (used for loop protection). */
    accountUuid?: string;
    /** Concrete transport owned by this account. Defaults to managed native signal-cli. */
    transport?: SignalTransportConfig;
    /** Skip downloading inbound Signal attachments. */
    ignoreAttachments?: boolean;
    /** OpenClaw-side target aliases keyed by friendly name. */
    aliases?: Record<string, string>;
    /** Per-group overrides keyed by Signal group id (or "*"). */
    groups?: Record<string, SignalGroupConfig>;
    /** Optional per-chat-type native reply quoting overrides. */
    replyToModeByChatType?: Partial<Record<"direct" | "group", ReplyToMode>>;
    /** Action toggles for message tool capabilities. */
    actions?: {
      /** Enable/disable sending reactions via message tool (default: true). */
      reactions?: boolean;
    };
  };

export type SignalConfig = {
  /** Optional per-account Signal configuration (multi-account). */
  accounts?: Record<string, SignalAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & SignalAccountConfig;
