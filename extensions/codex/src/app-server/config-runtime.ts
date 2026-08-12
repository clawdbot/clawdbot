import { normalizeTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  CodexAppServerApprovalPolicySource,
  CodexAppServerCommandSource,
  CodexAppServerHomeScope,
  CodexAppServerRemoteAppsSubstrate,
  CodexAppServerRuntimeOptions,
  CodexAppServerSandboxMode,
  CodexAppServerStartOptions,
  CodexManagedCommandOrder,
  CodexComputerUseConfig,
  CodexPluginConfig,
  OpenClawExecMode,
  OpenClawExecPolicyForCodexAppServer,
  ProviderAuthAliasConfig,
  ResolvedCodexComputerUseConfig,
} from "./config-contracts.js";
import {
  assertCodexAppServerAllowedForOpenClawExecMode,
  resolveApprovalPolicy,
  resolveApprovalsReviewer,
  resolveCodexPolicyModeForOpenClawExecMode,
  resolveEffectiveOpenClawExecModeForCodexAppServer,
  resolveSandbox,
  selectForcedDangerFullAccessSandbox,
  selectForcedPromptingSandbox,
} from "./config-exec-policy.js";
import {
  DEFAULT_CODEX_COMPUTER_USE_HEALTH_CHECK_INTERVAL_MINUTES,
  DEFAULT_CODEX_COMPUTER_USE_LIVE_TEST_TIMEOUT_MS,
  DEFAULT_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS,
  DEFAULT_CODEX_COMPUTER_USE_MCP_SERVER_NAME,
  DEFAULT_CODEX_COMPUTER_USE_PLUGIN_NAME,
  DEFAULT_CODEX_COMPUTER_USE_TOOL_CALL_TIMEOUT_MS,
  assertCodexAppServerCommandHasNoInlineArgs,
  readCodexPluginConfig,
} from "./config-parsing.js";
import {
  canUseCodexModelBackedApprovalsReviewerForModel,
  codexConfigEnablesNativeComputerUse,
} from "./config-reviewer.js";
import {
  assertCodexAppServerConnectionSecurity,
  inferCodexAppServerConnectionClass,
  normalizeRemoteWorkspaceRoot,
  resolveCodexAppServerNetworkProxy,
  resolveDefaultCodexAppServerPolicy,
  resolvePolicyMode,
  resolveTransport,
} from "./config-security.js";
import {
  hashSecretForKey,
  normalizeCodexAppServerSecretInput,
  normalizeCodexServiceTier,
  normalizeHeaders,
  normalizePositiveNumber,
  readBooleanEnv,
  readNonEmptyString,
  readNumberEnv,
  resolveArgs,
} from "./config-utils.js";
import type { CodexSandboxPolicy } from "./protocol.js";

/**
 * Sole owner of the app-server home-scope decision. Ordinary harness connections
 * default to the isolated agent home; the supervision connection owns the operator's
 * native Codex home on local transports. Auth handoffs must read the scope from here
 * (or from resolved start options) because a prepared login on a native home rewrites
 * the account Codex CLI and Desktop share.
 */
export function resolveCodexAppServerHomeScope(params: {
  appServer: CodexPluginConfig["appServer"];
  connectionScope?: "harness" | "supervision";
}): CodexAppServerHomeScope {
  const configured = params.appServer?.homeScope;
  if (configured) {
    return configured;
  }
  return params.connectionScope === "supervision" &&
    resolveTransport(params.appServer?.transport) !== "websocket"
    ? "user"
    : "agent";
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
    managedCommandOrder?: CodexManagedCommandOrder;
  } = {},
): CodexAppServerRuntimeOptions {
  const env = params.env ?? process.env;
  const pluginConfig = readCodexPluginConfig(params.pluginConfig);
  const config = pluginConfig.appServer ?? {};
  const transport = resolveTransport(config.transport);
  const homeScope = resolveCodexAppServerHomeScope({ appServer: config });
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
  const clearEnv = normalizeTrimmedStringList(config.clearEnv);
  const authToken = normalizeCodexAppServerSecretInput({
    value: config.authToken,
    path: "plugins.entries.codex.config.appServer.authToken",
  });
  const url = readNonEmptyString(config.url) ?? (transport === "unix" ? "unix://" : undefined);
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
      "plugins.entries.codex.config.appServer.homeScope=user requires appServer.transport=stdio or unix",
    );
  }
  if (transport === "unix" && homeScope !== "user") {
    throw new Error(
      "plugins.entries.codex.config.appServer.transport=unix requires appServer.homeScope=user",
    );
  }
  if (transport === "unix" && !url?.startsWith("unix://")) {
    throw new Error(
      "plugins.entries.codex.config.appServer.url must use unix:// when appServer.transport is unix",
    );
  }
  assertCodexAppServerConnectionSecurity({
    transport,
    url,
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
  const computerUseConfig = resolveCodexComputerUseConfig({
    pluginConfig: params.pluginConfig,
    env,
  });
  const managedCommandOrder =
    params.managedCommandOrder ??
    (homeScope === "user" || computerUseConfig.enabled ? "desktop-first" : "package-first");
  const includeManagedCommandOrder =
    commandSource === "managed" &&
    (managedCommandOrder === "desktop-first" || params.managedCommandOrder === "package-first");
  const managedComputerUsePluginNames = [
    ...new Set([DEFAULT_CODEX_COMPUTER_USE_PLUGIN_NAME, computerUseConfig.pluginName]),
  ];

  return {
    start: {
      transport,
      homeScope,
      command,
      commandSource,
      ...(includeManagedCommandOrder ? { managedCommandOrder } : {}),
      ...(commandSource === "managed" ? { managedComputerUsePluginNames } : {}),
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
    loopDetectionPreToolUseRelay: config.loopDetectionPreToolUseRelay !== false,
    requestTimeoutMs: normalizePositiveNumber(config.requestTimeoutMs, 60_000),
    turnCompletionIdleTimeoutMs: normalizePositiveNumber(
      config.turnCompletionIdleTimeoutMs,
      60_000,
    ),
    turnAssistantCompletionIdleTimeoutMs: normalizePositiveNumber(
      config.turnAssistantCompletionIdleTimeoutMs,
      10_000,
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

/**
 * Rechecks Codex-owned plugin state at the final spawn boundary, where the
 * effective agent home is known, so Computer Use keeps the desktop app's TCC ownership.
 */
export function resolveCodexAppServerStartOptionsForAgent(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  codexConfigToml?: string | null;
  env?: NodeJS.ProcessEnv;
}): CodexAppServerStartOptions {
  const startOptions = params.startOptions;
  if (
    startOptions.transport !== "stdio" ||
    startOptions.commandSource !== "managed" ||
    startOptions.managedCommandOrder !== undefined
  ) {
    return startOptions;
  }
  if (startOptions.homeScope === "user") {
    return { ...startOptions, managedCommandOrder: "desktop-first" };
  }
  const nativeComputerUseEnabled = codexConfigEnablesNativeComputerUse({
    agentDir: params.agentDir,
    codexConfigToml: params.codexConfigToml,
    env: params.env,
    homeScope: "agent",
    pluginNames: startOptions.managedComputerUsePluginNames ?? [
      DEFAULT_CODEX_COMPUTER_USE_PLUGIN_NAME,
    ],
  });
  return nativeComputerUseEnabled
    ? { ...startOptions, managedCommandOrder: "desktop-first" }
    : startOptions;
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
  const configuredPluginName =
    readNonEmptyString(params.overrides?.pluginName) ??
    readNonEmptyString(config.pluginName) ??
    readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_PLUGIN_NAME);
  const configuredMcpServerName =
    readNonEmptyString(params.overrides?.mcpServerName) ??
    readNonEmptyString(config.mcpServerName) ??
    readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_MCP_SERVER_NAME);
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
  const liveTestTimeoutMs = normalizePositiveNumber(
    params.overrides?.liveTestTimeoutMs ??
      config.liveTestTimeoutMs ??
      readNumberEnv(env.OPENCLAW_CODEX_COMPUTER_USE_LIVE_TEST_TIMEOUT_MS),
    DEFAULT_CODEX_COMPUTER_USE_LIVE_TEST_TIMEOUT_MS,
  );
  const toolCallTimeoutMs = normalizePositiveNumber(
    params.overrides?.toolCallTimeoutMs ??
      config.toolCallTimeoutMs ??
      readNumberEnv(env.OPENCLAW_CODEX_COMPUTER_USE_TOOL_CALL_TIMEOUT_MS),
    DEFAULT_CODEX_COMPUTER_USE_TOOL_CALL_TIMEOUT_MS,
  );
  const healthCheckIntervalMinutes = normalizeComputerUseHealthCheckIntervalMinutes(
    params.overrides?.healthCheckIntervalMinutes ??
      config.healthCheckIntervalMinutes ??
      readNumberEnv(env.OPENCLAW_CODEX_COMPUTER_USE_HEALTH_CHECK_INTERVAL_MINUTES),
  );
  const healthCheckEnabled =
    params.overrides?.healthCheckEnabled ??
    config.healthCheckEnabled ??
    readBooleanEnv(env.OPENCLAW_CODEX_COMPUTER_USE_HEALTH_CHECK_ENABLED) ??
    false;
  const pluginCacheMode =
    normalizeComputerUsePluginCacheMode(params.overrides?.pluginCacheMode) ??
    normalizeComputerUsePluginCacheMode(config.pluginCacheMode) ??
    normalizeComputerUsePluginCacheMode(env.OPENCLAW_CODEX_COMPUTER_USE_PLUGIN_CACHE_MODE) ??
    "independent";
  const strictReadiness =
    params.overrides?.strictReadiness ??
    config.strictReadiness ??
    readBooleanEnv(env.OPENCLAW_CODEX_COMPUTER_USE_STRICT_READINESS) ??
    false;
  const autoRepair =
    params.overrides?.autoRepair ??
    config.autoRepair ??
    readBooleanEnv(env.OPENCLAW_CODEX_COMPUTER_USE_AUTO_REPAIR) ??
    false;
  const enabled =
    params.overrides?.enabled ??
    config.enabled ??
    readBooleanEnv(env.OPENCLAW_CODEX_COMPUTER_USE) ??
    Boolean(
      autoInstall ||
      marketplaceSource ||
      marketplacePath ||
      marketplaceName ||
      configuredPluginName ||
      configuredMcpServerName,
    );

  return {
    enabled,
    autoInstall,
    marketplaceDiscoveryTimeoutMs,
    liveTestTimeoutMs,
    toolCallTimeoutMs,
    healthCheckEnabled,
    healthCheckIntervalMinutes,
    pluginCacheMode,
    strictReadiness,
    autoRepair,
    pluginName: configuredPluginName ?? DEFAULT_CODEX_COMPUTER_USE_PLUGIN_NAME,
    mcpServerName: configuredMcpServerName ?? DEFAULT_CODEX_COMPUTER_USE_MCP_SERVER_NAME,
    ...(marketplaceSource ? { marketplaceSource } : {}),
    ...(marketplacePath ? { marketplacePath } : {}),
    ...(marketplaceName ? { marketplaceName } : {}),
  };
}

function normalizeComputerUseHealthCheckIntervalMinutes(value: unknown): 30 | 60 | 120 | 240 {
  return value === 30 || value === 60 || value === 120 || value === 240
    ? value
    : DEFAULT_CODEX_COMPUTER_USE_HEALTH_CHECK_INTERVAL_MINUTES;
}

function normalizeComputerUsePluginCacheMode(value: unknown): "shared" | "independent" | null {
  return value === "shared" || value === "independent" ? value : null;
}

export function codexAppServerStartOptionsKey(
  options: CodexAppServerStartOptions,
  params: {
    authProfileId?: string;
    authBindingFingerprint?: string;
    agentDir?: string;
    fallbackApiKeyCacheKey?: string;
  } = {},
): string {
  return JSON.stringify({
    transport: options.transport,
    command: options.command,
    commandSource: options.commandSource ?? null,
    managedCommandOrder: options.managedCommandOrder ?? "package-first",
    managedComputerUsePluginNames: [...(options.managedComputerUsePluginNames ?? [])].toSorted(),
    managedFallbackCommandPaths: [...(options.managedFallbackCommandPaths ?? [])],
    args: options.args,
    cwd: options.cwd ?? null,
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
    authBindingFingerprint: params.authBindingFingerprint ?? null,
    agentDir: params.agentDir ?? null,
    fallbackApiKeyCacheKey: params.fallbackApiKeyCacheKey ?? null,
  });
}

export function codexSandboxPolicyForTurn(
  mode: CodexAppServerSandboxMode,
  cwd: string,
  nativeArgs: readonly string[] = [],
): CodexSandboxPolicy {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  let excludeTmpdirEnvVar = false;
  let excludeSlashTmp = false;
  for (let index = 0; index < nativeArgs.length; index += 1) {
    const arg = nativeArgs[index];
    const override =
      arg === "-c" || arg === "--config"
        ? nativeArgs[++index]
        : arg?.startsWith("--config=")
          ? arg.slice("--config=".length)
          : undefined;
    if (!override) {
      continue;
    }
    const separator = override.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = override.slice(0, separator).trim();
    const value = override.slice(separator + 1).trim();
    if (value !== "true" && value !== "false") {
      continue;
    }
    if (key === "sandbox_workspace_write.exclude_tmpdir_env_var") {
      excludeTmpdirEnvVar = value === "true";
    } else if (key === "sandbox_workspace_write.exclude_slash_tmp") {
      excludeSlashTmp = value === "true";
    }
  }
  // Native turn/start overrides replace the thread's sandbox. Carry explicit
  // Codex CLI root exclusions forward or /tmp silently becomes writable again.
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar,
    excludeSlashTmp,
  };
}

/** Resolves the passive supervision control connection without changing harness defaults. */
export function resolveCodexSupervisionAppServerRuntimeOptions(
  params: NonNullable<Parameters<typeof resolveCodexAppServerRuntimeOptions>[0]> = {},
): CodexAppServerRuntimeOptions {
  const pluginConfig = readCodexPluginConfig(params.pluginConfig);
  const appServer = pluginConfig.appServer ?? {};
  const homeScope = resolveCodexAppServerHomeScope({
    appServer,
    connectionScope: "supervision",
  });
  return resolveCodexAppServerRuntimeOptions({
    ...params,
    pluginConfig: {
      ...pluginConfig,
      appServer: { ...appServer, homeScope },
    },
  });
}
