import type { QueueDropPolicy, QueueMode, QueueModeByProvider } from "./types.queue.js";

export type GroupChatConfig = {
  mentionPatterns?: string[];
  historyLimit?: number;
};

export type DmConfig = {
  historyLimit?: number;
};

export type QueueConfig = {
  mode?: QueueMode;
  byChannel?: QueueModeByProvider;
  debounceMs?: number;
  cap?: number;
  drop?: QueueDropPolicy;
};

export type InboundDebounceByProvider = {
  whatsapp?: number;
  telegram?: number;
  discord?: number;
  slack?: number;
  mattermost?: number;
  signal?: number;
  imessage?: number;
  msteams?: number;
  webchat?: number;
};

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

export type AudioConfig = {
  /** @deprecated Use tools.media.audio.models instead. */
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
   *
   * - string: explicit prefix (may include template variables)
   * - special value: `"auto"` derives `[{agents.list[].identity.name}]` for the routed agent (when set)
   *
   * Supported template variables (case-insensitive):
   * - `{model}` - short model name (e.g., `claude-opus-4-5`, `gpt-4o`)
   * - `{modelFull}` - full model identifier (e.g., `anthropic/claude-opus-4-5`)
   * - `{provider}` - provider name (e.g., `anthropic`, `openai`)
   * - `{thinkingLevel}` or `{think}` - current thinking level (`high`, `low`, `off`)
   * - `{identity.name}` or `{identityName}` - agent identity name
   *
   * Example: `"[{model} | think:{thinkingLevel}]"` → `"[claude-opus-4-5 | think:high]"`
   *
   * Unresolved variables remain as literal text (e.g., `{model}` if context unavailable).
   *
   * Default: none
   */
  responsePrefix?: string;
  groupChat?: GroupChatConfig;
  queue?: QueueConfig;
  /** Debounce rapid inbound messages per sender (global + per-channel overrides). */
  inbound?: InboundDebounceConfig;
  /** Emoji reaction used to acknowledge inbound messages (empty disables). */
  ackReaction?: string;
  /** When to send ack reactions. Default: "group-mentions". */
  ackReactionScope?: "group-mentions" | "group-all" | "direct" | "all";
  /** Remove ack reaction after reply is sent (default: false). */
  removeAckAfterReply?: boolean;
};

export type NativeCommandsSetting = boolean | "auto";

export type CommandsConfig = {
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
  /** Allow /debug command (default: false). */
  debug?: boolean;
  /** Allow restart commands/tools (default: false). */
  restart?: boolean;
  /** Enforce access-group allowlists/policies for commands (default: true). */
  useAccessGroups?: boolean;
};

export type ProviderCommandsConfig = {
  /** Override native command registration for this provider (bool or "auto"). */
  native?: NativeCommandsSetting;
  /** Override native skill command registration for this provider (bool or "auto"). */
  nativeSkills?: NativeCommandsSetting;
};
