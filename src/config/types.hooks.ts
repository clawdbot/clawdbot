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
  channel?:
    | "last"
    | "whatsapp"
    | "telegram"
    | "discord"
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

export type InternalHooksConfig = {
  /** Enable internal hooks system */
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
