// Defines message queue and delivery configuration types.
import type { QueueDropPolicy, QueueMode, QueueModeByProvider } from "./types.queue.js";

export type MentionPatternsMode = "allow" | "deny";

export type MentionPatternsPolicyConfig = {
  mode?: MentionPatternsMode;
  allowIn?: string[];
  denyIn?: string[];
};

export type GroupChatConfig = {
  mentionPatterns?: string[];
  historyLimit?: number;
  /**
   * Controls how unmentioned always-on group chatter is submitted.
   * Default: "user_request".
   */
  unmentionedInbound?: "user_request" | "room_event";
  /**
   * Controls how group/channel inbound events produce model-authored room replies.
   * The message-tool mode requires explicit message sends for normal assistant
   * output; explicitly host-owned runtime output remains deliverable except for
   * ambient room events.
   * Default: "automatic".
   */
  visibleReplies?: "automatic" | "message_tool";
};

export type DmConfig = {
  historyLimit?: number;
};

export type QueueConfig = {
  mode?: QueueMode;
  byChannel?: QueueModeByProvider;
  /** Per-channel debounce overrides (ms). */
  debounceMsByChannel?: InboundDebounceByProvider;
  cap?: number;
  drop?: QueueDropPolicy;
};

export type InboundDebounceByProvider = Record<string, number>;

export type InboundDebounceConfig = {
  debounceMs?: number;
  byChannel?: InboundDebounceByProvider;
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

export type StatusReactionsConfig = {
  /** Enable lifecycle status reactions (default: false). */
  enabled?: boolean;
};

export type MessagesConfig = {
  /** @deprecated Doctor-only legacy input. */
  removeAckAfterReply?: boolean;
  /**
   * Controls how source inbound events produce visible replies across direct,
   * group, and channel conversations. Group/channel events still default to
   * `groupChat.visibleReplies` when it is set.
   *
   * Default: "automatic". In group/channel rooms, "message_tool" keeps normal
   * assistant output private unless the model sends visibly through the message
   * tool; explicitly host-owned runtime output remains deliverable.
   */
  visibleReplies?: "automatic" | "message_tool";
  /**
   * Prefix auto-added to all outbound replies.
   *
   * - string: explicit prefix (may include template variables)
   * - special value: `"auto"` derives `[{agents.list[].identity.name}]` for the routed agent (when set)
   *
   * Supported template variables (case-insensitive):
   * - `{model}` - short model name (e.g., `claude-opus-4-6`, `gpt-4o`)
   * - `{modelFull}` - full model identifier (e.g., `anthropic/claude-opus-4-6`)
   * - `{provider}` - provider name (e.g., `anthropic`, `openai`)
   * - `{thinkingLevel}` or `{think}` - current thinking level (`high`, `low`, `off`)
   * - `{identity.name}` or `{identityName}` - agent identity name
   *
   * Example: `"[{model} | think:{thinkingLevel}]"` → `"[claude-opus-4-6 | think:high]"`
   *
   * Unresolved variables remain as literal text (e.g., `{model}` if context unavailable).
   *
   * Default: none
   */
  responsePrefix?: string;
  /** Custom `/usage full` footer template, inline or JSON file path. */
  usageTemplate?: string | Record<string, unknown>;
  /**
   * Default per-reply usage footer mode (`responseUsage`) seeded into any session
   * that has not set its own via `/usage`. Precedence: session value → channel entry
   * → `default` → `off`. Absent ⇒ `off` (unchanged behavior).
   *
   * - string: one default for every channel, e.g. `"full"`.
   * - object: per-channel with a fallback, e.g. `{ "default": "off", "discord": "full" }`.
   */
  responseUsage?:
    | "on"
    | "off"
    | "tokens"
    | "full"
    | {
        default?: "on" | "off" | "tokens" | "full";
        [channel: string]: "on" | "off" | "tokens" | "full" | undefined;
      };
  groupChat?: GroupChatConfig;
  queue?: QueueConfig;
  /** Debounce rapid inbound messages per sender (global + per-channel overrides). */
  inbound?: InboundDebounceConfig;
  /** Emoji reaction used to acknowledge inbound messages (empty disables). */
  ackReaction?: string;
  /** When to send ack reactions. Default: "group-mentions". */
  ackReactionScope?: "group-mentions" | "group-all" | "direct" | "all" | "off" | "none";
  /** Lifecycle status reactions configuration. */
  statusReactions?: StatusReactionsConfig;
  /** When true, suppress ⚠️ tool-error warnings from being shown to the user. Default: false. */
  suppressToolErrors?: boolean;
};

export type NativeCommandsSetting = boolean | "auto";

/**
 * Per-provider allowlist for command authorization.
 * Keys are channel IDs (e.g., "discord", "whatsapp") or "*" for global default.
 * Values are arrays of sender IDs allowed to use commands on that channel.
 */
export type CommandAllowFrom = Record<string, Array<string | number>>;

export type CommandsConfig = {
  /** @deprecated Doctor-only legacy input. */
  ownerDisplay?: "raw" | "hash";
  /** @deprecated Doctor-only legacy input. */
  ownerDisplaySecret?: string;
  /** Enable native command registration when supported (default: "auto"). */
  native?: NativeCommandsSetting;
  /** Enable native skill command registration when supported (default: "auto"). */
  nativeSkills?: NativeCommandsSetting;
  /** Enable text command parsing (default: true). */
  text?: boolean;
  /** Allow bash chat command (`!`; `/bash` alias) (default: false). */
  bash?: boolean;
  /** How long bash waits before backgrounding (default: 2000; 0 backgrounds immediately). */
  bashForegroundMs?: number;
  /** Allow /config command (default: false). */
  config?: boolean;
  /** Allow /mcp command for OpenClaw-managed MCP settings (default: false). */
  mcp?: boolean;
  /** Allow /plugins command for plugin listing and enablement toggles (default: false). */
  plugins?: boolean;
  /** Allow /debug command (default: false). */
  debug?: boolean;
  /** Allow restart commands/tools (default: true). */
  restart?: boolean;
  /** Explicit owner allowlist for owner-scoped commands (channel-native IDs). */
  ownerAllowFrom?: Array<string | number>;
  /** How owner IDs are rendered in system prompts. */
  /**
   * Per-provider allowlist restricting who can use slash commands.
   * If set, overrides the channel's allowFrom for command authorization.
   * Use "*" key for global default, provider-specific keys override the global.
   * Example: { "*": ["user1"], discord: ["user:123"] }
   */
  allowFrom?: CommandAllowFrom;
};

export type ProviderCommandsConfig = {
  /** Override native command registration for this provider (bool or "auto"). */
  native?: NativeCommandsSetting;
  /** Override native skill command registration for this provider (bool or "auto"). */
  nativeSkills?: NativeCommandsSetting;
};
