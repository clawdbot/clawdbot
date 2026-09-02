/**
 * iMessage channel config types shared by core schema, bundled plugin runtime, and plugin SDK exports.
 * Root fields apply to the default account; `accounts` entries override them per account.
 */
import type {
  ChannelReactionConfig,
  ChannelReadReceiptConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

/** Private-API and helper actions the iMessage runtime may expose to agents. */
export type IMessageActionConfig = {
  reactions?: boolean;
  edit?: boolean;
  unsend?: boolean;
  reply?: boolean;
  sendWithEffect?: boolean;
  renameGroup?: boolean;
  setGroupIcon?: boolean;
  addParticipant?: boolean;
  removeParticipant?: boolean;
  leaveGroup?: boolean;
  sendAttachment?: boolean;
  polls?: boolean;
};

/** Inbound tapback notification policy. */
export type IMessageReactionNotificationMode = "off" | "own" | "all";
export type IMessageSendTransport = "auto" | "bridge" | "applescript";

/** Per-account iMessage runtime/config shape. */
export type IMessageAccountConfig = Omit<
  CommonChannelMessagingConfig,
  "mentionPatterns" | "replyToMode"
> &
  ChannelReadReceiptConfig &
  ChannelReactionConfig<IMessageReactionNotificationMode> & {
    /** imsg CLI binary path (default: imsg). */
    cliPath?: string;
    /** Optional Messages db path override. */
    dbPath?: string;
    /** Remote SSH host token for SCP attachment fetches (`host` or `user@host`). */
    remoteHost?: string;
    /** Enable or disable private API message actions. */
    actions?: IMessageActionConfig;
    /** Optional default send service (imessage|sms|auto). */
    service?: "imessage" | "sms" | "auto";
    /** Preferred imsg RPC send transport. Default: auto. */
    sendTransport?: IMessageSendTransport;
    /** Optional default region (used when sending SMS). */
    region?: string;
    /** Include attachments + reactions in watch payloads. */
    includeAttachments?: boolean;
    /** Allowed local iMessage attachment roots (supports single-segment `*` wildcards). */
    attachmentRoots?: string[];
    /** Allowed remote iMessage attachment roots for SCP fetches (supports `*`). */
    remoteAttachmentRoots?: string[];
    /** Timeout for probe/RPC operations in milliseconds (default: 10000). */
    probeTimeoutMs?: number;
    /**
     * Merge consecutive same-sender DM rows from `chat.db` into a single agent
     * turn, so Apple's split-send (`<command> <URL>` arriving as two separate
     * rows several seconds apart) lands as one merged message. DM-only — group chats
     * keep instant per-message dispatch. Widens the default inbound debounce
     * window to 7000 ms when enabled without an explicit
     * `messages.inbound.byChannel.imessage` or global
     * `messages.inbound.debounceMs`. Default: `false`.
     */
    groups?: Record<
      string,
      {
        requireMention?: boolean;
        tools?: GroupToolPolicyConfig;
        toolsBySender?: GroupToolPolicyBySenderConfig;
        /**
         * Per-group system prompt. Injected into the agent's system prompt on
         * every turn that handles a message in that group. Matches the shape
         * already supported by Discord, Telegram, IRC, Slack, GoogleChat, and
         * other group-capable channels. The wildcard `groups["*"]` entry is
         * also honored.
         */
        systemPrompt?: string;
      }
    >;
    /**
     * Catchup: replay inbound messages that arrived in `chat.db` while the
     * gateway was offline (crash, restart, mac sleep). Disabled by default.
     * See https://github.com/openclaw/openclaw/issues/78649.
     */
    catchup?: {
      /** Master switch. Default `false`. */
      enabled?: boolean;
      /**
       * Maximum age of replayable messages in minutes. Messages older than
       * `now - maxAgeMinutes` are skipped even when the cursor is older.
       * Defense against runaway replay (the inverse of #62761). Default
       * `120` (2 h). Clamp `[1, 720]`.
       */
      maxAgeMinutes?: number;
      /**
       * Maximum messages to replay per catchup pass. Default `50`. Clamp
       * `[1, 500]`.
       */
      perRunLimit?: number;
      /**
       * On first run when no cursor exists, look back this many minutes.
       * Default `30`.
       */
      firstRunLookbackMinutes?: number;
      /**
       * Per-message retry ceiling. After this many consecutive failed
       * dispatch attempts against the same message guid, catchup logs a
       * `warn` and force-advances the cursor past the wedged message.
       * Default `10`. Clamp `[1, 1000]`.
       */
      maxFailureRetries?: number;
    };
  };

/** Top-level iMessage config, with optional account map layered over default account fields. */
export type IMessageConfig = {
  /** Optional per-account iMessage configuration (multi-account). */
  accounts?: Record<string, IMessageAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & IMessageAccountConfig;
