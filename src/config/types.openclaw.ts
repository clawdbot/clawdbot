// Defines the top-level OpenClaw configuration type.
import type { SilentReplyPolicyShape } from "../shared/silent-reply-policy.js";
import type { TranscriptsConfig } from "../transcripts/config.js";
import type { AccessGroupsConfig } from "./types.access-groups.js";
import type { AcpConfig } from "./types.acp.js";
import type { AgentBinding, AgentsConfig } from "./types.agents.js";
import type { ApprovalsConfig } from "./types.approvals.js";
import type { AuthConfig } from "./types.auth.js";
import type {
  AuditConfig,
  DiagnosticsConfig,
  LoggingConfig,
  SessionConfig,
  WebConfig,
} from "./types.base.js";
import type { BrowserConfig } from "./types.browser.js";
import type { ChannelsConfig } from "./types.channels.js";
import type { CliConfig } from "./types.cli.js";
import type { CloudWorkersConfig } from "./types.cloud-workers.js";
import type { CommitmentsConfig } from "./types.commitments.js";
import type { CrestodianConfig } from "./types.crestodian.js";
import type { CronConfig } from "./types.cron.js";
import type { DiscoveryConfig, GatewayConfig, TalkConfig } from "./types.gateway.js";
import type { HooksConfig } from "./types.hooks.js";
import type { MarketplacesConfig } from "./types.marketplaces.js";
import type { McpConfig } from "./types.mcp.js";
import type { MemoryConfig } from "./types.memory.js";
import type {
  AudioConfig,
  BroadcastConfig,
  CommandsConfig,
  MessagesConfig,
} from "./types.messages.js";
import type { ModelsConfig, ModelsConfigInput } from "./types.models.js";
import type { NodeHostConfig } from "./types.node-host.js";
import type { PluginsConfig } from "./types.plugins.js";
import type { SecretsConfig } from "./types.secrets.js";
import type { SkillsConfig } from "./types.skills.js";
import type { ToolsConfig } from "./types.tools.js";
import type { ProxyConfig } from "./zod-schema.proxy.js";

/** One persisted suppression for a known security audit finding. */
export type SecurityAuditSuppression = {
  /** Exact security audit check id to suppress. */
  checkId: string;
  /** Optional case-insensitive substring required in the finding title. */
  titleIncludes?: string;
  /** Optional case-insensitive substring required in the finding detail. */
  detailIncludes?: string;
  /** Operator rationale for accepting this standing finding. */
  reason?: string;
};

export type SecurityConfig = {
  /** Security audit policy and accepted standing findings. */
  audit?: {
    /** Accepted security audit findings to omit from active summary/findings. */
    suppressions?: SecurityAuditSuppression[];
  };
  installPolicy?: {
    /**
     * Enable operator-owned install policy. When true without an exec command,
     * install/update attempts fail closed for supported targets.
     */
    enabled?: boolean;
    /** Supported install targets. Omit to cover every supported target. */
    targets?: Array<"skill" | "plugin">;
    /**
     * Trusted local policy command. Transport intentionally mirrors exec
     * SecretRef provider fields: absolute command, no shell, bounded output,
     * explicit env allowlist, and secure path checks.
     */
    exec?: {
      source: "exec";
      command: string;
      args?: string[];
      timeoutMs?: number;
      noOutputTimeoutMs?: number;
      maxOutputBytes?: number;
      env?: Record<string, string>;
      passEnv?: string[];
      trustedDirs?: string[];
      allowInsecurePath?: boolean;
      allowSymlinkCommand?: boolean;
    };
  };
};

export type WorktreesConfig = {
  /** Retention limits enforced by hourly managed-worktree cleanup. */
  cleanup?: {
    /** Max managed worktrees to retain across all repositories; oldest evictable ones are snapshotted and removed first. 0 or unset disables the count limit. */
    maxCount?: number;
    /** Max total size in GB across all managed worktrees. 0 or unset disables the size limit. */
    maxTotalSizeGb?: number;
  };
};

export type SurfaceConfigEntry = {
  /** Surface-specific silent reply policy for channels or UI integrations. */
  silentReply?: SilentReplyPolicyShape;
};

/** Top-level OpenClaw config as read from user/project config files. */
export type OpenClawConfig = {
  /** JSON schema URL used by editors and generated config files. */
  $schema?: string;
  meta?: {
    /** Last OpenClaw version that wrote this config. */
    lastTouchedVersion?: string;
    /** ISO timestamp when this config was last written. */
    lastTouchedAt?: string;
  };
  /** Authentication provider/profile configuration. */
  auth?: AuthConfig;
  /** Named access groups used by channel/provider policy allowlists. */
  accessGroups?: AccessGroupsConfig;
  /** ACP integration settings. */
  acp?: AcpConfig;
  env?: {
    /** Opt-in: import missing secrets from a login shell environment (exec `$SHELL -l -c 'env -0'`). */
    shellEnv?: {
      enabled?: boolean;
      /** Timeout for the login shell exec (ms). Default: 15000. */
      timeoutMs?: number;
    };
    /** Inline env vars to apply when not already present in the process env. */
    vars?: Record<string, string>;
    /** Sugar: allow env vars directly under env (string values only). */
    [key: string]:
      | string
      | Record<string, string>
      | { enabled?: boolean; timeoutMs?: number }
      | undefined;
  };
  wizard?: {
    /** Last setup wizard completion timestamp. */
    lastRunAt?: string;
    /** OpenClaw version used by the last completed wizard run. */
    lastRunVersion?: string;
    /** Git commit used by the last completed wizard run, when available. */
    lastRunCommit?: string;
    /** Command that invoked the last wizard run. */
    lastRunCommand?: string;
    /** Whether the last wizard run configured a local or remote install. */
    lastRunMode?: "local" | "remote";
    /** ISO timestamp when the setup security acknowledgement was accepted on this config. */
    securityAcknowledgedAt?: string;
  };
  /** Diagnostics, tracing, and stability debugging settings. */
  diagnostics?: DiagnosticsConfig;
  /** Log sink, level, rotation, and redaction settings. */
  logging?: LoggingConfig;
  /** Metadata-only agent activity audit ledger settings. */
  audit?: AuditConfig;
  /** Security audit suppressions and security policy settings. */
  security?: SecurityConfig;
  /** CLI defaults and command-specific settings. */
  cli?: CliConfig;
  /** Crestodian rescue/maintenance integration settings. */
  crestodian?: CrestodianConfig;
  update?: {
    /** Update channel for git + npm installs ("stable", "extended-stable", "beta", or "dev"). */
    channel?: "stable" | "extended-stable" | "beta" | "dev";
    /** Check for updates on gateway start (npm installs only). */
    checkOnStart?: boolean;
    /** Core auto-update policy for package installs. */
    auto?: {
      /** Enable background auto-update checks and apply logic. Default: false. */
      enabled?: boolean;
      /** Stable channel minimum delay before auto-apply. Default: 6. */
      stableDelayHours?: number;
      /** Additional stable-channel jitter window. Default: 12. */
      stableJitterHours?: number;
      /** Beta channel check cadence. Default: 1 hour. */
      betaCheckIntervalHours?: number;
    };
  };
  /** Browser automation and browser plugin integration settings. */
  browser?: BrowserConfig;
  ui?: {
    /** Accent color for OpenClaw UI chrome (hex). */
    seamColor?: string;
    assistant?: {
      /** Assistant display name for UI surfaces. */
      name?: string;
      /** Assistant avatar (emoji, short text, or image URL/data URI). */
      avatar?: string;
    };
  };
  /** Terminal UI display settings. */
  tui?: {
    /** Footer display settings for the terminal UI. */
    footer?: {
      /** Show the remote Gateway hostname in the footer for non-local URL-backed connections. */
      showRemoteHost?: boolean;
    };
  };
  /** Secret providers, defaults, and ref-resolution settings. */
  secrets?: SecretsConfig;
  /** Marketplace feed and local package source profile configuration. */
  marketplaces?: MarketplacesConfig;
  /** Skill loading and bundled skill configuration. */
  skills?: SkillsConfig;
  /** Plugin registry/install/runtime configuration. */
  plugins?: PluginsConfig;
  /** Per-surface policy keyed by channel/UI/runtime surface id. */
  surfaces?: Record<string, SurfaceConfigEntry>;
  /** Model providers, model catalog, pricing, and catalog merge policy. */
  models?: ModelsConfig;
  /** Node-host pairing and remote command node settings. */
  nodeHost?: NodeHostConfig;
  /** Agent definitions, defaults, bindings, and runtime policy. */
  agents?: AgentsConfig;
  /** Tool exposure, policy, web/media tools, exec, and code-mode settings. */
  tools?: ToolsConfig;
  /** Legacy/direct agent bindings used by runtime resolution. */
  bindings?: AgentBinding[];
  /** Broadcast command and delivery settings. */
  broadcast?: BroadcastConfig;
  /** Audio command and media handling settings. */
  audio?: AudioConfig;
  media?: {
    /** Preserve original uploaded filenames when storing inbound media. */
    preserveFilenames?: boolean;
    /** Optional retention window for persisted inbound media cleanup. */
    ttlHours?: number;
  };
  /** Message formatting, delivery, and action settings. */
  messages?: MessagesConfig;
  /** Chat command settings. */
  commands?: CommandsConfig;
  /** Human approval workflow settings. */
  approvals?: ApprovalsConfig;
  /** Session keying, reset, maintenance, send-policy, and thread-binding settings. */
  session?: SessionConfig;
  /** Web runtime settings, including WhatsApp web transport controls. */
  web?: WebConfig;
  /** Channel defaults, built-in channel sections, and plugin-owned channel config. */
  channels?: ChannelsConfig;
  /** Cron schedule and retention settings. */
  cron?: CronConfig;
  /** Managed worktree retention settings. */
  worktrees?: WorktreesConfig;
  /** Transcript persistence and export settings. */
  transcripts?: TranscriptsConfig;
  /** Commitment/reminder extraction settings. */
  commitments?: CommitmentsConfig;
  /** Runtime hook registration and queue behavior. */
  hooks?: HooksConfig;
  /** Network discovery and service advertisement settings. */
  discovery?: DiscoveryConfig;
  /** Voice/talk mode configuration. */
  talk?: TalkConfig;
  /** Gateway server, auth, UI, node-pairing, and dispatch settings. */
  gateway?: GatewayConfig;
  /** Opt-in cloud-worker provider profiles and stored lifetime policy. */
  cloudWorkers?: CloudWorkersConfig;
  /** Memory indexing/search configuration. */
  memory?: MemoryConfig;
  /** MCP client/server and Codex MCP approval configuration. */
  mcp?: McpConfig;
  /** Network-level SSRF protection via an operator-managed forward proxy. */
  proxy?: ProxyConfig;
};

/** Config input shape accepted before model provider defaults are fully materialized. */
export type OpenClawConfigInput = Omit<OpenClawConfig, "models"> & {
  models?: ModelsConfigInput;
};

declare const openClawConfigStateBrand: unique symbol;

type BrandedConfigState<TState extends string> = OpenClawConfig & {
  readonly [openClawConfigStateBrand]?: TState;
};

/** Authored config before include/env resolution and runtime defaults. */
export type SourceConfig = BrandedConfigState<"source">;
/** Source config after includes/env substitution, before runtime defaults. */
export type ResolvedSourceConfig = BrandedConfigState<"resolved-source">;
/** Runtime-materialized config with defaults/normalization applied. */
export type RuntimeConfig = BrandedConfigState<"runtime">;

export type ConfigValidationIssue = {
  /** Dot-path to the invalid or legacy config value. */
  path: string;
  /** Human-readable validation message. */
  message: string;
  /** Optional allowed values shown to the operator. */
  allowedValues?: string[];
  /** Number of allowed values omitted from the display list. */
  allowedValuesHiddenCount?: number;
};

export type LegacyConfigIssue = {
  /** Dot-path to the legacy config value. */
  path: string;
  /** Human-readable migration or rejection message. */
  message: string;
};

export type ConfigFileSnapshot = {
  /** Config file path that was read. */
  path: string;
  /** Whether the config file exists on disk. */
  exists: boolean;
  /** Raw file contents before parsing; null when missing. */
  raw: string | null;
  /** Parsed JSON/JSONC/YAML value before schema normalization. */
  parsed: unknown;
  /**
   * Config authored on disk after $include resolution and ${ENV} substitution,
   * but BEFORE runtime defaults are applied.
   */
  sourceConfig: ResolvedSourceConfig;
  /**
   * Config after $include resolution and ${ENV} substitution, but BEFORE runtime
   * defaults are applied. Use this for config set/unset operations to avoid
   * leaking runtime defaults into the written config file.
   */
  resolved: ResolvedSourceConfig;
  valid: boolean;
  /** Runtime-shaped config used by in-process readers. */
  runtimeConfig: RuntimeConfig;
  /** @deprecated Prefer runtimeConfig. */
  config: RuntimeConfig;
  hash?: string;
  readError?: { code: string | null };
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  legacyIssues: LegacyConfigIssue[];
};
