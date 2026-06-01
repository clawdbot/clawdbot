import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname as readHostName } from "node:os";
import {
  resolveExecApprovalsFromFile,
  type ExecApprovalsFile,
} from "openclaw/plugin-sdk/exec-approvals-runtime";
import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { normalizeTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";
import { detectWindowsSpawnCommandInlineArgs } from "openclaw/plugin-sdk/windows-spawn";
import { z } from "zod";
import type { CodexSandboxPolicy, CodexServiceTier } from "./protocol.js";

const START_OPTIONS_KEY_SECRET_SYMBOL = Symbol.for("openclaw.codexAppServerStartOptionsKeySecret");
const START_OPTIONS_KEY_SECRET = getStartOptionsKeySecret();
const UNIX_CODEX_REQUIREMENTS_PATH = "/etc/codex/requirements.toml";
const WINDOWS_CODEX_REQUIREMENTS_SUFFIX = "\\OpenAI\\Codex\\requirements.toml";
const PLAIN_DECIMAL_NUMBER_RE = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))$/;

type CodexAppServerTransportMode = "stdio" | "websocket";
type CodexAppServerPolicyMode = "yolo" | "guardian";
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
type CodexAppServerDefaultPolicy = {
  mode: CodexAppServerPolicyMode;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  approvalsReviewer?: CodexAppServerApprovalsReviewer;
  sandbox?: CodexAppServerSandboxMode;
  dangerFullAccessAllowed?: boolean;
};
export type CodexAppServerApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
export type CodexAppServerApprovalPolicySource = "config" | "env" | "requirements" | "implicit";
export type CodexAppServerEffectiveApprovalPolicy =
  | CodexAppServerApprovalPolicy
  | {
      granular: {
        mcp_elicitations: boolean;
        rules: boolean;
        sandbox_approval: boolean;
        request_permissions?: boolean;
        skill_approval?: boolean;
      };
    };
export type CodexAppServerSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexAppServerApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
type CodexAppServerCommandSource = "managed" | "resolved-managed" | "config" | "env";
export type CodexDynamicToolsLoading = "searchable" | "direct";
export type CodexPluginDestructivePolicy = boolean;

// OpenAI ships first-party Codex plugins across three marketplaces:
// - openai-curated: remote curated marketplace, fetched via `codex plugin marketplace add`
// - openai-bundled: local marketplace that ships with Codex.app and the Codex CLI
//   (browser, chrome, computer-use, latex-tectonic)
// - openai-primary-runtime: marketplace owned by the Codex primary runtime
//   (documents, spreadsheets, presentations)
// All three are owned by OpenAI. Allow activating plugins from any of them.
export const CODEX_PLUGINS_MARKETPLACE_NAMES = [
  "openai-curated",
  "openai-bundled",
  "openai-primary-runtime",
] as const;
export type CodexPluginsMarketplaceName = (typeof CODEX_PLUGINS_MARKETPLACE_NAMES)[number];

// Back-compat constant for callers that still reference the curated marketplace by name.
export const CODEX_PLUGINS_MARKETPLACE_NAME: CodexPluginsMarketplaceName = "openai-curated";

export function isCodexPluginsMarketplaceName(
  name: string | undefined,
): name is CodexPluginsMarketplaceName {
  return (
    name !== undefined && (CODEX_PLUGINS_MARKETPLACE_NAMES as readonly string[]).includes(name)
  );
}

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
  allow_destructive_actions?: CodexPluginDestructivePolicy;
  plugins?: Record<string, CodexPluginEntryConfig>;
};

export type CodexAppServerExperimentalConfig = {
  sandboxExecServer?: boolean;
};

export type ResolvedCodexPluginPolicy = {
  configKey: string;
  marketplaceName: CodexPluginsMarketplaceName;
  pluginName: string;
  enabled: boolean;
  allowDestructiveActions: CodexPluginDestructivePolicy;
};

export type ResolvedCodexPluginsPolicy = {
  configured: boolean;
  enabled: boolean;
  allowDestructiveActions: CodexPluginDestructivePolicy;
  pluginPolicies: ResolvedCodexPluginPolicy[];
};

export type CodexAppServerStartOptions = {
  transport: CodexAppServerTransportMode;
  command: string;
  commandSource?: CodexAppServerCommandSource;
  args: string[];
  url?: string;
  authToken?: string;
  headers: Record<string, string>;
  env?: Record<string, string>;
  clearEnv?: string[];
};

export type CodexAppServerRuntimeOptions = {
  start: CodexAppServerStartOptions;
  codeModeOnly: boolean;
  requestTimeoutMs: number;
  turnCompletionIdleTimeoutMs: number;
  postToolRawAssistantCompletionIdleTimeoutMs?: number;
  approvalPolicy: CodexAppServerEffectiveApprovalPolicy;
  approvalPolicySource?: CodexAppServerApprovalPolicySource;
  sandbox: CodexAppServerSandboxMode;
  approvalsReviewer: CodexAppServerApprovalsReviewer;
  serviceTier?: CodexServiceTier;
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
    command?: string;
    args?: string[] | string;
    url?: string;
    authToken?: string;
    headers?: Record<string, string>;
    clearEnv?: string[];
    codeModeOnly?: boolean;
    requestTimeoutMs?: number;
    turnCompletionIdleTimeoutMs?: number;
    postToolRawAssistantCompletionIdleTimeoutMs?: number;
    approvalPolicy?: CodexAppServerApprovalPolicy;
    sandbox?: CodexAppServerSandboxMode;
    approvalsReviewer?: CodexAppServerApprovalsReviewer;
    serviceTier?: CodexServiceTier | null;
    defaultWorkspaceDir?: string;
    experimental?: CodexAppServerExperimentalConfig;
  };
};

export function shouldAutoApproveCodexAppServerApprovals(
  appServer: Pick<CodexAppServerRuntimeOptions, "approvalPolicy" | "sandbox">,
): boolean {
  return appServer.approvalPolicy === "never" && appServer.sandbox === "danger-full-access";
}

export const CODEX_APP_SERVER_CONFIG_KEYS = [
  "mode",
  "transport",
  "command",
  "args",
  "url",
  "authToken",
  "headers",
  "clearEnv",
  "codeModeOnly",
  "requestTimeoutMs",
  "turnCompletionIdleTimeoutMs",
  "postToolRawAssistantCompletionIdleTimeoutMs",
  "approvalPolicy",
  "sandbox",
  "approvalsReviewer",
  "serviceTier",
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

const codexAppServerTransportSchema = z.enum(["stdio", "websocket"]);
const codexAppServerPolicyModeSchema = z.enum(["yolo", "guardian"]);
const codexAppServerApprovalPolicySchema = z.enum([
  "never",
  "on-request",
  "on-failure",
  "untrusted",
]);
const codexAppServerSandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const codexAppServerApprovalsReviewerSchema = z.enum(["user", "auto_review", "guardian_subagent"]);
const codexDynamicToolsLoadingSchema = z.enum(["searchable", "direct"]);
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

const codexPluginEntryConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    marketplaceName: z.enum(CODEX_PLUGINS_MARKETPLACE_NAMES).optional(),
    pluginName: z.string().trim().min(1).optional(),
    allow_destructive_actions: z.boolean().optional(),
  })
  .strict();

const codexPluginsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    allow_destructive_actions: z.boolean().optional(),
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
        command: z.string().optional(),
        args: z.union([z.array(z.string()), z.string()]).optional(),
        url: z.string().optional(),
        authToken: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        clearEnv: z.array(z.string()).optional(),
        codeModeOnly: z.boolean().optional(),
        requestTimeoutMs: z.number().positive().optional(),
        turnCompletionIdleTimeoutMs: z.number().positive().optional(),
        postToolRawAssistantCompletionIdleTimeoutMs: z.number().positive().optional(),
        approvalPolicy: codexAppServerApprovalPolicySchema.optional(),
        sandbox: codexAppServerSandboxSchema.optional(),
        approvalsReviewer: codexAppServerApprovalsReviewerSchema.optional(),
        serviceTier: codexAppServerServiceTierSchema,
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
  const allowDestructiveActions = config?.allow_destructive_actions ?? true;
  const pluginPolicies = Object.entries(config?.plugins ?? {})
    .flatMap(([configKey, entry]): ResolvedCodexPluginPolicy[] => {
      if (!isCodexPluginsMarketplaceName(entry.marketplaceName) || !entry.pluginName) {
        return [];
      }
      return [
        {
          configKey,
          marketplaceName: entry.marketplaceName,
          pluginName: entry.pluginName,
          enabled: enabled && entry.enabled !== false,
          allowDestructiveActions: entry.allow_destructive_actions ?? allowDestructiveActions,
        },
      ];
    })
    .toSorted((left, right) => left.configKey.localeCompare(right.configKey));
  return {
    configured,
    enabled,
    allowDestructiveActions,
    pluginPolicies,
  };
}

export function resolveCodexAppServerRuntimeOptions(
  params: {
    pluginConfig?: unknown;
    execMode?: OpenClawExecMode;
    execPolicy?: OpenClawExecPolicyForCodexAppServer;
    env?: NodeJS.ProcessEnv;
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
  const authToken = readNonEmptyString(config.authToken);
  const url = readNonEmptyString(config.url);
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
  const forceUserReviewer = execMode !== undefined && execMode !== "auto" && execMode !== "full";
  const forceGuardianReviewer = execMode === "auto";
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
          forceUserReviewer,
          execModeRequiringPromptingApprovals:
            execMode === "auto" || execMode === "ask" ? execMode : undefined,
          requirementsToml: params.requirementsToml,
          requirementsPath: params.requirementsPath,
          readRequirementsFile: params.readRequirementsFile,
          platform: params.platform,
          hostName: params.hostName,
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
  if (transport === "websocket" && !url) {
    throw new Error(
      "plugins.entries.codex.config.appServer.url is required when appServer.transport is websocket",
    );
  }

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
      command,
      commandSource,
      args: args.length > 0 ? args : ["app-server", "--listen", "stdio://"],
      ...(url ? { url } : {}),
      ...(authToken ? { authToken } : {}),
      headers,
      ...(transport === "stdio" && clearEnv.length > 0 ? { clearEnv } : {}),
    },
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
    sandbox:
      forcedPolicy?.sandbox ??
      configuredSandbox ??
      defaultPolicy?.sandbox ??
      (policyMode === "guardian" ? "workspace-write" : "danger-full-access"),
    approvalsReviewer:
      forcedPolicy?.approvalsReviewer ??
      explicitApprovalsReviewer ??
      defaultPolicy?.approvalsReviewer ??
      (policyMode === "guardian" ? "auto_review" : "user"),
    ...(serviceTier ? { serviceTier } : {}),
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
    args: options.args,
    url: options.url ?? null,
    authToken: hashSecretForKey(options.authToken, "authToken"),
    headers: Object.entries(options.headers).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
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
      },
    };
  }
  return {
    granular: {
      mcp_elicitations: true,
      rules: true,
      sandbox_approval: true,
    },
  };
}

function resolveTransport(value: unknown): CodexAppServerTransportMode {
  return value === "websocket" ? "websocket" : "stdio";
}

function resolvePolicyMode(value: unknown): CodexAppServerPolicyMode | undefined {
  return value === "guardian" || value === "yolo" ? value : undefined;
}

function resolveDefaultCodexAppServerPolicy(params: {
  transport: CodexAppServerTransportMode;
  forceGuardian?: boolean;
  forceUserReviewer?: boolean;
  execModeRequiringPromptingApprovals?: Extract<OpenClawExecMode, "auto" | "ask">;
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
        ? selectUserApprovalsReviewer(undefined)
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
      ? selectUserApprovalsReviewer(allowedApprovalsReviewers)
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
  const path =
    readNonEmptyString(params.requirementsPath) ??
    resolveCodexRequirementsPath(params.env ?? process.env, params.platform ?? process.platform);
  try {
    if (params.readRequirementsFile) {
      return params.readRequirementsFile(path);
    }
    return readFileSync(path, "utf8");
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
  if (allowedApprovalPolicies.has("on-failure")) {
    return "on-failure";
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
): CodexAppServerApprovalsReviewer {
  if (allowedApprovalsReviewers === undefined || allowedApprovalsReviewers.has("user")) {
    return "user";
  }
  throw new Error("tools.exec.mode=ask requires Codex app-server user approvals");
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
  return value === "on-request" ||
    value === "on-failure" ||
    value === "untrusted" ||
    value === "never"
    ? value
    : undefined;
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
      .map(([key, child]) => [key.trim(), readNonEmptyString(child)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1])),
  );
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
