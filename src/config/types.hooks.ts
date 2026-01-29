export type HookMappingMatch = {
  path?: string;
  source?: string;
};

export type HookMappingTransform = {
  module: string;
  export?: string;
};

export type HookMappingConfig = {
  id?: string;
  match?: HookMappingMatch;
  action?: "wake" | "agent";
  wakeMode?: "now" | "next-heartbeat";
  name?: string;
  sessionKey?: string;
  messageTemplate?: string;
  textTemplate?: string;
  deliver?: boolean;
  /** DANGEROUS: Disable external content safety wrapping for this hook. */
  allowUnsafeExternalContent?: boolean;
  channel?:
    | "last"
    | "whatsapp"
    | "telegram"
    | "discord"
    | "googlechat"
    | "slack"
    | "signal"
    | "imessage"
    | "msteams";
  to?: string;
  /** Override model for this hook (provider/model or alias). */
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  transform?: HookMappingTransform;
};

export type HooksGmailTailscaleMode = "off" | "serve" | "funnel";

export type HooksGmailConfig = {
  account?: string;
  label?: string;
  topic?: string;
  subscription?: string;
  pushToken?: string;
  hookUrl?: string;
  includeBody?: boolean;
  maxBytes?: number;
  renewEveryMinutes?: number;
  /** DANGEROUS: Disable external content safety wrapping for Gmail hooks. */
  allowUnsafeExternalContent?: boolean;
  serve?: {
    bind?: string;
    port?: number;
    path?: string;
  };
  tailscale?: {
    mode?: HooksGmailTailscaleMode;
    path?: string;
    /** Optional tailscale serve/funnel target (port, host:port, or full URL). */
    target?: string;
  };
  /** Optional model override for Gmail hook processing (provider/model or alias). */
  model?: string;
  /** Optional thinking level override for Gmail hook processing. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
};

export type InternalHookHandlerConfig = {
  /** Event key to listen for (e.g., 'command:new', 'session:start') */
  event: string;
  /** Path to handler module (absolute or relative to cwd) */
  module: string;
  /** Export name from module (default: 'default') */
  export?: string;
};

export type HookConfig = {
  enabled?: boolean;
  env?: Record<string, string>;
  [key: string]: unknown;
};

export type HookInstallRecord = {
  source: "npm" | "archive" | "path";
  spec?: string;
  sourcePath?: string;
  installPath?: string;
  version?: string;
  installedAt?: string;
  hooks?: string[];
};

/**
 * Conditions for matching inbound messages to handlers.
 * All specified conditions must match for the handler to trigger.
 */
export type MessageHandlerMatch = {
  /** Channel ID(s) to match (e.g., "whatsapp", "telegram", ["discord", "slack"]) */
  channelId?: string | string[];
  /** Conversation/chat ID(s) to match (e.g., group chat ID, DM ID) */
  conversationId?: string | string[];
  /** Sender identifier(s) to match (phone number, user ID, etc.) */
  from?: string | string[];
  /** Regex pattern to match against message content (case-insensitive) */
  contentPattern?: string;
  /** Keyword(s) to match in message content (case-insensitive) */
  contentContains?: string | string[];
};

/**
 * Config-driven message handler that triggers agent execution for matching messages.
 * Enables immediate processing of important messages without waiting for cron.
 */
export type MessageHandlerConfig = {
  /** Unique identifier for this handler */
  id: string;
  /** Whether this handler is enabled (default: true) */
  enabled?: boolean;
  /** Conditions that must match for this handler to trigger */
  match: MessageHandlerMatch;
  /** Action to take when matched */
  action: "agent";
  /** Which agent to use (default: route default) */
  agentId?: string;
  /** Custom session key (default: derived from handler id + channel + conversation) */
  sessionKey?: string;
  /** Priority: "immediate" bypasses queue, "queue" uses normal flow (default: "immediate") */
  priority?: "immediate" | "queue";
  /** Mode: "exclusive" = handler only, "parallel" = handler AND normal flow (default: "exclusive") */
  mode?: "exclusive" | "parallel";
  /** Text to prepend to the message content */
  messagePrefix?: string;
  /** Text to append to the message content */
  messageSuffix?: string;
  /** Full message template with placeholders: {{content}}, {{from}}, {{channelId}}, {{conversationId}} */
  messageTemplate?: string;
  /** Override model for this handler (provider/model or alias) */
  model?: string;
  /** Thinking level for the agent */
  thinking?: "off" | "low" | "medium" | "high";
  /** Timeout in seconds for agent execution */
  timeoutSeconds?: number;
};

export type InternalHooksConfig = {
  /** Enable hooks system */
  enabled?: boolean;
  /** Legacy: List of internal hook handlers to register (still supported) */
  handlers?: InternalHookHandlerConfig[];
  /** Per-hook configuration overrides */
  entries?: Record<string, HookConfig>;
  /** Load configuration */
  load?: {
    /** Additional hook directories to scan */
    extraDirs?: string[];
  };
  /** Install records for hook packs or hooks */
  installs?: Record<string, HookInstallRecord>;
  /** Config-driven message handlers for immediate agent execution */
  messageHandlers?: MessageHandlerConfig[];
};

export type HooksConfig = {
  enabled?: boolean;
  path?: string;
  token?: string;
  maxBodyBytes?: number;
  presets?: string[];
  transformsDir?: string;
  mappings?: HookMappingConfig[];
  gmail?: HooksGmailConfig;
  /** Internal agent event hooks */
  internal?: InternalHooksConfig;
};
