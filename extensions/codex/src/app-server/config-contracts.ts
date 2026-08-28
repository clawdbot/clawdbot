import type { ProviderAuthAliasLookupParams } from "openclaw/plugin-sdk/agent-runtime";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";
import type { z } from "zod";
import type { CodexApprovalPolicy, CodexServiceTier, JsonObject } from "./protocol.js";
import type {
  codexDiscoveryConfigSchema,
  codexSessionCatalogConfigSchema,
} from "./session-discovery-config.js";

export type CodexAppServerTransportMode = "stdio" | "websocket" | "unix";
export type CodexAppServerHomeScope = "agent" | "user";
export type CodexAppServerPolicyMode = "yolo" | "guardian";
export type CodexAppServerConnectionClass = "local-loopback" | "remote";
export type CodexAppServerRemoteAppsSubstrate = "preconfigured";
export type OpenClawExecMode = "deny" | "allowlist" | "ask" | "auto" | "full";
export type OpenClawExecSecurity = "deny" | "allowlist" | "full";
export type OpenClawExecAsk = "off" | "on-miss" | "always";
export type OpenClawExecApprovalFloorsForCodexAppServer = {
  security?: OpenClawExecSecurity;
  ask?: OpenClawExecAsk;
};
export type OpenClawExecPolicyForCodexAppServer = {
  mode: OpenClawExecMode;
  security: OpenClawExecSecurity;
  ask: OpenClawExecAsk;
  touched: boolean;
};
export type OpenClawExecPolicy = OpenClawExecPolicyForCodexAppServer;
export type ProviderAuthAliasConfig = NonNullable<ProviderAuthAliasLookupParams>["config"];
export type CodexAppServerDefaultPolicy = {
  mode: CodexAppServerPolicyMode;
  approvalPolicy?: CodexAppServerManagedApprovalPolicy;
  approvalsReviewer?: CodexAppServerApprovalsReviewer;
  sandbox?: CodexAppServerSandboxMode;
  dangerFullAccessAllowed?: boolean;
};
export type CodexAppServerApprovalPolicy = "never" | "on-request";
export type CodexAppServerManagedApprovalPolicy = Extract<CodexApprovalPolicy, string>;
export type CodexAppServerApprovalPolicySource = "config" | "env" | "requirements" | "implicit";
export type CodexAppServerEffectiveApprovalPolicy = CodexApprovalPolicy;
export type CodexAppServerSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexAppServerApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
export type CodexAppServerCommandSource = "managed" | "resolved-managed" | "config" | "env";
export type CodexManagedCommandOrder = "package-first" | "desktop-first";
export type CodexDynamicToolsLoading = "searchable" | "direct";
export type CodexPluginDestructivePolicy = boolean | "auto" | "ask";
export type CodexPluginDestructiveApprovalMode = "allow" | "deny" | "auto" | "ask";

export const CODEX_PLUGINS_MARKETPLACE_NAME = "openai-curated";
export const CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME = "workspace-directory";
export const CODEX_PLUGIN_MARKETPLACE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export type CodexPluginMarketplaceName = string;

export type CodexComputerUseConfig = {
  enabled?: boolean;
  autoInstall?: boolean;
  marketplaceDiscoveryTimeoutMs?: number;
  liveTestTimeoutMs?: number;
  toolCallTimeoutMs?: number;
  healthCheckEnabled?: boolean;
  healthCheckIntervalMinutes?: number;
  pluginCacheMode?: "shared" | "independent";
  strictReadiness?: boolean;
  autoRepair?: boolean;
  marketplaceSource?: string;
  marketplacePath?: string;
  marketplaceName?: string;
  pluginName?: string;
  mcpServerName?: string;
};

export type ResolvedCodexComputerUseConfig = {
  enabled: boolean;
  autoInstall: boolean;
  marketplaceDiscoveryTimeoutMs: number;
  liveTestTimeoutMs: number;
  toolCallTimeoutMs: number;
  healthCheckEnabled: boolean;
  healthCheckIntervalMinutes: 30 | 60 | 120 | 240;
  pluginCacheMode: "shared" | "independent";
  strictReadiness: boolean;
  autoRepair: boolean;
  pluginName: string;
  mcpServerName: string;
  marketplaceSource?: string;
  marketplacePath?: string;
  marketplaceName?: string;
};

type CodexPluginEntryConfig = {
  enabled?: boolean;
  marketplaceName?: string;
  pluginName?: string;
  allow_destructive_actions?: CodexPluginDestructivePolicy;
};

type CodexPluginsConfig = {
  enabled?: boolean;
  allow_all_plugins?: boolean;
  allow_destructive_actions?: CodexPluginDestructivePolicy;
  plugins?: Record<string, CodexPluginEntryConfig>;
};

export type CodexSupervisionEndpoint =
  | {
      id?: string;
      label?: string;
      transport?: "stdio-proxy";
      command?: string;
      args?: string[];
      cwd?: string;
    }
  | {
      id?: string;
      label?: string;
      transport: "websocket";
      url: string;
      authTokenEnv?: string;
    };

type CodexSupervisionConfig = {
  enabled?: boolean;
  endpoints?: CodexSupervisionEndpoint[];
  allowRawTranscripts?: boolean;
  allowWriteControls?: boolean;
};

type CodexAppServerExperimentalConfig = {
  sandboxExecServer?: boolean;
};

type CodexAppServerNetworkProxyDomainPermission = "allow" | "deny";
type CodexAppServerNetworkProxyUnixSocketPermission = "allow" | "none";
type CodexAppServerNetworkProxyBaseProfile = "read-only" | "workspace";
type CodexAppServerNetworkProxyMode = "limited" | "full";

export type CodexAppServerNetworkProxyConfig = {
  enabled?: boolean;
  profileName?: string;
  baseProfile?: CodexAppServerNetworkProxyBaseProfile;
  mode?: CodexAppServerNetworkProxyMode;
  domains?: Record<string, CodexAppServerNetworkProxyDomainPermission>;
  unixSockets?: Record<string, CodexAppServerNetworkProxyUnixSocketPermission>;
  proxyUrl?: string;
  socksUrl?: string;
  enableSocks5?: boolean;
  enableSocks5Udp?: boolean;
  allowUpstreamProxy?: boolean;
  allowLocalBinding?: boolean;
  dangerouslyAllowNonLoopbackProxy?: boolean;
  dangerouslyAllowAllUnixSockets?: boolean;
};

export type ResolvedCodexAppServerNetworkProxyConfig = {
  profileName: string;
  configFingerprint: string;
  configPatch: JsonObject;
};

export type ResolvedCodexPluginPolicy = {
  configKey: string;
  marketplaceName: CodexPluginMarketplaceName;
  pluginName: string;
  enabled: boolean;
  allowDestructiveActions: boolean;
  destructiveApprovalMode: CodexPluginDestructiveApprovalMode;
};

export type ResolvedCodexPluginsPolicy = {
  configured: boolean;
  enabled: boolean;
  allowAllPlugins: boolean;
  allowDestructiveActions: boolean;
  destructiveApprovalMode: CodexPluginDestructiveApprovalMode;
  pluginPolicies: ResolvedCodexPluginPolicy[];
};

export type CodexAppServerStartOptions = {
  transport: CodexAppServerTransportMode;
  homeScope?: CodexAppServerHomeScope;
  command: string;
  commandSource?: CodexAppServerCommandSource;
  /** Desktop-first is reserved for the macOS app process that owns Computer Use permissions. */
  managedCommandOrder?: CodexManagedCommandOrder;
  /** Native plugin names checked at the final managed spawn boundary. */
  managedComputerUsePluginNames?: string[];
  managedFallbackCommandPaths?: string[];
  args: string[];
  /** Process working directory for shipped Supervisor stdio endpoint compatibility. */
  cwd?: string;
  url?: string;
  authToken?: string;
  headers: Record<string, string>;
  env?: Record<string, string>;
  clearEnv?: string[];
};

export type CodexAppServerRuntimeOptions = {
  start: CodexAppServerStartOptions;
  connectionClass: CodexAppServerConnectionClass;
  remoteAppsSubstrate: CodexAppServerRemoteAppsSubstrate;
  remoteWorkspaceRoot?: string;
  codeModeOnly: boolean;
  loopDetectionPreToolUseRelay: boolean;
  requestTimeoutMs: number;
  turnCompletionIdleTimeoutMs: number;
  turnAssistantCompletionIdleTimeoutMs?: number;
  postToolRawAssistantCompletionIdleTimeoutMs?: number;
  approvalPolicy: CodexAppServerEffectiveApprovalPolicy;
  approvalPolicySource?: CodexAppServerApprovalPolicySource;
  sandbox: CodexAppServerSandboxMode;
  approvalsReviewer: CodexAppServerApprovalsReviewer;
  /** Prepared boundary for an explicit session permission mode. */
  sessionRoot?: string;
  serviceTier?: CodexServiceTier | null;
  networkProxy?: ResolvedCodexAppServerNetworkProxyConfig;
};

export type CodexModelBackedReviewerContext = {
  modelProvider?: string;
  model?: string;
  config?: ProviderAuthAliasConfig;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  codexConfigToml?: string | null;
  homeScope?: CodexAppServerHomeScope;
  codexArgs?: readonly string[];
};

export type CodexPluginConfig = {
  codexDynamicToolsLoading?: CodexDynamicToolsLoading;
  codexDynamicToolsExclude?: string[];
  sessionCatalog?: z.infer<typeof codexSessionCatalogConfigSchema>;
  discovery?: z.infer<typeof codexDiscoveryConfigSchema>;
  computerUse?: CodexComputerUseConfig;
  codexPlugins?: CodexPluginsConfig;
  supervision?: CodexSupervisionConfig;
  appServer?: {
    mode?: CodexAppServerPolicyMode;
    transport?: CodexAppServerTransportMode;
    homeScope?: CodexAppServerHomeScope;
    command?: string;
    args?: string[] | string;
    url?: string;
    authToken?: SecretInput;
    headers?: Record<string, SecretInput>;
    clearEnv?: string[];
    remoteWorkspaceRoot?: string;
    codeModeOnly?: boolean;
    loopDetectionPreToolUseRelay?: boolean;
    requestTimeoutMs?: number;
    turnCompletionIdleTimeoutMs?: number;
    turnAssistantCompletionIdleTimeoutMs?: number;
    postToolRawAssistantCompletionIdleTimeoutMs?: number;
    approvalPolicy?: CodexAppServerApprovalPolicy;
    sandbox?: CodexAppServerSandboxMode;
    approvalsReviewer?: CodexAppServerApprovalsReviewer;
    serviceTier?: CodexServiceTier | null;
    networkProxy?: CodexAppServerNetworkProxyConfig;
    defaultWorkspaceDir?: string;
    experimental?: CodexAppServerExperimentalConfig;
  };
};
