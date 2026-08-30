/**
 * Prepares bundled MCP configuration for CLI runner backends.
 */
import crypto from "node:crypto";
import path from "node:path";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { SessionToolOverrides } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { tryReadJson } from "../../infra/json-files.js";
import {
  OPENCLAW_TOOLS_MCP_SYSTEM_AGENT_APPROVAL_ARMED_ENV,
  OPENCLAW_TOOLS_MCP_SYSTEM_AGENT_PROPOSAL_ENV,
  OPENCLAW_TOOLS_MCP_TOOLS_ENV,
} from "../../mcp/openclaw-tools-serve-config.js";
import {
  extractMcpServerMap,
  type BundleMcpConfig,
  type BundleMcpServerConfig,
} from "../../plugins/bundle-mcp.js";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import type { CliBundleMcpMode } from "../../plugins/types.js";
import { getOrCreateSessionMcpRuntime } from "../agent-bundle-mcp-manager-api.js";
import { isRecord } from "../bundle-mcp-adapter.js";
import {
  loadMergedBundleMcpConfig,
  prepareOwnedBundleMcpDataDirs,
  toCliBundleMcpServerConfig,
} from "../bundle-mcp-config.js";
import type { ResolvedConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { resolveMcpBearerBundleConfig } from "../mcp-auth-profile.js";
import {
  applyPreparedNativeMcpPolicy,
  prepareNativeMcpPolicy,
  preparedNativeMcpDenials,
} from "../native-mcp-policy.js";
import {
  findClaudeMcpConfigPaths,
  injectClaudeMcpConfigArgs,
  injectClaudeWebSearchDisabledArgs,
  writeClaudeMcpCaptureConfig,
} from "./bundle-mcp-claude.js";
import { injectCodexMcpConfigArgs } from "./bundle-mcp-codex.js";
import {
  writeGeminiMcpCaptureSettings,
  writeGeminiSystemSettings,
  writeGeminiWebSearchDisabledSettings,
} from "./bundle-mcp-gemini.js";
import { injectBundleMcpBackendArgs, writeTemporaryBundleMcpJson } from "./bundle-mcp-runtime.js";

type PreparedCliBundleMcpConfig = {
  backend: CliBackendConfig;
  beforeExecution?: () => Promise<void>;
  cleanup?: () => Promise<void>;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
  env?: Record<string, string>;
};

async function readExternalMcpConfig(configPath: string): Promise<BundleMcpConfig> {
  return { mcpServers: extractMcpServerMap(await tryReadJson<unknown>(configPath)) };
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function normalizeOpenClawLoopbackUrl(value: string): string {
  const match =
    /^(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])):\d+(\/mcp)$/.exec(value.trim()) ?? undefined;
  if (!match) {
    return value;
  }
  return `${match[1]}:<openclaw-loopback>${match[2]}`;
}

function canonicalizeSystemAgentTurnStateForResume(
  server: BundleMcpConfig["mcpServers"][string],
): BundleMcpConfig["mcpServers"][string] {
  if (!isRecord(server.env) || server.env[OPENCLAW_TOOLS_MCP_TOOLS_ENV] !== "openclaw") {
    return server;
  }
  // The host reissues approval authority through a fresh stdio server each turn.
  // Its values may change while tool topology and the native transcript stay safe to resume.
  return {
    ...server,
    env: {
      ...server.env,
      [OPENCLAW_TOOLS_MCP_SYSTEM_AGENT_APPROVAL_ARMED_ENV]: "<openclaw-turn-state>",
      [OPENCLAW_TOOLS_MCP_SYSTEM_AGENT_PROPOSAL_ENV]: "<openclaw-turn-state>",
    },
  };
}

function canonicalizeBundleMcpConfigForResume(config: BundleMcpConfig): BundleMcpConfig {
  // The OpenClaw loopback MCP port changes across runs. Replace it before
  // hashing so resume compatibility tracks config shape, not ephemeral ports.
  const canonicalServers = Object.fromEntries(
    Object.entries(config.mcpServers).map(([name, server]) => {
      const canonicalServer = canonicalizeSystemAgentTurnStateForResume(server);
      if (name !== "openclaw" || typeof canonicalServer.url !== "string") {
        return [name, sortJsonValue(canonicalServer)];
      }
      return [
        name,
        sortJsonValue({
          ...canonicalServer,
          url: normalizeOpenClawLoopbackUrl(canonicalServer.url),
        }),
      ];
    }),
  ) as BundleMcpConfig["mcpServers"];
  return {
    mcpServers: sortJsonValue(canonicalServers) as BundleMcpConfig["mcpServers"],
  };
}

const OPENCLAW_MCP_ENV_TEMPLATE_PATTERN = /\$\{(OPENCLAW_MCP_[A-Z0-9_]+)\}/g;

function normalizeMcpToolDenials(
  value?: Record<string, string[]>,
): Record<string, string[]> | undefined {
  const entries = Object.entries(value ?? {})
    .map(([serverName, toolNames]) => [serverName, [...new Set(toolNames)].toSorted()] as const)
    .filter(([, toolNames]) => toolNames.length > 0)
    .toSorted(([left], [right]) => left.localeCompare(right));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function applyCodexMcpToolDenials(
  config: BundleMcpConfig,
  denials: Record<string, string[]> | undefined,
): BundleMcpConfig {
  if (!denials) {
    return config;
  }
  return {
    mcpServers: Object.fromEntries(
      Object.entries(config.mcpServers).map(([serverName, server]) => {
        const denied = Object.hasOwn(denials, serverName) ? denials[serverName] : undefined;
        if (!denied?.length) {
          return [serverName, server];
        }
        const toolFilter = isRecord(server.toolFilter) ? server.toolFilter : {};
        const existing = Array.isArray(toolFilter.exclude)
          ? toolFilter.exclude.filter((name): name is string => typeof name === "string")
          : [];
        return [
          serverName,
          {
            ...server,
            toolFilter: {
              ...toolFilter,
              exclude: [...new Set([...existing, ...denied])].toSorted(),
            },
          } satisfies BundleMcpServerConfig,
        ];
      }),
    ),
  };
}

function applyMcpServerOverrides(
  config: BundleMcpConfig,
  overrides: Record<string, boolean> | undefined,
): BundleMcpConfig {
  return overrides
    ? {
        mcpServers: Object.fromEntries(
          Object.entries(config.mcpServers).filter(
            ([serverName]) =>
              !Object.hasOwn(overrides, serverName) || overrides[serverName] !== false,
          ),
        ),
      }
    : config;
}

function resolveOpenClawMcpEnvTemplates(value: unknown, env?: Record<string, string>): unknown {
  if (!env) {
    return value;
  }
  if (typeof value === "string") {
    return value.replace(OPENCLAW_MCP_ENV_TEMPLATE_PATTERN, (match, name: string) => {
      const replacement = env[name];
      return Object.hasOwn(env, name) && replacement !== undefined ? replacement : match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveOpenClawMcpEnvTemplates(entry, env));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, resolveOpenClawMcpEnvTemplates(entry, env)]),
  );
}

async function prepareModeSpecificBundleMcpConfig(params: {
  mode: CliBundleMcpMode;
  backend: CliBackendConfig;
  mergedConfig: BundleMcpConfig;
  env?: Record<string, string>;
  mcpToolsDeny?: Record<string, string[]>;
  webSearchEnabled?: boolean;
}): Promise<PreparedCliBundleMcpConfig> {
  const mcpToolsDeny = normalizeMcpToolDenials(params.mcpToolsDeny);
  const webSearchDisabled = params.webSearchEnabled === false;
  const configHashInput =
    mcpToolsDeny || webSearchDisabled
      ? { config: params.mergedConfig, mcpToolsDeny, webSearchDisabled }
      : params.mergedConfig;
  const serializedConfig = `${JSON.stringify(configHashInput, null, 2)}\n`;
  const mcpConfigHash = crypto.createHash("sha256").update(serializedConfig).digest("hex");
  const serializedResumeConfig = `${JSON.stringify(
    mcpToolsDeny || webSearchDisabled
      ? {
          config: canonicalizeBundleMcpConfigForResume(params.mergedConfig),
          mcpToolsDeny,
          webSearchDisabled,
        }
      : canonicalizeBundleMcpConfigForResume(params.mergedConfig),
    null,
    2,
  )}\n`;
  const mcpResumeHash = crypto.createHash("sha256").update(serializedResumeConfig).digest("hex");

  if (params.mode === "codex-config-overrides") {
    const codexConfig = applyCodexMcpToolDenials(params.mergedConfig, mcpToolsDeny);
    return {
      backend: injectBundleMcpBackendArgs(params.backend, (args) =>
        webSearchDisabled
          ? [...injectCodexMcpConfigArgs(args, codexConfig), "-c", 'web_search="disabled"']
          : injectCodexMcpConfigArgs(args, codexConfig),
      ),
      mcpConfigHash,
      mcpResumeHash,
      env: params.env,
    };
  }

  if (params.mode === "gemini-system-settings") {
    const settings = await writeGeminiSystemSettings(
      params.mergedConfig,
      params.env,
      mcpToolsDeny,
      params.webSearchEnabled,
    );
    return {
      backend: params.backend,
      mcpConfigHash,
      mcpResumeHash,
      env: settings.env,
      cleanup: settings.cleanup,
    };
  }

  const runtimeConfig = resolveOpenClawMcpEnvTemplates(
    params.mergedConfig,
    params.env,
  ) as BundleMcpConfig;
  const claudeConfig: BundleMcpConfig = {
    mcpServers: Object.fromEntries(
      Object.entries(runtimeConfig.mcpServers).map(([name, server]) => {
        const { toolFilter: _toolFilter, ...nativeServer } = server;
        return [name, nativeServer];
      }),
    ),
  };
  const temporary = await writeTemporaryBundleMcpJson(
    "openclaw-cli-mcp-",
    claudeConfig,
    "mcp.json",
    false,
  );
  return {
    backend: injectBundleMcpBackendArgs(params.backend, (args) =>
      injectClaudeMcpConfigArgs(args, temporary.filePath, mcpToolsDeny, params.webSearchEnabled),
    ),
    mcpConfigHash,
    mcpResumeHash,
    env: params.env,
    cleanup: temporary.cleanup,
  };
}

async function prepareCliWebSearchDisabled(params: {
  mode: CliBundleMcpMode;
  backend: CliBackendConfig;
  env?: Record<string, string>;
}): Promise<PreparedCliBundleMcpConfig> {
  const fingerprint = crypto.createHash("sha256").update("web-search-disabled-v1").digest("hex");
  if (params.mode === "gemini-system-settings") {
    const settings = await writeGeminiWebSearchDisabledSettings(params.env);
    return {
      backend: params.backend,
      env: settings.env,
      cleanup: settings.cleanup,
      mcpConfigHash: fingerprint,
      mcpResumeHash: fingerprint,
    };
  }
  const backend = injectBundleMcpBackendArgs(params.backend, (args) =>
    params.mode === "codex-config-overrides"
      ? [...(args ?? []), "-c", 'web_search="disabled"']
      : injectClaudeWebSearchDisabledArgs(args),
  );
  return { backend, env: params.env, mcpConfigHash: fingerprint, mcpResumeHash: fingerprint };
}

/** Prepare backend args/env/cleanup for bundle MCP injection into a CLI run. */
export async function prepareCliBundleMcpConfig(params: {
  enabled: boolean;
  mode?: CliBundleMcpMode;
  backend: CliBackendConfig;
  workspaceDir: string;
  config?: OpenClawConfig;
  toolOverrides?: SessionToolOverrides;
  agentDir?: string;
  additionalConfig?: BundleMcpConfig;
  /**
   * Serve exactly these servers, skipping user/plugin/additional merges.
   * Ring-zero OpenClaw runs use this so the CLI harness sees only the
   * openclaw MCP server instead of the normal openclaw tool surface.
   */
  exclusiveConfig?: BundleMcpConfig;
  env?: Record<string, string>;
  warn?: (message: string) => void;
  nativeMcpPolicy?: {
    sessionId: string;
    sessionKey?: string;
    capabilityProfile: ResolvedConversationCapabilityProfile;
    runtimeToolsAllow?: string[];
  };
}): Promise<PreparedCliBundleMcpConfig> {
  if (!params.enabled) {
    return params.toolOverrides?.webSearch === false
      ? await prepareCliWebSearchDisabled({
          mode: params.mode ?? "claude-config-file",
          backend: params.backend,
          env: params.env,
        })
      : { backend: params.backend, env: params.env };
  }

  const mode = params.mode ?? "claude-config-file";
  if (params.exclusiveConfig) {
    return await prepareModeSpecificBundleMcpConfig({
      mode,
      backend: params.backend,
      mergedConfig: applyMcpServerOverrides(
        params.exclusiveConfig,
        params.toolOverrides?.mcpServers,
      ),
      env: params.env,
      mcpToolsDeny: params.toolOverrides?.mcpToolsDeny,
      webSearchEnabled: params.toolOverrides?.webSearch,
    });
  }
  const resumeMcpConfigPaths =
    mode === "claude-config-file" ? findClaudeMcpConfigPaths(params.backend.resumeArgs) : [];
  const existingMcpConfigPaths =
    mode === "claude-config-file" && resumeMcpConfigPaths.length > 0
      ? resumeMcpConfigPaths
      : mode === "claude-config-file"
        ? findClaudeMcpConfigPaths(params.backend.args)
        : [];
  let mergedConfig: BundleMcpConfig = { mcpServers: {} };

  for (const existingMcpConfigPath of existingMcpConfigPaths) {
    // Merge any user-provided Claude MCP config first so bundle/plugin config can
    // override intentionally managed server entries.
    const resolvedExistingPath = path.isAbsolute(existingMcpConfigPath)
      ? existingMcpConfigPath
      : path.resolve(params.workspaceDir, existingMcpConfigPath);
    mergedConfig = applyMergePatch(
      mergedConfig,
      await readExternalMcpConfig(resolvedExistingPath),
    ) as BundleMcpConfig;
  }

  const bundleConfig = loadMergedBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.config,
    mapConfiguredServer: toCliBundleMcpServerConfig,
    toolOverrides: params.toolOverrides,
  });
  for (const diagnostic of bundleConfig.diagnostics) {
    params.warn?.(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  mergedConfig = applyMergePatch(mergedConfig, bundleConfig.config) as BundleMcpConfig;
  const prepareDataDirsByServer = { ...bundleConfig.prepareDataDirsByServer };
  const additionalServerNames = new Set(Object.keys(params.additionalConfig?.mcpServers ?? {}));
  if (params.additionalConfig) {
    mergedConfig = applyMergePatch(mergedConfig, params.additionalConfig) as BundleMcpConfig;
    for (const serverName of Object.keys(params.additionalConfig.mcpServers)) {
      delete prepareDataDirsByServer[serverName];
    }
  }
  const resolvedBearerConfig = await resolveMcpBearerBundleConfig({
    config: mergedConfig,
    cfg: params.config,
    agentDir: params.agentDir,
    env: params.env,
    omitUnavailableOAuthServers: true,
    onServerUnavailable: (serverName, error) =>
      params.warn?.(
        `bundle MCP skipped unavailable OAuth server ${serverName}: ${formatErrorMessage(error)}`,
      ),
  });

  const preparedDataDirs = prepareOwnedBundleMcpDataDirs({
    config: applyMcpServerOverrides(resolvedBearerConfig.config, params.toolOverrides?.mcpServers),
    prepareDataDirsByServer,
  });
  for (const diagnostic of preparedDataDirs.diagnostics) {
    params.warn?.(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
  }

  let effectiveConfig = preparedDataDirs.config;
  let effectiveDenials = params.toolOverrides?.mcpToolsDeny;
  const policyConfig: BundleMcpConfig = {
    mcpServers: Object.fromEntries(
      Object.entries(effectiveConfig.mcpServers).filter(
        ([serverName]) => !additionalServerNames.has(serverName),
      ),
    ),
  };
  if (params.nativeMcpPolicy && Object.keys(policyConfig.mcpServers).length > 0) {
    const runtimeConfig: OpenClawConfig = {
      ...params.config,
      mcp: { ...params.config?.mcp, servers: policyConfig.mcpServers },
    };
    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: params.nativeMcpPolicy.sessionId,
      sessionKey: params.nativeMcpPolicy.sessionKey,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      cfg: runtimeConfig,
      toolOverrides: params.toolOverrides,
    });
    const policy = await prepareNativeMcpPolicy({
      runtime,
      config: params.config,
      workspaceDir: params.workspaceDir,
      capabilityProfile: params.nativeMcpPolicy.capabilityProfile,
      runtimeToolsAllow: params.nativeMcpPolicy.runtimeToolsAllow,
      warn: params.warn ?? (() => {}),
    });
    effectiveConfig = {
      mcpServers: {
        ...applyPreparedNativeMcpPolicy(policyConfig, policy).mcpServers,
        ...Object.fromEntries(
          Object.entries(effectiveConfig.mcpServers).filter(([serverName]) =>
            additionalServerNames.has(serverName),
          ),
        ),
      },
    };
    const preservedAdditionalDenials = Object.fromEntries(
      Object.entries(params.toolOverrides?.mcpToolsDeny ?? {}).filter(([serverName]) =>
        additionalServerNames.has(serverName),
      ),
    );
    const combinedDenials = {
      ...preparedNativeMcpDenials(policy),
      ...preservedAdditionalDenials,
    };
    effectiveDenials = Object.keys(combinedDenials).length > 0 ? combinedDenials : undefined;
  }

  return await prepareModeSpecificBundleMcpConfig({
    mode,
    backend: params.backend,
    mergedConfig: effectiveConfig,
    env: resolvedBearerConfig.env,
    mcpToolsDeny: effectiveDenials,
    webSearchEnabled: params.toolOverrides?.webSearch,
  });
}

/** Prepares a per-attempt capture token without changing resume compatibility hashes. */
export async function prepareCliBundleMcpCaptureAttempt(params: {
  mode?: CliBundleMcpMode;
  backend?: CliBackendConfig;
  env?: Record<string, string>;
  captureKey?: string;
}): Promise<{ env?: Record<string, string>; cleanup?: () => Promise<void> }> {
  if (!params.captureKey) {
    return { env: params.env };
  }
  if ((params.mode ?? "claude-config-file") === "gemini-system-settings") {
    return await writeGeminiMcpCaptureSettings({
      inheritedEnv: params.env,
      captureKey: params.captureKey,
    });
  }
  if ((params.mode ?? "claude-config-file") === "claude-config-file") {
    const mcpConfigPath =
      findClaudeMcpConfigPaths(params.backend?.args)[0] ??
      findClaudeMcpConfigPaths(params.backend?.resumeArgs)[0];
    if (mcpConfigPath) {
      await writeClaudeMcpCaptureConfig({
        mcpConfigPath,
        captureKey: params.captureKey,
      });
    }
  }
  return {
    env: {
      ...params.env,
      OPENCLAW_MCP_CLI_CAPTURE_KEY: params.captureKey,
    },
  };
}
