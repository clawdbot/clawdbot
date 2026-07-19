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
export type SignalApiMode = "auto" | "native" | "container";

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
    /** Optional signal-cli config directory path (passed as --config). */
    configPath?: string;
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
    /** Max time to wait for signal-cli daemon startup (ms, cap 120000). */
    startupTimeoutMs?: number;
    receiveMode?: "on-start" | "manual";
    ignoreAttachments?: boolean;
    ignoreStories?: boolean;
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
  /**
   * Signal API mode (channel-global):
   * - "auto" (default): Auto-detect based on available endpoints
   * - "native": Use native signal-cli with JSON-RPC + SSE (/api/v1/rpc, /api/v1/events)
   * - "container": Use bbernhard/signal-cli-rest-api with REST + WebSocket (/v2/send, /v1/receive/{account}).
   *   Requires the container to run with MODE=json-rpc for real-time message receiving.
   */
  apiMode?: SignalApiMode;
  /** Optional per-account Signal configuration (multi-account). */
  accounts?: Record<string, SignalAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & SignalAccountConfig;
