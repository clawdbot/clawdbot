import type {
  QueueDropPolicy,
  QueueMode,
  QueueModeByProvider,
} from "./types.queue.js";

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
  /** @deprecated Use tools.audio.transcription instead. */
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
   * - string: explicit prefix
   * - special value: `"auto"` derives `[{agents.list[].identity.name}]` for the routed agent (when set)
   * Default: none
   */
  responsePrefix?: string;
  groupChat?: GroupChatConfig;
  queue?: QueueConfig;
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
};
