// Codex helper module supports config behavior.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir as readHomeDir, hostname as readHostName } from "node:os";
import path from "node:path";
import {
  resolveProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  resolveExecApprovalsFromFile,
  type ExecApprovalsFile,
} from "openclaw/plugin-sdk/exec-approvals-runtime";
import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  buildSecretInputSchema,
  normalizeResolvedSecretInputString,
  type SecretInput,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";
import { detectWindowsSpawnCommandInlineArgs } from "openclaw/plugin-sdk/windows-spawn";
import { z } from "zod";
import type {
  CodexApprovalPolicy,
  CodexSandboxPolicy,
  CodexServiceTier,
  JsonObject,
  JsonValue,
} from "./protocol.js";

const START_OPTIONS_KEY_SECRET_SYMBOL = Symbol.for("openclaw.codexAppServerStartOptionsKeySecret");
const START_OPTIONS_KEY_SECRET = getStartOptionsKeySecret();
const UNIX_CODEX_REQUIREMENTS_PATH = "/etc/codex/requirements.toml";
const WINDOWS_CODEX_REQUIREMENTS_SUFFIX = "\\OpenAI\\Codex\\requirements.toml";
const CODEX_APP_SERVER_HOME_DIRNAME = "codex-home";
const CODEX_CONFIG_TOML_FILENAME = "config.toml";
const PLAIN_DECIMAL_NUMBER_RE = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))$/;

type CodexAppServerTransportMode = "stdio" | "websocket";
export type CodexAppServerHomeScope = "agent" | "user";
type CodexAppServerPolicyMode = "yolo" | "guardian";
export type CodexAppServerConnectionClass = "local-loopback" | "remote";
export type CodexAppServerRemoteAppsSubstrate = "preconfigured";
type OpenClawExecMode = "deny" | "allowlist" | "ask" | "auto" | "full";
type OpenClawExecSecurity = "deny" | "allowlist" | "full";
type OpenClawExecAsk = "off" | "on-miss" | "always";
type OpenClawExecApprovalFloorsForCodexAppServer = {
  security?: OpenClawExecSecurity;
  ask?: OpenClawExecAsk;
};
export type OpenClawExecPolicyForCodexAppServer = {
  mode?: OpenClawExecMode;
  security: OpenClawExecSecurity;
  ask: OpenClawExecAsk;
  touched: boolean;
};
type OpenClawExecPolicy = OpenClawExecPolicyForCodexAppServer;
type ProviderAuthAliasConfig = NonNullable<ProviderAuthAliasLookupParams>["config"];
type CodexAppServerDefaultPolicy = {
  mode: CodexAppServerPolicyMode;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  approvalsReviewer?: CodexAppServerApprovalsReviewer;
  sandbox?: CodexAppServerSandboxMode;
  dangerFullAccessAllowed?: boolean;
};
export type CodexAppServerApprovalPolicy = "never" | "on-request" | "untrusted";
export type CodexAppServerApprovalPolicySource = "config" | "env" | "requirements" | "implicit";
export type CodexAppServerEffectiveApprovalPolicy = CodexApprovalPolicy;
export type CodexAppServerSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexAppServerApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
type CodexAppServerCommandSource = "managed" | "resolved-managed" | "config" | "env";
export type CodexDynamicToolsLoading = "searchable" | "direct";
export type CodexPluginDestructivePolicy = boolean | "auto" | "ask";
export type CodexPluginDestructiveApprovalMode = "allow" | "deny" | "auto" | "ask";

export const CODEX_PLUGINS_MARKETPLACE_NAME = "openai-curated";

export type CodexComputerUseConfig = {
  enabled?: boolean;
  autoInstall?: boolean;
  marketplaceDiscoveryTimeoutMs?: number;
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
  pluginName: string;
  mcpServerName: string;
  marketplaceSource?: string;
  marketplacePath?: string;
  marketplaceName?: string;
};

export type CodexPluginEntryConfig = {
  enabled?: boolean;
  marketplaceName?: string;
  pluginName?: string;
  allow_destructive_actions?: CodexPluginDestructivePolicy;
};

export type CodexPluginsConfig = {
  enabled?: boolean;
  allow_all_plugins?: boolean;
  allow_destructive_actions?: CodexPluginDestructivePolicy;
  plugins?: Record<string, CodexPluginEntryConfig>;
};

export type CodexAppServerExperimentalConfig = {
  sandboxExecServer?: boolean;
};

export type CodexAppServerNetworkProxyDomainPermission = "allow" | "deny";
export type CodexAppServerNetworkProxyUnixSocketPermission = "allow" | "none";
export type CodexAppServerNetworkProxyBaseProfile = "read-only" | "workspace";
export type CodexAppServerNetworkProxyMode = "limited" | "full";

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
  marketplaceName: typeof CODEX_PLUGINS_MARKETPLACE_NAME;
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
  managedFallbackCommandPaths?: string[];
  args: string[];
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
  requestTimeoutMs: number;
  turnCompletionIdleTimeoutMs: number;
  postToolRawAssistantCompletionIdleTimeoutMs?: number;
  approvalPolicy: CodexAppServerEffectiveApprovalPolicy;
  approvalPolicySource?: CodexAppServerApprovalPolicySource;
  sandbox: CodexAppServerSandboxMode;
  approvalsReviewer: CodexAppServerApprovalsReviewer;
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
};

export type CodexPluginConfig = {
  codexDynamicToolsLoading?: CodexDynamicToolsLoading;
  codexDynamicToolsExclude?: string[];
  discovery?: {
    enabled?: boolean;
    timeoutMs?: number;
  };
  computerUse?: CodexComputerUseConfig;
  codexPlugins?: CodexPluginsConfig;
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
    requestTimeoutMs?: number;
    turnCompletionIdleTimeoutMs?: number;
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

export function shouldAutoApproveCodexAppServerApprovals(
  appServer: Pick<CodexAppServerRuntimeOptions, "approvalPolicy" | "networkProxy" | "sandbox">,
): boolean {
  return (
    appServer.networkProxy === undefined &&
    appServer.approvalPolicy === "never" &&
    appServer.sandbox === "danger-full-access"
  );
}

export const CODEX_APP_SERVER_CONFIG_KEYS = [
  "mode",
  "transport",
  "homeScope",
  "command",
  "args",
  "url",
  "authToken",
  "headers",
  "clearEnv",
  "remoteWorkspaceRoot",
  "codeModeOnly",
  "requestTimeoutMs",
  "turnCompletionIdleTimeoutMs",
  "postToolRawAssistantCompletionIdleTimeoutMs",
  "approvalPolicy",
  "sandbox",
  "approvalsReviewer",
  "serviceTier",
  "networkProxy",
  "defaultWorkspaceDir",
  "experimental",
] as const;

export const CODEX_APP_SERVER_EXPERIMENTAL_CONFIG_KEYS = ["sandboxExecServer"] as const;

export const CODEX_COMPUTER_USE_CONFIG_KEYS = [
  "enabled",
  "autoInstall",
  "marketplaceDiscoveryTimeoutMs",
  "marketplaceSource",
  "marketplacePath",
  "marketplaceName",
  "pluginName",
  "mcpServerName",
] as const;

export const CODEX_PLUGINS_CONFIG_KEYS = [
  "enabled",
  "allow_all_plugins",
  "allow_destructive_actions",
  "plugins",
] as const;

export const CODEX_PLUGIN_ENTRY_CONFIG_KEYS = [
  "enabled",
  "marketplaceName",
  "pluginName",
  "allow_destructive_actions",
] as const;

const DEFAULT_CODEX_COMPUTER_USE_PLUGIN_NAME = "computer-use";
const DEFAULT_CODEX_COMPUTER_USE_MCP_SERVER_NAME = "computer-use";
const DEFAULT_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS = 60_000;
const DEFAULT_CODEX_APP_SERVER_NETWORK_PROXY_PROFILE_PREFIX = "openclaw-network";

const codexAppServerTransportSchema = z.enum(["stdio", "websocket"]);
const codexAppServerHomeScopeSchema = z.enum(["agent", "user"]);
const SecretInputSchema = buildSecretInputSchema();
const codexAppServerPolicyModeSchema = z.enum(["yolo", "guardian"]);
const codexAppServerApprovalPolicySchema = z.preprocess(
  // Preserve the rest of a shipped plugin config until doctor persists the
  // canonical value. Rejecting this field would discard the whole config.
  (value) => (value === "on-failure" ? "on-request" : value),
  z.enum(["never", "on-request", "untrusted"]),
);
const codexAppServerSandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const codexAppServerApprovalsReviewerSchema = z.enum(["user", "auto_review", "guardian_subagent"]);
const codexDynamicToolsLoadingSchema = z.enum(["searchable", "direct"]);
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
    marketplaceName: z.literal(CODEX_PLUGINS_MARKETPLACE_NAME).optional(),
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

const codexPluginConfigSchema = z
  .object({
    codexDynamicToolsLoading: codexDynamicToolsLoadingSchema.optional(),
    codexDynamicToolsExclude: z.array(z.string()).optional(),
    discovery: z
      .object({
        enabled: z.boolean().optional(),
        timeoutMs: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    computerUse: z
      .object({
        enabled: z.boolean().optional(),
        autoInstall: z.boolean().optional(),
        marketplaceDiscoveryTimeoutMs: z.number().positive().optional(),
        marketplaceSource: z.string().optional(),
        marketplacePath: z.string().optional(),
        marketplaceName: z.string().optional(),
        pluginName: z.string().optional(),
        mcpServerName: z.string().optional(),
      })
      .strict()
      .optional(),
    codexPlugins: z.unknown().optional(),
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
        requestTimeoutMs: z.number().positive().optional(),
        turnCompletionIdleTimeoutMs: z.number().positive().optional(),
        postToolRawAssistantCompletionIdleTimeoutMs: z.number().positive().optional(),
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

export function isCodexSandboxExecServerEnabled(pluginConfig?: unknown): boolean {
  return readCodexPluginConfig(pluginConfig).appServer?.experimental?.sandboxExecServer === true;
}

function assertCodexAppServerCommandHasNoInlineArgs(params: {
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
      if (entry.marketplaceName !== CODEX_PLUGINS_MARKETPLACE_NAME || !entry.pluginName) {
        return [];
      }
      const entryDestructivePolicy = resolveCodexPluginDestructivePolicy(
        entry.allow_destructive_actions ?? config?.allow_destructive_actions ?? true,
      );
      return [
        {
          configKey,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
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

export function resolveCodexAppServerRuntimeOptions(
  params: {
    pluginConfig?: unknown;
    execMode?: OpenClawExecMode;
    execPolicy?: OpenClawExecPolicyForCodexAppServer;
    modelProvider?: string;
    model?: string;
    config?: ProviderAuthAliasConfig;
    env?: NodeJS.ProcessEnv;
    agentDir?: string;
    codexConfigToml?: string | null;
    requirementsToml?: string | null;
    requirementsPath?: string;
    readRequirementsFile?: (path: string) => string | undefined;
    platform?: NodeJS.Platform;
    hostName?: string;
    openClawSandboxActive?: boolean;
  } = {},
): CodexAppServerRuntimeOptions {
  const env = params.env ?? process.env;
  const config = readCodexPluginConfig(params.pluginConfig).appServer ?? {};
  const transport = resolveTransport(config.transport);
  const homeScope: CodexAppServerHomeScope = config.homeScope === "user" ? "user" : "agent";
  const configCommand = readNonEmptyString(config.command);
  const envCommand = readNonEmptyString(env.OPENCLAW_CODEX_APP_SERVER_BIN);
  const command = configCommand ?? envCommand ?? "codex";
  const commandSource: CodexAppServerCommandSource = configCommand
    ? "config"
    : envCommand
      ? "env"
      : "managed";
  if (commandSource === "config" || commandSource === "env") {
    assertCodexAppServerCommandHasNoInlineArgs({ command, source: commandSource });
  }
  const args = resolveArgs(config.args, env.OPENCLAW_CODEX_APP_SERVER_ARGS);
  const headers = normalizeHeaders(config.headers);
  const clearEnv = normalizeStringList(config.clearEnv);
  const authToken = normalizeCodexAppServerSecretInput({
    value: config.authToken,
    path: "plugins.entries.codex.config.appServer.authToken",
  });
  const url = readNonEmptyString(config.url);
  const connectionClass = inferCodexAppServerConnectionClass({ transport, url });
  const remoteAppsSubstrate: CodexAppServerRemoteAppsSubstrate = "preconfigured";
  const remoteWorkspaceRoot = normalizeRemoteWorkspaceRoot(config.remoteWorkspaceRoot);
  const execMode = resolveEffectiveOpenClawExecModeForCodexAppServer({
    execMode: params.execMode,
    execPolicy: params.execPolicy,
  });
  assertCodexAppServerAllowedForOpenClawExecMode(execMode);
  const explicitPolicyMode =
    resolvePolicyMode(config.mode) ?? resolvePolicyMode(env.OPENCLAW_CODEX_APP_SERVER_MODE);
  const configuredSandbox =
    resolveSandbox(config.sandbox) ?? resolveSandbox(env.OPENCLAW_CODEX_APP_SERVER_SANDBOX);
  const explicitApprovalsReviewer = resolveApprovalsReviewer(config.approvalsReviewer);
  const normalizedPolicyMode = resolveCodexPolicyModeForOpenClawExecMode(execMode);
  const ignoreLegacyYoloPolicyMode =
    normalizedPolicyMode === "guardian" && explicitPolicyMode === "yolo";
  const canUseModelBackedReviewer = canUseCodexModelBackedApprovalsReviewerForModel({
    modelProvider: params.modelProvider,
    model: params.model,
    config: params.config,
    env,
    agentDir: params.agentDir,
    codexConfigToml: params.codexConfigToml,
    homeScope,
  });
  const explicitModelBackedReviewer =
    explicitApprovalsReviewer === "auto_review" ||
    explicitApprovalsReviewer === "guardian_subagent";
  const forceUserReviewerForUnknownModel =
    !canUseModelBackedReviewer &&
    (explicitModelBackedReviewer ||
      (explicitPolicyMode === "guardian" && explicitApprovalsReviewer !== "user"));
  const forceUserReviewerForExecMode =
    execMode !== undefined &&
    execMode !== "full" &&
    (execMode !== "auto" || !canUseModelBackedReviewer);
  const forceUserReviewer = forceUserReviewerForUnknownModel || forceUserReviewerForExecMode;
  const forceGuardianReviewer = execMode === "auto" && canUseModelBackedReviewer;
  const execModeRequiringPromptingApprovals: Extract<OpenClawExecMode, "auto" | "ask"> | undefined =
    execMode === "auto" || execMode === "ask" ? execMode : forceUserReviewer ? "ask" : undefined;
  const forceDangerFullAccessSandbox =
    params.execPolicy?.touched === true &&
    params.execPolicy.security === "full" &&
    params.execPolicy.ask === "always";
  const forceRuntimePolicy =
    forceUserReviewer || forceGuardianReviewer || forceDangerFullAccessSandbox;
  const defaultPolicy =
    explicitPolicyMode && !forceRuntimePolicy && !ignoreLegacyYoloPolicyMode
      ? undefined
      : resolveDefaultCodexAppServerPolicy({
          transport,
          env,
          forceGuardian: normalizedPolicyMode === "guardian",
          forceUserReviewer: forceUserReviewer || !canUseModelBackedReviewer,
          execModeRequiringPromptingApprovals,
          requirementsToml: params.requirementsToml,
          requirementsPath: params.requirementsPath,
          readRequirementsFile: params.readRequirementsFile,
          platform: params.platform,
          hostName: params.hostName,
          execModeRequiringUserReviewer: forceUserReviewer ? execMode : undefined,
        });
  const preserveExplicitAutoSandbox = forceGuardianReviewer && configuredSandbox === "read-only";
  const forcedPolicy = forceRuntimePolicy
    ? {
        approvalPolicy: defaultPolicy?.approvalPolicy ?? "on-request",
        sandbox: preserveExplicitAutoSandbox
          ? undefined
          : forceDangerFullAccessSandbox
            ? selectForcedDangerFullAccessSandbox({
                configuredSandbox,
                defaultPolicy,
                openClawSandboxActive: Boolean(params.openClawSandboxActive),
              })
            : selectForcedPromptingSandbox({
                configuredSandbox,
                defaultSandbox: defaultPolicy?.sandbox,
              }),
        approvalsReviewer:
          defaultPolicy?.approvalsReviewer ?? (forceUserReviewer ? "user" : "auto_review"),
      }
    : undefined;
  const policyMode = ignoreLegacyYoloPolicyMode
    ? normalizedPolicyMode
    : (explicitPolicyMode ?? normalizedPolicyMode ?? defaultPolicy?.mode ?? "yolo");
  const serviceTier = normalizeCodexServiceTier(config.serviceTier);
  const resolvedSandbox =
    forcedPolicy?.sandbox ??
    configuredSandbox ??
    defaultPolicy?.sandbox ??
    (policyMode === "guardian" ? "workspace-write" : "danger-full-access");
  if (transport === "websocket" && !url) {
    throw new Error(
      "plugins.entries.codex.config.appServer.url is required when appServer.transport is websocket",
    );
  }
  if (transport === "websocket" && homeScope === "user") {
    throw new Error(
      "plugins.entries.codex.config.appServer.homeScope=user requires appServer.transport=stdio",
    );
  }
  assertCodexAppServerConnectionClassConfig({
    connectionClass,
    authToken,
    headers,
  });

  const configApprovalPolicy = resolveApprovalPolicy(config.approvalPolicy);
  const envApprovalPolicy = resolveApprovalPolicy(env.OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY);
  const approvalPolicy =
    configApprovalPolicy ??
    envApprovalPolicy ??
    defaultPolicy?.approvalPolicy ??
    (policyMode === "guardian" ? "on-request" : "never");
  const approvalPolicySource: CodexAppServerApprovalPolicySource = configApprovalPolicy
    ? "config"
    : envApprovalPolicy
      ? "env"
      : defaultPolicy?.approvalPolicy
        ? "requirements"
        : "implicit";

  return {
    start: {
      transport,
      homeScope,
      command,
      commandSource,
      args: args.length > 0 ? args : ["app-server", "--listen", "stdio://"],
      ...(url ? { url } : {}),
      ...(authToken ? { authToken } : {}),
      headers,
      ...(transport === "stdio" && clearEnv.length > 0 ? { clearEnv } : {}),
    },
    connectionClass,
    remoteAppsSubstrate,
    ...(remoteWorkspaceRoot ? { remoteWorkspaceRoot } : {}),
    codeModeOnly: config.codeModeOnly === true,
    requestTimeoutMs: normalizePositiveNumber(config.requestTimeoutMs, 60_000),
    turnCompletionIdleTimeoutMs: normalizePositiveNumber(
      config.turnCompletionIdleTimeoutMs,
      60_000,
    ),
    ...(config.postToolRawAssistantCompletionIdleTimeoutMs !== undefined
      ? {
          postToolRawAssistantCompletionIdleTimeoutMs: normalizePositiveNumber(
            config.postToolRawAssistantCompletionIdleTimeoutMs,
            60_000,
          ),
        }
      : {}),
    approvalPolicy: forcedPolicy?.approvalPolicy ?? approvalPolicy,
    approvalPolicySource,
    sandbox: resolvedSandbox,
    approvalsReviewer:
      forcedPolicy?.approvalsReviewer ??
      explicitApprovalsReviewer ??
      defaultPolicy?.approvalsReviewer ??
      (policyMode === "guardian" ? "auto_review" : "user"),
    ...(serviceTier ? { serviceTier } : {}),
    ...resolveCodexAppServerNetworkProxy(config.networkProxy, resolvedSandbox),
  };
}

export function isCodexAppServerApprovalPolicyAllowedByRequirements(
  policy: CodexAppServerApprovalPolicy,
  params: {
    env?: NodeJS.ProcessEnv;
    requirementsToml?: string | null;
    requirementsPath?: string;
    readRequirementsFile?: (path: string) => string | undefined;
    platform?: NodeJS.Platform;
  } = {},
): boolean {
  const content = readCodexRequirementsToml(params);
  if (content === undefined) {
    return true;
  }
  const allowedApprovalPolicies = parseAllowedApprovalPoliciesFromCodexRequirements(content);
  return allowedApprovalPolicies === undefined || allowedApprovalPolicies.has(policy);
}

export function canUseCodexModelBackedApprovalsReviewerForModel(
  params: CodexModelBackedReviewerContext,
): boolean {
  const explicitProvider = params.modelProvider?.trim().toLowerCase();
  const inferredProvider = inferProviderFromModelRef(params.model);
  if (explicitProvider && explicitProvider !== "codex") {
    return (
      isTrustedCodexModelBackedApprovalsReviewerProvider(explicitProvider, params) &&
      (inferredProvider === undefined ||
        isTrustedCodexModelBackedApprovalsReviewerProvider(inferredProvider, params))
    );
  }
  if (inferredProvider !== undefined) {
    return isTrustedCodexModelBackedApprovalsReviewerProvider(inferredProvider, params);
  }
  return isTrustedCodexModelBackedApprovalsReviewerProvider(explicitProvider, params);
}

export function isTrustedCodexModelBackedOpenAIProvider(params: {
  config?: ProviderAuthAliasConfig;
  env?: NodeJS.ProcessEnv;
  model?: string;
  agentDir?: string;
  codexConfigToml?: string | null;
  homeScope?: CodexAppServerHomeScope;
}): boolean {
  if (!openAIBaseUrlEnvOverridesAreTrustedForModelBackedReview(params.env)) {
    return false;
  }
  const codexBaseUrlOverrides = readCodexBaseUrlOverridesForModelBackedReview(params);
  if (
    codexBaseUrlOverrides === false ||
    !codexBaseUrlOverrides.openAI.every(isNativeOpenAIBaseUrl) ||
    !codexBaseUrlOverrides.chatGPT.every(isNativeChatGPTBaseUrl)
  ) {
    return false;
  }
  const openAIProviders = readConfiguredOpenAIProvidersForModelBackedReview(params.config);
  if (openAIProviders.length === 0) {
    return true;
  }
  return openAIProviders.every((openAIProvider) =>
    configuredOpenAIProviderIsTrustedForModelBackedReview(openAIProvider, params.model),
  );
}

export function resolveCodexModelBackedReviewerPolicyContext(params: {
  provider?: string;
  model?: string;
  bindingModelProvider?: string;
  bindingModel?: string;
  nativeAuthProfile?: boolean;
}): CodexModelBackedReviewerContext {
  const provider = params.provider?.trim();
  if (provider && provider.toLowerCase() !== "codex") {
    return {
      modelProvider: normalizeCodexModelBackedReviewerPolicyProvider(provider),
      model: params.model,
    };
  }
  const bindingModelProvider = params.bindingModelProvider?.trim();
  const currentModel = params.model?.trim();
  const bindingModel = params.bindingModel?.trim();
  if (bindingModelProvider && currentModel && bindingModel && currentModel === bindingModel) {
    return {
      modelProvider: normalizeCodexModelBackedReviewerPolicyProvider(bindingModelProvider),
      model: params.model ?? params.bindingModel,
    };
  }
  const currentModelProvider = inferProviderFromModelRef(params.model);
  if (currentModelProvider) {
    return {
      modelProvider: normalizeCodexModelBackedReviewerPolicyProvider(currentModelProvider),
      model: params.model,
    };
  }
  if (bindingModelProvider) {
    return {
      modelProvider: normalizeCodexModelBackedReviewerPolicyProvider(bindingModelProvider),
      model: params.model ?? params.bindingModel,
    };
  }
  return {
    modelProvider: params.nativeAuthProfile === true ? "openai" : undefined,
    model: params.model ?? params.bindingModel,
  };
}

export function resolveCodexComputerUseConfig(
  params: {
    pluginConfig?: unknown;
    env?: NodeJS.ProcessEnv;
    overrides?: Partial<CodexComputerUseConfig>;
  } = {},
): ResolvedCodexComputerUseConfig {
  const env = params.env ?? process.env;
  const config = readCodexPluginConfig(params.pluginConfig).computerUse ?? {};
  const marketplaceSource =
    readNonEmptyString(params.overrides?.marketplaceSource) ??
    readNonEmptyString(config.marketplaceSource) ??
    readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_SOURCE);
  const marketplacePath =
    readNonEmptyString(params.overrides?.marketplacePath) ??
    readNonEmptyString(config.marketplacePath) ??
    readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_PATH);
  const marketplaceName =
    readNonEmptyString(params.overrides?.marketplaceName) ??
    readNonEmptyString(config.marketplaceName) ??
    readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_NAME);
  const autoInstall =
    params.overrides?.autoInstall ??
    config.autoInstall ??
    readBooleanEnv(env.OPENCLAW_CODEX_COMPUTER_USE_AUTO_INSTALL) ??
    false;
  const marketplaceDiscoveryTimeoutMs = normalizePositiveNumber(
    params.overrides?.marketplaceDiscoveryTimeoutMs ??
      config.marketplaceDiscoveryTimeoutMs ??
      readNumberEnv(env.OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS),
    DEFAULT_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS,
  );
  const enabled =
    params.overrides?.enabled ??
    config.enabled ??
    readBooleanEnv(env.OPENCLAW_CODEX_COMPUTER_USE) ??
    Boolean(autoInstall || marketplaceSource || marketplacePath || marketplaceName);

  return {
    enabled,
    autoInstall,
    marketplaceDiscoveryTimeoutMs,
    pluginName:
      readNonEmptyString(params.overrides?.pluginName) ??
      readNonEmptyString(config.pluginName) ??
      readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_PLUGIN_NAME) ??
      DEFAULT_CODEX_COMPUTER_USE_PLUGIN_NAME,
    mcpServerName:
      readNonEmptyString(params.overrides?.mcpServerName) ??
      readNonEmptyString(config.mcpServerName) ??
      readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_MCP_SERVER_NAME) ??
      DEFAULT_CODEX_COMPUTER_USE_MCP_SERVER_NAME,
    ...(marketplaceSource ? { marketplaceSource } : {}),
    ...(marketplacePath ? { marketplacePath } : {}),
    ...(marketplaceName ? { marketplaceName } : {}),
  };
}

export function codexAppServerStartOptionsKey(
  options: CodexAppServerStartOptions,
  params: {
    authProfileId?: string;
    agentDir?: string;
    fallbackApiKeyCacheKey?: string;
  } = {},
): string {
  return JSON.stringify({
    transport: options.transport,
    command: options.command,
    commandSource: options.commandSource ?? null,
    managedFallbackCommandPaths: [...(options.managedFallbackCommandPaths ?? [])],
    args: options.args,
    url: options.url ?? null,
    authToken: hashSecretForKey(options.authToken, "authToken"),
    headers: Object.entries(options.headers)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, hashSecretForKey(value, `header:${key}`)]),
    env: Object.entries(options.env ?? {})
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, hashSecretForKey(value, `env:${key}`)]),
    clearEnv: [...(options.clearEnv ?? [])].toSorted(),
    authProfileId: params.authProfileId ?? null,
    agentDir: params.agentDir ?? null,
    fallbackApiKeyCacheKey: params.fallbackApiKeyCacheKey ?? null,
  });
}

export function codexSandboxPolicyForTurn(
  mode: CodexAppServerSandboxMode,
  cwd: string,
): CodexSandboxPolicy {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function resolveCodexAppServerNetworkProxy(
  config: CodexAppServerNetworkProxyConfig | undefined,
  sandbox: CodexAppServerSandboxMode,
): { networkProxy?: ResolvedCodexAppServerNetworkProxyConfig } {
  if (config?.enabled !== true) {
    return {};
  }
  const fileSystemMode =
    config.baseProfile === "read-only" || (!config.baseProfile && sandbox === "read-only")
      ? "read"
      : "write";
  const networkConfig = removeUndefinedJsonFields({
    enabled: true,
    mode: config.mode,
    domains: normalizeNetworkProxyPermissionMap(config.domains),
    unix_sockets: normalizeNetworkProxyPermissionMap(config.unixSockets),
    proxy_url: readNonEmptyString(config.proxyUrl),
    socks_url: readNonEmptyString(config.socksUrl),
    enable_socks5: config.enableSocks5,
    enable_socks5_udp: config.enableSocks5Udp,
    allow_upstream_proxy: config.allowUpstreamProxy,
    allow_local_binding: config.allowLocalBinding,
    dangerously_allow_non_loopback_proxy: config.dangerouslyAllowNonLoopbackProxy,
    dangerously_allow_all_unix_sockets: config.dangerouslyAllowAllUnixSockets,
  });
  const profile = {
    filesystem: {
      ":minimal": "read",
      ":project_roots": {
        ".": fileSystemMode,
      },
    },
    network: networkConfig,
  };
  const profileName = resolveNetworkProxyPermissionProfileName(config, profile);
  const configPatch: JsonObject = {
    "features.network_proxy.enabled": true,
    default_permissions: profileName,
    permissions: {
      [profileName]: profile,
    },
  };
  return {
    networkProxy: {
      profileName,
      configFingerprint: fingerprintCodexAppServerNetworkProxyConfigPatch(configPatch),
      configPatch,
    },
  };
}

function resolveNetworkProxyPermissionProfileName(
  config: CodexAppServerNetworkProxyConfig,
  profile: JsonObject,
): string {
  const explicitProfileName = readNonEmptyString(config.profileName);
  if (explicitProfileName) {
    return explicitProfileName;
  }
  const suffix = createHash("sha256")
    .update(stableStringifyJson({ version: 1, profile }))
    .digest("hex")
    .slice(0, 16);
  return `${DEFAULT_CODEX_APP_SERVER_NETWORK_PROXY_PROFILE_PREFIX}-${suffix}`;
}

export function fingerprintCodexAppServerNetworkProxyConfigPatch(configPatch: JsonObject): string {
  return createHash("sha256").update(stableStringifyJson(configPatch)).digest("hex");
}

function normalizeNetworkProxyPermissionMap<TPermission extends string>(
  value: Record<string, TPermission> | undefined,
): Record<string, TPermission> | undefined {
  const entries = Object.entries(value ?? {})
    .map(([key, permission]) => [key.trim(), permission] as const)
    .filter(([key]) => key.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function removeUndefinedJsonFields(value: Record<string, JsonValue | undefined>): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
  );
}

function stableStringifyJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function withMcpElicitationsApprovalPolicy(
  policy: CodexAppServerEffectiveApprovalPolicy,
): CodexAppServerEffectiveApprovalPolicy {
  if (typeof policy !== "string") {
    return {
      granular: {
        ...policy.granular,
        mcp_elicitations: true,
      },
    };
  }
  if (policy === "never") {
    return {
      granular: {
        mcp_elicitations: true,
        rules: false,
        sandbox_approval: false,
        request_permissions: false,
        skill_approval: false,
      },
    };
  }
  return {
    granular: {
      mcp_elicitations: true,
      rules: true,
      sandbox_approval: true,
      request_permissions: true,
      skill_approval: true,
    },
  };
}

function resolveTransport(value: unknown): CodexAppServerTransportMode {
  return value === "websocket" ? "websocket" : "stdio";
}

function normalizeRemoteWorkspaceRoot(value: string | undefined): string | undefined {
  return readNonEmptyString(value);
}

function inferCodexAppServerConnectionClass(params: {
  transport: CodexAppServerTransportMode;
  url?: string;
}): CodexAppServerConnectionClass {
  if (params.transport !== "websocket") {
    return "local-loopback";
  }
  return params.url && isLoopbackWebSocketUrl(params.url) ? "local-loopback" : "remote";
}

function assertCodexAppServerConnectionClassConfig(params: {
  connectionClass: CodexAppServerConnectionClass;
  authToken?: string;
  headers: Record<string, string>;
}): void {
  if (
    params.connectionClass === "remote" &&
    !hasIdentityBearingWebSocketAuth({
      authToken: params.authToken,
      headers: params.headers,
    })
  ) {
    throw new Error(
      "remote Codex app-server WebSocket URLs require appServer.authToken or an Authorization header",
    );
  }
}

function isLoopbackWebSocketUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

function hasIdentityBearingWebSocketAuth(params: {
  authToken?: string;
  headers: Record<string, string>;
}): boolean {
  if (readNonEmptyString(params.authToken)) {
    return true;
  }
  return Object.entries(params.headers).some(
    ([key, value]) =>
      key.trim().toLowerCase() === "authorization" && Boolean(readNonEmptyString(value)),
  );
}

function resolvePolicyMode(value: unknown): CodexAppServerPolicyMode | undefined {
  return value === "guardian" || value === "yolo" ? value : undefined;
}

function resolveDefaultCodexAppServerPolicy(params: {
  transport: CodexAppServerTransportMode;
  forceGuardian?: boolean;
  forceUserReviewer?: boolean;
  execModeRequiringPromptingApprovals?: Extract<OpenClawExecMode, "auto" | "ask">;
  execModeRequiringUserReviewer?: OpenClawExecMode;
  env?: NodeJS.ProcessEnv;
  requirementsToml?: string | null;
  requirementsPath?: string;
  readRequirementsFile?: (path: string) => string | undefined;
  platform?: NodeJS.Platform;
  hostName?: string;
}): CodexAppServerDefaultPolicy {
  if (params.transport !== "stdio") {
    return { mode: "yolo", dangerFullAccessAllowed: true };
  }
  const content = readCodexRequirementsToml(params);
  if (content === undefined) {
    if (!params.forceGuardian) {
      return { mode: "yolo", dangerFullAccessAllowed: true };
    }
    return {
      mode: "guardian",
      dangerFullAccessAllowed: true,
      approvalPolicy: selectGuardianApprovalPolicy(
        undefined,
        params.execModeRequiringPromptingApprovals,
      ),
      approvalsReviewer: params.forceUserReviewer
        ? selectUserApprovalsReviewer(undefined, params.execModeRequiringUserReviewer)
        : selectGuardianApprovalsReviewer(
            undefined,
            params.execModeRequiringPromptingApprovals === "auto" ? "auto" : undefined,
          ),
      sandbox: selectGuardianSandbox(undefined),
    };
  }
  const allowedSandboxModes = parseAllowedSandboxModesFromCodexRequirements(
    content,
    readNonEmptyString(params.hostName) ?? readHostName(),
  );
  const allowedApprovalPolicies = parseAllowedApprovalPoliciesFromCodexRequirements(content);
  const allowedApprovalsReviewers = parseAllowedApprovalsReviewersFromCodexRequirements(content);
  const yoloSandboxAllowed =
    allowedSandboxModes === undefined || allowedSandboxModes.has("danger-full-access");
  const yoloApprovalAllowed =
    allowedApprovalPolicies === undefined || allowedApprovalPolicies.has("never");
  const yoloReviewerAllowed =
    allowedApprovalsReviewers === undefined || allowedApprovalsReviewers.has("user");
  if (!params.forceGuardian && yoloSandboxAllowed && yoloApprovalAllowed && yoloReviewerAllowed) {
    return { mode: "yolo", dangerFullAccessAllowed: true };
  }
  return {
    mode: "guardian",
    dangerFullAccessAllowed: yoloSandboxAllowed,
    approvalPolicy: selectGuardianApprovalPolicy(
      allowedApprovalPolicies,
      params.execModeRequiringPromptingApprovals,
    ),
    approvalsReviewer: params.forceUserReviewer
      ? selectUserApprovalsReviewer(allowedApprovalsReviewers, params.execModeRequiringUserReviewer)
      : selectGuardianApprovalsReviewer(
          allowedApprovalsReviewers,
          params.execModeRequiringPromptingApprovals === "auto" ? "auto" : undefined,
        ),
    sandbox: selectGuardianSandbox(allowedSandboxModes),
  };
}

function readCodexRequirementsToml(params: {
  env?: NodeJS.ProcessEnv;
  requirementsToml?: string | null;
  requirementsPath?: string;
  readRequirementsFile?: (path: string) => string | undefined;
  platform?: NodeJS.Platform;
}): string | undefined {
  if (params.requirementsToml !== undefined) {
    return params.requirementsToml ?? undefined;
  }
  const requirementsPath =
    readNonEmptyString(params.requirementsPath) ??
    resolveCodexRequirementsPath(params.env ?? process.env, params.platform ?? process.platform);
  try {
    if (params.readRequirementsFile) {
      return params.readRequirementsFile(requirementsPath);
    }
    return readFileSync(requirementsPath, "utf8");
  } catch {
    return undefined;
  }
}

function resolveCodexRequirementsPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const programData = readNonEmptyString(env.ProgramData) ?? "C:\\ProgramData";
    return `${programData.replace(/[\\/]+$/, "")}${WINDOWS_CODEX_REQUIREMENTS_SUFFIX}`;
  }
  return UNIX_CODEX_REQUIREMENTS_PATH;
}

function parseAllowedSandboxModesFromCodexRequirements(
  content: string,
  hostName: string,
): Set<CodexAppServerSandboxMode> | undefined {
  const remoteSandboxModes = parseMatchingRemoteSandboxModesFromCodexRequirements(
    content,
    hostName,
  );
  if (remoteSandboxModes !== undefined) {
    return remoteSandboxModes;
  }
  const values = parseTopLevelRequirementsStringArray(content, "allowed_sandbox_modes");
  return parseRequirementsSandboxModes(values);
}

function parseAllowedApprovalPoliciesFromCodexRequirements(
  content: string,
): Set<CodexAppServerApprovalPolicy> | undefined {
  const values = parseTopLevelRequirementsStringArray(content, "allowed_approval_policies");
  if (values === undefined) {
    return undefined;
  }
  const normalizedPolicies = values
    .map((entry) => normalizeRequirementsApprovalPolicy(entry))
    .filter((entry): entry is CodexAppServerApprovalPolicy => entry !== undefined);
  return normalizedPolicies.length > 0 ? new Set(normalizedPolicies) : undefined;
}

function parseAllowedApprovalsReviewersFromCodexRequirements(
  content: string,
): Set<CodexAppServerApprovalsReviewer> | undefined {
  const values = parseTopLevelRequirementsStringArray(content, "allowed_approvals_reviewers");
  if (values === undefined) {
    return undefined;
  }
  const normalizedReviewers = values
    .map((entry) => normalizeRequirementsApprovalsReviewer(entry))
    .filter((entry): entry is CodexAppServerApprovalsReviewer => entry !== undefined);
  return normalizedReviewers.length > 0 ? new Set(normalizedReviewers) : undefined;
}

function parseMatchingRemoteSandboxModesFromCodexRequirements(
  content: string,
  hostName: string,
): Set<CodexAppServerSandboxMode> | undefined {
  const normalizedHostName = normalizeRequirementsHostName(hostName);
  if (normalizedHostName === undefined) {
    return undefined;
  }
  for (const section of parseTomlArrayTableSections(content, "remote_sandbox_config")) {
    const patterns = parseRequirementsStringArray(section, "hostname_patterns");
    if (!patterns || !requirementsHostNameMatchesAnyPattern(normalizedHostName, patterns)) {
      continue;
    }
    return parseRequirementsSandboxModes(
      parseRequirementsStringArray(section, "allowed_sandbox_modes"),
    );
  }
  return undefined;
}

function parseRequirementsSandboxModes(
  values: string[] | undefined,
): Set<CodexAppServerSandboxMode> | undefined {
  if (values === undefined) {
    return undefined;
  }
  const normalizedModes = values
    .map((entry) => normalizeRequirementsSandboxMode(entry))
    .filter((entry): entry is CodexAppServerSandboxMode => entry !== undefined);
  return normalizedModes.length > 0 ? new Set(normalizedModes) : undefined;
}

function parseTopLevelRequirementsStringArray(content: string, key: string): string[] | undefined {
  const topLevelContent = stripTomlLineComments(content).slice(0, firstTomlTableOffset(content));
  return parseRequirementsStringArray(topLevelContent, key);
}

function parseTomlStringValue(content: string, key: string): string | undefined | false {
  return parseTomlStringAssignmentValue(content, tomlDottedKeyPattern(key));
}

function parseInlineOpenAIModelProviderBaseUrl(content: string): string | undefined | false {
  return parseTomlStringAssignmentValue(
    content,
    `${tomlKeyPattern("model_providers")}\\s*=\\s*\\{[\\s\\S]*?${tomlKeyPattern("openai")}\\s*=\\s*\\{[\\s\\S]*?${tomlKeyPattern("base_url")}`,
  );
}

function parseTomlStringAssignmentValue(
  content: string,
  keyPattern: string,
): string | undefined | false {
  const assignment = content.match(new RegExp(`(?:^|\\n)\\s*${keyPattern}\\s*=\\s*([^\\r\\n]*)`));
  if (!assignment) {
    return undefined;
  }
  const rawValue = assignment[1]?.trimStart() ?? "";
  if (rawValue.startsWith('"""') || rawValue.startsWith("'''")) {
    return false;
  }
  const match = parseTomlStringAssignment(content, keyPattern);
  return match ? (match[1] ?? match[2] ?? "") : false;
}

function parseTomlStringAssignment(content: string, keyPattern: string): RegExpMatchArray | null {
  return content.match(
    new RegExp(`(?:^|\\n)\\s*${keyPattern}\\s*=\\s*(?:"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"|'([^']*)')`),
  );
}

function tomlDottedKeyPattern(key: string): string {
  return key.split(".").map(tomlKeyPattern).join("\\s*\\.\\s*");
}

function tomlKeyPattern(key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:"${escaped}"|'${escaped}'|${escaped})`;
}

function parseRequirementsStringArray(content: string, key: string): string[] | undefined {
  const match = content.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!match) {
    return undefined;
  }
  const arrayBody = match[1] ?? "";
  const stringMatches = [...arrayBody.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'/g)];
  if (stringMatches.length === 0 && arrayBody.trim().length > 0) {
    return undefined;
  }
  return stringMatches.map((entry) => entry[1] ?? entry[2] ?? "");
}

function parseTomlTableSection(content: string, table: string): string | undefined {
  const strippedContent = stripTomlLineComments(content);
  const tablePattern = tomlDottedKeyPattern(table);
  const headerPattern = new RegExp(`^\\s*\\[\\s*${tablePattern}\\s*\\]\\s*$`, "m");
  const match = headerPattern.exec(strippedContent);
  if (!match) {
    return undefined;
  }
  const sectionStart = match.index + match[0].length;
  const rest = strippedContent.slice(sectionStart);
  const nextTableOffset = rest.search(/^\s*\[/m);
  return nextTableOffset === -1 ? rest : rest.slice(0, nextTableOffset);
}

function parseTomlArrayTableSections(content: string, table: string): string[] {
  const strippedContent = stripTomlLineComments(content);
  const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerPattern = new RegExp(`^\\s*\\[\\[\\s*${escapedTable}\\s*\\]\\]\\s*$`, "gm");
  const sections: string[] = [];
  for (
    let match = headerPattern.exec(strippedContent);
    match;
    match = headerPattern.exec(strippedContent)
  ) {
    const sectionStart = headerPattern.lastIndex;
    const rest = strippedContent.slice(sectionStart);
    const nextTableOffset = rest.search(/^\s*\[/m);
    sections.push(nextTableOffset === -1 ? rest : rest.slice(0, nextTableOffset));
  }
  return sections;
}

function firstTomlTableOffset(content: string): number {
  const match = content.match(/^\s*\[[^\]\n]/m);
  return match?.index ?? content.length;
}

function stripTomlLineComments(value: string): string {
  let output = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (quote) {
      output += char;
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }
    if (char === "#") {
      while (index < value.length && value[index] !== "\n") {
        index += 1;
      }
      if (value[index] === "\n") {
        output += "\n";
      }
      continue;
    }
    output += char;
  }
  return output;
}

function normalizeRequirementsSandboxMode(value: string): CodexAppServerSandboxMode | undefined {
  const compact = value.replace(/[\s_-]/g, "").toLowerCase();
  if (compact === "readonly") {
    return "read-only";
  }
  if (compact === "workspacewrite") {
    return "workspace-write";
  }
  if (compact === "dangerfullaccess") {
    return "danger-full-access";
  }
  return undefined;
}

function normalizeRequirementsHostName(value: string): string | undefined {
  const normalized = value.trim().replace(/\.+$/g, "").toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function requirementsHostNameMatchesAnyPattern(hostName: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeRequirementsHostName(pattern);
    return normalizedPattern !== undefined && globPatternMatches(hostName, normalizedPattern);
  });
}

function globPatternMatches(value: string, pattern: string): boolean {
  let regex = "^";
  for (const char of pattern) {
    if (char === "*") {
      regex += ".*";
    } else if (char === "?") {
      regex += ".";
    } else {
      regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  regex += "$";
  return new RegExp(regex).test(value);
}

function normalizeRequirementsApprovalPolicy(
  value: string,
): CodexAppServerApprovalPolicy | undefined {
  const normalized = value.trim().toLowerCase();
  // Codex 0.143 keeps this deprecated requirements-file alias in its core
  // parser, but app-server exposes only the canonical on-request value.
  if (normalized === "on-failure") {
    return "on-request";
  }
  return resolveApprovalPolicy(normalized);
}

function normalizeRequirementsApprovalsReviewer(
  value: string,
): CodexAppServerApprovalsReviewer | undefined {
  const normalized = value.trim().toLowerCase();
  return resolveApprovalsReviewer(normalized);
}

function selectGuardianApprovalPolicy(
  allowedApprovalPolicies: Set<CodexAppServerApprovalPolicy> | undefined,
  execModeRequiringPromptingApprovals?: Extract<OpenClawExecMode, "auto" | "ask">,
): CodexAppServerApprovalPolicy {
  if (allowedApprovalPolicies === undefined || allowedApprovalPolicies.has("on-request")) {
    return "on-request";
  }
  if (execModeRequiringPromptingApprovals) {
    throw new Error(
      `tools.exec.mode=${execModeRequiringPromptingApprovals} requires Codex app-server prompting approvals`,
    );
  }
  if (allowedApprovalPolicies.has("untrusted")) {
    return "untrusted";
  }
  if (allowedApprovalPolicies.has("never")) {
    return "never";
  }
  return "on-request";
}

function selectGuardianApprovalsReviewer(
  allowedApprovalsReviewers: Set<CodexAppServerApprovalsReviewer> | undefined,
  execModeRequiringAutoReviewer?: Extract<OpenClawExecMode, "auto">,
): CodexAppServerApprovalsReviewer {
  if (allowedApprovalsReviewers === undefined || allowedApprovalsReviewers.has("auto_review")) {
    return "auto_review";
  }
  if (allowedApprovalsReviewers.has("guardian_subagent")) {
    return "guardian_subagent";
  }
  if (execModeRequiringAutoReviewer) {
    throw new Error(
      `tools.exec.mode=${execModeRequiringAutoReviewer} requires Codex app-server auto approvals`,
    );
  }
  if (allowedApprovalsReviewers.has("user")) {
    return "user";
  }
  return "auto_review";
}

function selectUserApprovalsReviewer(
  allowedApprovalsReviewers: Set<CodexAppServerApprovalsReviewer> | undefined,
  execModeRequiringUserReviewer?: OpenClawExecMode,
): CodexAppServerApprovalsReviewer {
  if (allowedApprovalsReviewers === undefined || allowedApprovalsReviewers.has("user")) {
    return "user";
  }
  throw new Error(
    `tools.exec.mode=${execModeRequiringUserReviewer ?? "ask"} requires Codex app-server user approvals`,
  );
}

function isCodexModelBackedApprovalsReviewerProvider(provider: string | undefined): boolean {
  const normalized = provider?.trim().toLowerCase();
  return normalized === "openai";
}

function isTrustedCodexModelBackedApprovalsReviewerProvider(
  provider: string | undefined,
  params: CodexModelBackedReviewerContext,
): boolean {
  return (
    isCodexModelBackedApprovalsReviewerProvider(provider) &&
    isTrustedCodexModelBackedOpenAIProvider({
      config: params.config,
      env: params.env,
      model: params.model,
      agentDir: params.agentDir,
      codexConfigToml: params.codexConfigToml,
      homeScope: params.homeScope,
    })
  );
}

function readCodexBaseUrlOverridesForModelBackedReview(
  params: Pick<
    CodexModelBackedReviewerContext,
    "agentDir" | "codexConfigToml" | "env" | "homeScope"
  >,
): { openAI: string[]; chatGPT: string[] } | false {
  const configToml = readCodexAppServerConfigToml(params);
  if (configToml === false) {
    return false;
  }
  if (configToml === undefined) {
    return { openAI: [], chatGPT: [] };
  }
  const topLevelContent = stripTomlLineComments(configToml).slice(
    0,
    firstTomlTableOffset(configToml),
  );
  const modelProviderOpenAISection = parseTomlTableSection(configToml, "model_providers.openai");
  const openAIBaseUrl = parseTomlStringValue(topLevelContent, "openai_base_url");
  const chatGPTBaseUrl = parseTomlStringValue(topLevelContent, "chatgpt_base_url");
  const dottedProviderBaseUrl = parseTomlStringValue(
    topLevelContent,
    "model_providers.openai.base_url",
  );
  const inlineProviderBaseUrl = parseInlineOpenAIModelProviderBaseUrl(topLevelContent);
  const sectionProviderBaseUrl = modelProviderOpenAISection
    ? parseTomlStringValue(modelProviderOpenAISection, "base_url")
    : undefined;
  const openAI = [
    openAIBaseUrl,
    dottedProviderBaseUrl,
    inlineProviderBaseUrl,
    sectionProviderBaseUrl,
  ];
  const chatGPT = [chatGPTBaseUrl];
  if ([...openAI, ...chatGPT].includes(false)) {
    return false;
  }
  return {
    openAI: openAI.filter((entry): entry is string => typeof entry === "string"),
    chatGPT: chatGPT.filter((entry): entry is string => typeof entry === "string"),
  };
}

function readCodexAppServerConfigToml(
  params: Pick<
    CodexModelBackedReviewerContext,
    "agentDir" | "codexConfigToml" | "env" | "homeScope"
  >,
): string | undefined | false {
  if (params.codexConfigToml !== undefined) {
    return params.codexConfigToml ?? undefined;
  }
  const configPath = resolveCodexAppServerConfigPath(params);
  if (!configPath) {
    return undefined;
  }
  try {
    return readFileSync(configPath, "utf8");
  } catch (error) {
    return readErrorCode(error) === "ENOENT" ? undefined : false;
  }
}

function resolveCodexAppServerConfigPath(
  params: Pick<CodexModelBackedReviewerContext, "agentDir" | "env" | "homeScope">,
): string | undefined {
  if (params.homeScope === "user") {
    return path.join(resolveCodexAppServerUserHomeDir(params.env), CODEX_CONFIG_TOML_FILENAME);
  }
  const agentDir = readNonEmptyString(params.agentDir);
  const codexHome = agentDir
    ? path.join(path.resolve(agentDir), CODEX_APP_SERVER_HOME_DIRNAME)
    : undefined;
  return codexHome ? path.join(codexHome, CODEX_CONFIG_TOML_FILENAME) : undefined;
}

/** Resolves the native user Codex home used by Desktop and the CLI. */
export function resolveCodexAppServerUserHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = readHomeDir,
): string {
  const configured = readNonEmptyString(env.CODEX_HOME);
  return path.resolve(configured ?? path.join(homedir(), ".codex"));
}

function readErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function readConfiguredOpenAIProvidersForModelBackedReview(
  config: ProviderAuthAliasConfig | undefined,
): Array<Record<string, unknown>> {
  const providerRecords = readRecord(readRecord(readRecord(config)?.models)?.providers);
  if (!providerRecords) {
    return [];
  }
  const openAIProviders: Array<Record<string, unknown>> = [];
  for (const [providerId, providerConfig] of Object.entries(providerRecords)) {
    if (resolveProviderIdForAuth(providerId, { config }) !== "openai") {
      continue;
    }
    const record = readRecord(providerConfig);
    if (record) {
      openAIProviders.push(record);
    }
  }
  return openAIProviders;
}

function configuredOpenAIProviderIsTrustedForModelBackedReview(
  openAIProvider: Record<string, unknown>,
  modelInput: string | undefined,
): boolean {
  if (
    readRecord(openAIProvider.localService) ||
    hasNonEmptyRecord(openAIProvider.headers) ||
    hasNonEmptyRecord(openAIProvider.request) ||
    typeof openAIProvider.authHeader === "boolean" ||
    !isNativeOpenAIBaseUrl(openAIProvider.baseUrl)
  ) {
    return false;
  }
  const models = openAIProvider.models;
  if (!Array.isArray(models)) {
    return true;
  }
  const modelId = normalizeOpenAIModelBackedReviewerModelId(modelInput);
  if (!modelId) {
    return false;
  }
  for (const entry of models) {
    const model = readRecord(entry);
    if (typeof model?.id !== "string" || !matchesConfiguredOpenAIModelId(modelId, model.id)) {
      continue;
    }
    if (
      hasNonEmptyRecord(model.headers) ||
      hasNonEmptyRecord(model.request) ||
      !isNativeOpenAIBaseUrl(model.baseUrl)
    ) {
      return false;
    }
  }
  return true;
}

function normalizeOpenAIModelBackedReviewerModelId(modelInput: string | undefined): string {
  const normalized = modelInput?.trim() ?? "";
  const authProfileIndex = normalized.indexOf("@");
  const withoutAuthProfile =
    authProfileIndex > 0 ? normalized.slice(0, authProfileIndex) : normalized;
  const slashIndex = withoutAuthProfile.indexOf("/");
  return slashIndex > 0 ? withoutAuthProfile.slice(slashIndex + 1).trim() : withoutAuthProfile;
}

function matchesConfiguredOpenAIModelId(modelId: string, configuredModelId: string): boolean {
  const configured = normalizeOpenAIModelBackedReviewerModelId(configuredModelId);
  return Boolean(configured) && (modelId === configured || modelId.startsWith(`${configured}@`));
}

function hasNonEmptyRecord(value: unknown): boolean {
  const record = readRecord(value);
  return record !== undefined && Object.keys(record).length > 0;
}

function isNativeOpenAIBaseUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

function openAIBaseUrlEnvOverridesAreTrustedForModelBackedReview(
  env: NodeJS.ProcessEnv | undefined,
): boolean {
  return [env?.OPENAI_BASE_URL, env?.OPENAI_API_BASE].every(isNativeOpenAIBaseUrl);
}

function isNativeChatGPTBaseUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "chatgpt.com";
  } catch {
    return false;
  }
}

function normalizeCodexModelBackedReviewerPolicyProvider(provider: string): string {
  return provider.toLowerCase() === "openai" ? "openai" : provider;
}

function inferProviderFromModelRef(model: string | undefined): string | undefined {
  const normalized = model?.trim().toLowerCase();
  const slashIndex = normalized?.indexOf("/") ?? -1;
  return slashIndex > 0 ? normalized?.slice(0, slashIndex) : undefined;
}

function selectForcedPromptingSandbox(params: {
  configuredSandbox?: CodexAppServerSandboxMode;
  defaultSandbox?: CodexAppServerSandboxMode;
}): CodexAppServerSandboxMode {
  if (params.configuredSandbox === "read-only" || params.defaultSandbox === "read-only") {
    return "read-only";
  }
  return params.defaultSandbox ?? "workspace-write";
}

function selectForcedDangerFullAccessSandbox(params: {
  configuredSandbox?: CodexAppServerSandboxMode;
  defaultPolicy: CodexAppServerDefaultPolicy | undefined;
  openClawSandboxActive: boolean;
}): CodexAppServerSandboxMode {
  if (params.configuredSandbox === "read-only") {
    return "read-only";
  }
  if (params.defaultPolicy?.dangerFullAccessAllowed === false) {
    if (params.openClawSandboxActive) {
      return params.defaultPolicy.sandbox ?? "workspace-write";
    }
    throw new Error(
      "legacy full exec security with ask requires Codex app-server danger-full-access",
    );
  }
  return "danger-full-access";
}

function selectGuardianSandbox(
  allowedSandboxModes: Set<CodexAppServerSandboxMode> | undefined,
): CodexAppServerSandboxMode {
  if (allowedSandboxModes === undefined || allowedSandboxModes.has("workspace-write")) {
    return "workspace-write";
  }
  if (allowedSandboxModes.has("read-only")) {
    return "read-only";
  }
  if (allowedSandboxModes.has("danger-full-access")) {
    return "danger-full-access";
  }
  return "workspace-write";
}

function resolveApprovalPolicy(value: unknown): CodexAppServerApprovalPolicy | undefined {
  if (value === "on-failure") {
    return "on-request";
  }
  return value === "on-request" || value === "untrusted" || value === "never" ? value : undefined;
}

function resolveSandbox(value: unknown): CodexAppServerSandboxMode | undefined {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ? value
    : undefined;
}

function resolveApprovalsReviewer(value: unknown): CodexAppServerApprovalsReviewer | undefined {
  return value === "auto_review" || value === "guardian_subagent" || value === "user"
    ? value
    : undefined;
}

export function resolveOpenClawExecModeFromConfig(params: {
  config?: unknown;
  agentId?: string;
}): OpenClawExecMode | undefined {
  const policy = resolveOpenClawExecPolicyFromConfig(params);
  return policy.touched ? policy.mode : undefined;
}

function resolveOpenClawExecPolicyFromConfig(params: {
  config?: unknown;
  agentId?: string;
}): OpenClawExecPolicy {
  const root = readRecord(params.config);
  const globalExec = readRecord(readRecord(root?.tools)?.exec);
  const globalPolicy = applyOpenClawExecPolicyLayer(createDefaultOpenClawExecPolicy(), globalExec);
  const agentId = params.agentId?.trim();
  if (!agentId) {
    return globalPolicy;
  }
  const agents = readRecord(root?.agents);
  const agentList = Array.isArray(agents?.list) ? agents.list : [];
  const normalizedAgentId = normalizeAgentId(agentId);
  const agentEntry = agentList.find((entry) => {
    const id = readRecord(entry)?.id;
    return typeof id === "string" && normalizeAgentId(id) === normalizedAgentId;
  });
  const agentExec = readRecord(readRecord(readRecord(agentEntry)?.tools)?.exec);
  return applyOpenClawExecPolicyLayer(globalPolicy, agentExec);
}

export function resolveOpenClawExecModeForCodexAppServer(params: {
  execOverrides?: {
    security?: unknown;
    ask?: unknown;
  };
  approvals?: ExecApprovalsFile;
  config?: unknown;
  agentId?: string;
}): OpenClawExecMode | undefined {
  const policy = resolveOpenClawExecPolicyForCodexAppServer(params);
  return policy.touched ? policy.mode : undefined;
}

export function resolveOpenClawExecPolicyForCodexAppServer(params: {
  execOverrides?: {
    security?: unknown;
    ask?: unknown;
  };
  approvals?: ExecApprovalsFile;
  config?: unknown;
  agentId?: string;
}): OpenClawExecPolicyForCodexAppServer {
  const basePolicy = resolveOpenClawExecPolicyFromConfig({
    config: params.config,
    agentId: params.agentId,
  });
  const overridePolicy = applyOpenClawExecPolicyLayer(basePolicy, params.execOverrides);
  const approvalFloors = resolveOpenClawExecApprovalFloorsForCodexAppServer({
    approvals: params.approvals,
    agentId: params.agentId,
    policy: overridePolicy,
  });
  return applyOpenClawExecApprovalFloors(overridePolicy, approvalFloors);
}

function resolveEffectiveOpenClawExecModeForCodexAppServer(params: {
  execMode?: OpenClawExecMode;
  execPolicy?: OpenClawExecPolicyForCodexAppServer;
}): OpenClawExecMode | undefined {
  if (params.execPolicy?.touched === true) {
    return params.execPolicy.mode;
  }
  return params.execMode;
}

function resolveCodexPolicyModeForOpenClawExecMode(
  mode: OpenClawExecMode | undefined,
): CodexAppServerPolicyMode | undefined {
  if (!mode || mode === "full") {
    return undefined;
  }
  return "guardian";
}

function assertCodexAppServerAllowedForOpenClawExecMode(mode: OpenClawExecMode | undefined): void {
  if (mode === "deny" || mode === "allowlist") {
    throw new Error(
      `Codex app-server local execution is not available when tools.exec.mode=${mode}`,
    );
  }
}

function createDefaultOpenClawExecPolicy(): OpenClawExecPolicy {
  return {
    security: "full",
    ask: "off",
    touched: false,
  };
}

function applyOpenClawExecPolicyLayer(
  base: OpenClawExecPolicy,
  exec?: { mode?: unknown; security?: unknown; ask?: unknown },
): OpenClawExecPolicy {
  if (!exec) {
    return base;
  }
  const mode = readExecMode(exec.mode);
  if (mode !== undefined) {
    return {
      ...resolveOpenClawExecPolicyForMode(mode),
      touched: true,
    };
  }
  const security = readExecSecurity(exec.security);
  const ask = readExecAsk(exec.ask);
  if (security === undefined && ask === undefined) {
    return base;
  }
  const nextSecurity = security ?? base.security;
  const nextAsk = ask ?? base.ask;
  return {
    mode: resolveOpenClawExecModeFromPolicy({ security: nextSecurity, ask: nextAsk }),
    security: nextSecurity,
    ask: nextAsk,
    touched: true,
  };
}

function resolveOpenClawExecApprovalFloorsForCodexAppServer(params: {
  approvals?: ExecApprovalsFile;
  agentId?: string;
  policy: OpenClawExecPolicy;
}): OpenClawExecApprovalFloorsForCodexAppServer | undefined {
  if (!params.approvals) {
    return undefined;
  }
  return resolveExecApprovalsFromFile({
    file: params.approvals,
    agentId: params.agentId,
    overrides: {
      security: params.policy.security,
      ask: params.policy.ask,
    },
  }).agent;
}

function applyOpenClawExecApprovalFloors(
  base: OpenClawExecPolicy,
  approvalFloors?: OpenClawExecApprovalFloorsForCodexAppServer,
): OpenClawExecPolicy {
  if (!approvalFloors) {
    return base;
  }
  const nextSecurity = approvalFloors.security
    ? minOpenClawExecSecurity(base.security, approvalFloors.security)
    : base.security;
  const nextAsk = approvalFloors.ask ? maxOpenClawExecAsk(base.ask, approvalFloors.ask) : base.ask;
  if (nextSecurity === base.security && nextAsk === base.ask) {
    return base;
  }
  return {
    mode: resolveOpenClawExecModeFromPolicy({ security: nextSecurity, ask: nextAsk }),
    security: nextSecurity,
    ask: nextAsk,
    touched: true,
  };
}

function resolveOpenClawExecPolicyForMode(
  mode: OpenClawExecMode,
): Omit<OpenClawExecPolicy, "touched"> {
  switch (mode) {
    case "deny":
      return { mode, security: "deny", ask: "off" };
    case "allowlist":
      return { mode, security: "allowlist", ask: "off" };
    case "ask":
    case "auto":
      return { mode, security: "allowlist", ask: "on-miss" };
    case "full":
      return { mode, security: "full", ask: "off" };
  }
  const exhaustiveMode: never = mode;
  return exhaustiveMode;
}

function resolveOpenClawExecModeFromPolicy(params: {
  security: OpenClawExecSecurity;
  ask: OpenClawExecAsk;
}): OpenClawExecMode {
  if (params.security === "deny") {
    return "deny";
  }
  if (params.security === "allowlist" && params.ask === "off") {
    return "allowlist";
  }
  if (params.security === "full" && params.ask !== "always") {
    return "full";
  }
  return "ask";
}

function minOpenClawExecSecurity(
  left: OpenClawExecSecurity,
  right: OpenClawExecSecurity,
): OpenClawExecSecurity {
  const order: Record<OpenClawExecSecurity, number> = { deny: 0, allowlist: 1, full: 2 };
  return order[left] <= order[right] ? left : right;
}

function maxOpenClawExecAsk(left: OpenClawExecAsk, right: OpenClawExecAsk): OpenClawExecAsk {
  const order: Record<OpenClawExecAsk, number> = { off: 0, "on-miss": 1, always: 2 };
  return order[left] >= order[right] ? left : right;
}

function readExecMode(value: unknown): OpenClawExecMode | undefined {
  return value === "deny" ||
    value === "allowlist" ||
    value === "ask" ||
    value === "auto" ||
    value === "full"
    ? value
    : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizeCodexServiceTier(value: unknown): CodexServiceTier | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "fast" || normalized === "priority") {
    return "priority";
  }
  if (normalized === "flex") {
    return "flex";
  }
  return trimmed;
}

export function isCodexFastServiceTier(value: unknown): boolean {
  return normalizeCodexServiceTier(value) === "priority";
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  return resolvePositiveTimerTimeoutMs(value, fallback);
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(
        ([key, child]) =>
          [
            key.trim(),
            normalizeCodexAppServerSecretInput({
              value: child,
              path: `plugins.entries.codex.config.appServer.headers.${key}`,
            }),
          ] as const,
      )
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1])),
  );
}

function normalizeCodexAppServerSecretInput(params: {
  value: unknown;
  path: string;
}): string | undefined {
  return normalizeResolvedSecretInputString(params);
}

function normalizeStringList(value: unknown): string[] {
  return normalizeTrimmedStringList(value);
}

function readBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function readExecSecurity(value: unknown): OpenClawExecSecurity | undefined {
  return value === "deny" || value === "allowlist" || value === "full" ? value : undefined;
}

function readExecAsk(value: unknown): OpenClawExecAsk | undefined {
  return value === "off" || value === "on-miss" || value === "always" ? value : undefined;
}

function readNumberEnv(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !PLAIN_DECIMAL_NUMBER_RE.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveArgs(configArgs: unknown, envArgs: string | undefined): string[] {
  if (Array.isArray(configArgs)) {
    return configArgs
      .map((entry) => readNonEmptyString(entry))
      .filter((entry): entry is string => entry !== undefined);
  }
  if (typeof configArgs === "string") {
    return splitShellWords(configArgs);
  }
  return splitShellWords(envArgs ?? "");
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function hashSecretForKey(value: string | undefined, label: string): string | null {
  if (!value) {
    return null;
  }
  return createHmac("sha256", START_OPTIONS_KEY_SECRET)
    .update(label)
    .update("\0")
    .update(value)
    .digest("hex");
}

function getStartOptionsKeySecret(): Buffer {
  const globalState = globalThis as typeof globalThis & {
    [START_OPTIONS_KEY_SECRET_SYMBOL]?: Buffer;
  };
  globalState[START_OPTIONS_KEY_SECRET_SYMBOL] ??= randomBytes(32);
  return globalState[START_OPTIONS_KEY_SECRET_SYMBOL];
}

function splitShellWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of value) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    words.push(current);
  }
  return words;
}
