import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { detectWindowsSpawnCommandInlineArgs } from "openclaw/plugin-sdk/windows-spawn";
import { z } from "zod";
import {
  CODEX_PLUGIN_MARKETPLACE_NAME_PATTERN,
  type CodexAppServerCommandSource,
  type CodexPluginConfig,
  type CodexPluginDestructiveApprovalMode,
  type CodexPluginDestructivePolicy,
  type CodexPluginMarketplaceName,
  type ResolvedCodexPluginPolicy,
  type ResolvedCodexPluginsPolicy,
} from "./config-contracts.js";
import { normalizeCodexServiceTier } from "./config-utils.js";
import {
  codexDiscoveryConfigSchema,
  codexSessionCatalogConfigSchema,
} from "./session-discovery-config.js";

export const DEFAULT_CODEX_COMPUTER_USE_PLUGIN_NAME = "computer-use";
export const DEFAULT_CODEX_COMPUTER_USE_MCP_SERVER_NAME = "computer-use";
export const DEFAULT_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS = 60_000;
export const DEFAULT_CODEX_COMPUTER_USE_LIVE_TEST_TIMEOUT_MS = 60_000;
export const DEFAULT_CODEX_COMPUTER_USE_TOOL_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_CODEX_COMPUTER_USE_HEALTH_CHECK_INTERVAL_MINUTES = 60;
export const DEFAULT_CODEX_APP_SERVER_NETWORK_PROXY_PROFILE_PREFIX = "openclaw-network";

const codexAppServerTransportSchema = z.enum(["stdio", "websocket", "unix"]);
const codexAppServerHomeScopeSchema = z.enum(["agent", "user"]);
const SecretInputSchema = buildSecretInputSchema();
const codexAppServerPolicyModeSchema = z.enum(["yolo", "guardian"]);
const codexAppServerApprovalPolicySchema = z.preprocess(
  (value) => (value === "on-failure" ? "on-request" : value),
  z.enum(["never", "on-request"]),
);
const codexAppServerSandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const codexAppServerApprovalsReviewerSchema = z.enum(["user", "auto_review", "guardian_subagent"]);
const codexDynamicToolsLoadingSchema = z.enum(["searchable", "direct"]);
const codexComputerUseHealthIntervalSchema = z.union([
  z.literal(30),
  z.literal(60),
  z.literal(120),
  z.literal(240),
]);
const codexComputerUsePluginCacheModeSchema = z.enum(["shared", "independent"]);
const codexPluginDestructivePolicySchema = z.union([
  z.boolean(),
  z.literal("auto"),
  z.literal("ask"),
]);
const codexAppServerServiceTierSchema = z
  .preprocess(
    (value) => (value === null ? null : normalizeCodexServiceTier(value)),
    z.string().trim().min(1).nullable().optional(),
  )
  .optional();
const codexAppServerExperimentalSchema = z
  .object({
    sandboxExecServer: z.boolean().optional(),
  })
  .strict();
const codexAppServerRemoteWorkspaceRootSchema = z.string().trim().min(1);
const codexAppServerNetworkProxyDomainPermissionSchema = z.enum(["allow", "deny"]);
const codexAppServerNetworkProxyUnixSocketPermissionSchema = z.enum(["allow", "none"]);
const codexAppServerNetworkProxySchema = z
  .object({
    enabled: z.boolean().optional(),
    profileName: z.string().trim().min(1).optional(),
    baseProfile: z.enum(["read-only", "workspace"]).optional(),
    mode: z.enum(["limited", "full"]).optional(),
    domains: z.record(z.string(), codexAppServerNetworkProxyDomainPermissionSchema).optional(),
    unixSockets: z
      .record(z.string(), codexAppServerNetworkProxyUnixSocketPermissionSchema)
      .optional(),
    proxyUrl: z.string().trim().min(1).optional(),
    socksUrl: z.string().trim().min(1).optional(),
    enableSocks5: z.boolean().optional(),
    enableSocks5Udp: z.boolean().optional(),
    allowUpstreamProxy: z.boolean().optional(),
    allowLocalBinding: z.boolean().optional(),
    dangerouslyAllowNonLoopbackProxy: z.boolean().optional(),
    dangerouslyAllowAllUnixSockets: z.boolean().optional(),
  })
  .strict();

const codexPluginEntryConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    marketplaceName: z.string().regex(CODEX_PLUGIN_MARKETPLACE_NAME_PATTERN).optional(),
    pluginName: z.string().trim().min(1).optional(),
    allow_destructive_actions: codexPluginDestructivePolicySchema.optional(),
  })
  .strict();

const codexPluginsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    allow_all_plugins: z.boolean().optional(),
    allow_destructive_actions: codexPluginDestructivePolicySchema.optional(),
    plugins: z.record(z.string(), codexPluginEntryConfigSchema).optional(),
  })
  .strict();

const codexSupervisionEndpointSchema = z.union([
  z
    .object({
      id: z.string().optional(),
      label: z.string().optional(),
      transport: z.literal("stdio-proxy").optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().optional(),
      label: z.string().optional(),
      transport: z.literal("websocket"),
      url: z.string(),
      authTokenEnv: z.string().optional(),
    })
    .strict(),
]);

const codexSupervisionConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    endpoints: z.array(codexSupervisionEndpointSchema).optional(),
    allowRawTranscripts: z.boolean().optional(),
    allowWriteControls: z.boolean().optional(),
  })
  .strict();

const codexPluginConfigSchema = z
  .object({
    codexDynamicToolsLoading: codexDynamicToolsLoadingSchema.optional(),
    codexDynamicToolsExclude: z.array(z.string()).optional(),
    sessionCatalog: codexSessionCatalogConfigSchema.optional(),
    discovery: codexDiscoveryConfigSchema.optional(),
    computerUse: z
      .object({
        enabled: z.boolean().optional(),
        autoInstall: z.boolean().optional(),
        marketplaceDiscoveryTimeoutMs: z.number().positive().optional(),
        liveTestTimeoutMs: z.number().positive().optional(),
        toolCallTimeoutMs: z.number().positive().optional(),
        healthCheckEnabled: z.boolean().optional(),
        healthCheckIntervalMinutes: codexComputerUseHealthIntervalSchema.optional(),
        pluginCacheMode: codexComputerUsePluginCacheModeSchema.optional(),
        strictReadiness: z.boolean().optional(),
        autoRepair: z.boolean().optional(),
        marketplaceSource: z.string().optional(),
        marketplacePath: z.string().optional(),
        marketplaceName: z.string().optional(),
        pluginName: z.string().optional(),
        mcpServerName: z.string().optional(),
      })
      .strict()
      .optional(),
    codexPlugins: z.unknown().optional(),
    supervision: codexSupervisionConfigSchema.optional(),
    appServer: z
      .object({
        mode: codexAppServerPolicyModeSchema.optional(),
        transport: codexAppServerTransportSchema.optional(),
        homeScope: codexAppServerHomeScopeSchema.optional(),
        command: z.string().optional(),
        args: z.union([z.array(z.string()), z.string()]).optional(),
        url: z.string().optional(),
        authToken: SecretInputSchema.optional(),
        headers: z.record(z.string(), SecretInputSchema).optional(),
        clearEnv: z.array(z.string()).optional(),
        remoteWorkspaceRoot: codexAppServerRemoteWorkspaceRootSchema.optional(),
        codeModeOnly: z.boolean().optional(),
        loopDetectionPreToolUseRelay: z.boolean().optional(),
        requestTimeoutMs: z.number().positive().optional(),
        approvalPolicy: codexAppServerApprovalPolicySchema.optional(),
        sandbox: codexAppServerSandboxSchema.optional(),
        approvalsReviewer: codexAppServerApprovalsReviewerSchema.optional(),
        serviceTier: codexAppServerServiceTierSchema,
        networkProxy: codexAppServerNetworkProxySchema.optional(),
        defaultWorkspaceDir: z.string().optional(),
        experimental: codexAppServerExperimentalSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function readCodexPluginConfig(value: unknown): CodexPluginConfig {
  const appServer = asNullableRecord(asNullableRecord(value)?.appServer);
  if (appServer?.approvalPolicy === "untrusted") {
    throw new Error(
      'plugins.entries.codex.config.appServer.approvalPolicy="untrusted" is retired; run "openclaw doctor --fix" to migrate it to "on-request".',
    );
  }
  const parsed = codexPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    return {};
  }
  const { codexPlugins: rawCodexPlugins, ...config } = parsed.data;
  const plugins = codexPluginsConfigSchema.safeParse(rawCodexPlugins);
  if (!plugins.success) {
    return config;
  }
  return { ...config, ...(plugins.data ? { codexPlugins: plugins.data } : {}) };
}

export function isCodexSandboxExecServerEnabled(
  pluginConfig?: unknown,
  sandbox?: unknown,
): boolean {
  return (
    isCodexRemoteExecPlacementSandbox(sandbox) ||
    readCodexPluginConfig(pluginConfig).appServer?.experimental?.sandboxExecServer === true
  );
}

export function isCodexRemoteExecPlacementSandbox(sandbox: unknown): boolean {
  return (
    typeof sandbox === "object" &&
    sandbox !== null &&
    "placementExecutionMode" in sandbox &&
    sandbox.placementExecutionMode === "remote-exec"
  );
}

export function isCodexPairedNodeRemoteExecPlacementSandbox(sandbox: unknown): boolean {
  return (
    isCodexRemoteExecPlacementSandbox(sandbox) &&
    typeof sandbox === "object" &&
    sandbox !== null &&
    "placementNodeId" in sandbox &&
    typeof sandbox.placementNodeId === "string" &&
    sandbox.placementNodeId.length > 0
  );
}

export function assertCodexAppServerCommandHasNoInlineArgs(params: {
  command: string;
  source: CodexAppServerCommandSource;
}): void {
  const inlineArgs = detectWindowsSpawnCommandInlineArgs(params.command);
  if (!inlineArgs) {
    return;
  }
  const sourceLabel =
    params.source === "env"
      ? "OPENCLAW_CODEX_APP_SERVER_BIN"
      : "plugins.entries.codex.config.appServer.command";
  const argsLabel =
    params.source === "env"
      ? "OPENCLAW_CODEX_APP_SERVER_ARGS"
      : "plugins.entries.codex.config.appServer.args";
  throw new Error(
    `${sourceLabel} must be only the Codex app-server executable path; "${inlineArgs.executable}" was configured with inline arguments "${inlineArgs.arguments}". Move those arguments to ${argsLabel}, or remove the override to use the managed Codex startup path.`,
  );
}

export function resolveCodexPluginsPolicy(pluginConfig?: unknown): ResolvedCodexPluginsPolicy {
  const config = readCodexPluginConfig(pluginConfig).codexPlugins;
  const configured = config !== undefined;
  const enabled = config?.enabled === true;
  const destructivePolicy = resolveCodexPluginDestructivePolicy(
    config?.allow_destructive_actions ?? true,
  );
  const pluginPolicies = Object.entries(config?.plugins ?? {})
    .flatMap(([configKey, entry]): ResolvedCodexPluginPolicy[] => {
      if (!isCodexPluginMarketplaceName(entry.marketplaceName) || !entry.pluginName) {
        return [];
      }
      const entryDestructivePolicy = resolveCodexPluginDestructivePolicy(
        entry.allow_destructive_actions ?? config?.allow_destructive_actions ?? true,
      );
      return [
        {
          configKey,
          marketplaceName: entry.marketplaceName,
          pluginName: entry.pluginName,
          enabled: enabled && entry.enabled !== false,
          allowDestructiveActions: entryDestructivePolicy.allowDestructiveActions,
          destructiveApprovalMode: entryDestructivePolicy.destructiveApprovalMode,
        },
      ];
    })
    .toSorted((left, right) => left.configKey.localeCompare(right.configKey));
  return {
    configured,
    enabled,
    allowAllPlugins: enabled && config?.allow_all_plugins === true,
    allowDestructiveActions: destructivePolicy.allowDestructiveActions,
    destructiveApprovalMode: destructivePolicy.destructiveApprovalMode,
    pluginPolicies,
  };
}

function isCodexPluginMarketplaceName(
  value: string | undefined,
): value is CodexPluginMarketplaceName {
  return typeof value === "string" && CODEX_PLUGIN_MARKETPLACE_NAME_PATTERN.test(value);
}

function resolveCodexPluginDestructivePolicy(policy: CodexPluginDestructivePolicy): {
  allowDestructiveActions: boolean;
  destructiveApprovalMode: CodexPluginDestructiveApprovalMode;
} {
  if (policy === "auto" || policy === "ask") {
    return { allowDestructiveActions: true, destructiveApprovalMode: policy };
  }
  return {
    allowDestructiveActions: policy,
    destructiveApprovalMode: policy ? "allow" : "deny",
  };
}
