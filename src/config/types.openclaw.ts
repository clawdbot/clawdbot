import type {
  SilentReplyPolicyShape,
  SilentReplyRewriteShape,
} from "../shared/silent-reply-policy.js";
import type { AccessGroupsConfig } from "./types.access-groups.js";
import type { AcpConfig } from "./types.acp.js";
import type { AgentBinding, AgentsConfig } from "./types.agents.js";
import type { ApprovalsConfig } from "./types.approvals.js";
import type { AuthConfig } from "./types.auth.js";
import type { DiagnosticsConfig, LoggingConfig, SessionConfig, WebConfig } from "./types.base.js";
import type { BrowserConfig } from "./types.browser.js";
import type { ChannelsConfig } from "./types.channels.js";
import type { CliConfig } from "./types.cli.js";
import type { CommitmentsConfig } from "./types.commitments.js";
import type { CrestodianConfig } from "./types.crestodian.js";
import type { CronConfig } from "./types.cron.js";
import type { DiscoveryConfig, GatewayConfig, TalkConfig } from "./types.gateway.js";
import type { HooksConfig } from "./types.hooks.js";
import type { McpConfig } from "./types.mcp.js";
import type { MemoryConfig } from "./types.memory.js";
import type {
  AudioConfig,
  BroadcastConfig,
  CommandsConfig,
  MessagesConfig,
} from "./types.messages.js";
import type { ModelsConfig } from "./types.models.js";
import type { NodeHostConfig } from "./types.node-host.js";
import type { PluginsConfig } from "./types.plugins.js";
import type { SecretsConfig } from "./types.secrets.js";
import type { SkillsConfig } from "./types.skills.js";
import type { ToolsConfig } from "./types.tools.js";
import type { ProxyConfig } from "./zod-schema.proxy.js";

export type SurfaceConfigEntry = {
  silentReply?: SilentReplyPolicyShape;
  silentReplyRewrite?: SilentReplyRewriteShape;
};

export type OpenClawConfig = {
  $schema?: string;
  meta?: {
    /** Last OpenClaw version that wrote this config. */
    lastTouchedVersion?: string;
    /** ISO timestamp when this config was last written. */
    lastTouchedAt?: string;
  };
  auth?: AuthConfig;
  accessGroups?: AccessGroupsConfig;
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
    lastRunAt?: string;
    lastRunVersion?: string;
    lastRunCommit?: string;
    lastRunCommand?: string;
    lastRunMode?: "local" | "remote";
  };
  diagnostics?: DiagnosticsConfig;
  logging?: LoggingConfig;
  cli?: CliConfig;
  crestodian?: CrestodianConfig;
  update?: {
    /** Update channel for git + npm installs ("stable", "beta", or "dev"). */
    channel?: "stable" | "beta" | "dev";
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
  secrets?: SecretsConfig;
  skills?: SkillsConfig;
  plugins?: PluginsConfig;
  surfaces?: Record<string, SurfaceConfigEntry>;
  models?: ModelsConfig;
  nodeHost?: NodeHostConfig;
  agents?: AgentsConfig;
  tools?: ToolsConfig;
  bindings?: AgentBinding[];
  broadcast?: BroadcastConfig;
  audio?: AudioConfig;
  media?: {
    /** Preserve original uploaded filenames when storing inbound media. */
    preserveFilenames?: boolean;
    /** Optional retention window for persisted inbound media cleanup. */
    ttlHours?: number;
  };
  messages?: MessagesConfig;
  commands?: CommandsConfig;
  approvals?: ApprovalsConfig;
  session?: SessionConfig;
  web?: WebConfig;
  channels?: ChannelsConfig;
  cron?: CronConfig;
  commitments?: CommitmentsConfig;
  hooks?: HooksConfig;
  discovery?: DiscoveryConfig;
  talk?: TalkConfig;
  gateway?: GatewayConfig;
  memory?: MemoryConfig;
  mcp?: McpConfig;
  /** Network-level SSRF protection via an operator-managed forward proxy. */
  proxy?: ProxyConfig;
};

declare const openClawConfigStateBrand: unique symbol;

type BrandedConfigState<TState extends string> = OpenClawConfig & {
  readonly [openClawConfigStateBrand]?: TState;
};

export type SourceConfig = BrandedConfigState<"source">;
export type ResolvedSourceConfig = BrandedConfigState<"resolved-source">;
export type RuntimeConfig = BrandedConfigState<"runtime">;

export type ConfigValidationIssue = {
  path: string;
  message: string;
  allowedValues?: string[];
  allowedValuesHiddenCount?: number;
};

export type LegacyConfigIssue = {
  path: string;
  message: string;
};

export type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
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
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  legacyIssues: LegacyConfigIssue[];
};
