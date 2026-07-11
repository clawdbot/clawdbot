/**
 * Prepares bundled MCP configuration for CLI runner backends.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { tryReadJson } from "../../infra/json-files.js";
import {
  OPENCLAW_TOOLS_MCP_CRESTODIAN_APPROVAL_ARMED_ENV,
  OPENCLAW_TOOLS_MCP_CRESTODIAN_PROPOSAL_ENV,
  OPENCLAW_TOOLS_MCP_TOOLS_ENV,
} from "../../mcp/openclaw-tools-serve-config.js";
import { extractMcpServerMap, type BundleMcpConfig } from "../../plugins/bundle-mcp.js";
import type { CliBundleMcpMode } from "../../plugins/types.js";
import { loadMergedBundleMcpConfig, toCliBundleMcpServerConfig } from "../bundle-mcp-config.js";
import { resolveMcpBearerBundleConfig } from "../mcp-auth-profile.js";
import { isRecord } from "./bundle-mcp-adapter-shared.js";
import {
  findClaudeMcpConfigPath,
  findClaudeMcpConfigPaths,
  injectClaudeMcpConfigArgs,
  writeClaudeMcpCaptureConfig,
} from "./bundle-mcp-claude.js";
import { injectCodexMcpConfigArgs } from "./bundle-mcp-codex.js";
import { writeGeminiMcpCaptureSettings, writeGeminiSystemSettings } from "./bundle-mcp-gemini.js";

type PreparedCliBundleMcpConfig = {
  backend: CliBackendConfig;
  beforeExecution?: () => Promise<void>;
  cleanup?: () => Promise<void>;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
  env?: Record<string, string>;
};

function resolveBundleMcpMode(mode: CliBundleMcpMode | undefined): CliBundleMcpMode {
  return mode ?? "claude-config-file";
}

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

function canonicalizeCrestodianTurnStateForResume(
  server: BundleMcpConfig["mcpServers"][string],
): BundleMcpConfig["mcpServers"][string] {
  if (!isRecord(server.env) || server.env[OPENCLAW_TOOLS_MCP_TOOLS_ENV] !== "crestodian") {
    return server;
  }
  // The host reissues approval authority through a fresh stdio server each turn.
  // Its values may change while tool topology and the native transcript stay safe to resume.
  return {
    ...server,
    env: {
      ...server.env,
      [OPENCLAW_TOOLS_MCP_CRESTODIAN_APPROVAL_ARMED_ENV]: "<crestodian-turn-state>",
      [OPENCLAW_TOOLS_MCP_CRESTODIAN_PROPOSAL_ENV]: "<crestodian-turn-state>",
    },
  };
}

function canonicalizeBundleMcpConfigForResume(config: BundleMcpConfig): BundleMcpConfig {
  // The OpenClaw loopback MCP port changes across runs. Replace it before
  // hashing so resume compatibility tracks config shape, not ephemeral ports.
  const canonicalServers = Object.fromEntries(
    Object.entries(config.mcpServers).map(([name, server]) => {
      const canonicalServer = canonicalizeCrestodianTurnStateForResume(server);
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
}): Promise<PreparedCliBundleMcpConfig> {
  const serializedConfig = `${JSON.stringify(params.mergedConfig, null, 2)}\n`;
  const mcpConfigHash = crypto.createHash("sha256").update(serializedConfig).digest("hex");
  const serializedResumeConfig = `${JSON.stringify(
    canonicalizeBundleMcpConfigForResume(params.mergedConfig),
    null,
    2,
  )}\n`;
  const mcpResumeHash = crypto.createHash("sha256").update(serializedResumeConfig).digest("hex");

  if (params.mode === "codex-config-overrides") {
    return {
      backend: {
        ...params.backend,
        args: injectCodexMcpConfigArgs(params.backend.args, params.mergedConfig),
        resumeArgs: injectCodexMcpConfigArgs(
          params.backend.resumeArgs ?? params.backend.args ?? [],
          params.mergedConfig,
        ),
      },
      mcpConfigHash,
      mcpResumeHash,
      env: params.env,
    };
  }

  if (params.mode === "gemini-system-settings") {
    const settings = await writeGeminiSystemSettings(params.mergedConfig, params.env);
    return {
      backend: params.backend,
      mcpConfigHash,
      mcpResumeHash,
      env: settings.env,
      cleanup: settings.cleanup,
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-"));
  const mcpConfigPath = path.join(tempDir, "mcp.json");
  const runtimeConfig = resolveOpenClawMcpEnvTemplates(
    params.mergedConfig,
    params.env,
  ) as BundleMcpConfig;
  await fs.writeFile(mcpConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf-8");
  return {
    backend: {
      ...params.backend,
      args: injectClaudeMcpConfigArgs(params.backend.args, mcpConfigPath),
      resumeArgs: injectClaudeMcpConfigArgs(
        params.backend.resumeArgs ?? params.backend.args ?? [],
        mcpConfigPath,
      ),
    },
    mcpConfigHash,
    mcpResumeHash,
    env: params.env,
    cleanup: async () => {
      // Claude config files are generated per run and should not survive cleanup.
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

/** Prepare backend args/env/cleanup for bundle MCP injection into a CLI run. */
export async function prepareCliBundleMcpConfig(params: {
  enabled: boolean;
  mode?: CliBundleMcpMode;
  backend: CliBackendConfig;
  workspaceDir: string;
  config?: OpenClawConfig;
  agentDir?: string;
  additionalConfig?: BundleMcpConfig;
  /**
   * Serve exactly these servers, skipping user/plugin/additional merges.
   * Ring-zero Crestodian runs use this so the CLI harness sees only the
   * crestodian MCP server instead of the normal openclaw tool surface.
   */
  exclusiveConfig?: BundleMcpConfig;
  env?: Record<string, string>;
  warn?: (message: string) => void;
}): Promise<PreparedCliBundleMcpConfig> {
  if (!params.enabled) {
    return { backend: params.backend, env: params.env };
  }

  const mode = resolveBundleMcpMode(params.mode);
  if (params.exclusiveConfig) {
    return await prepareModeSpecificBundleMcpConfig({
      mode,
      backend: params.backend,
      mergedConfig: params.exclusiveConfig,
      env: params.env,
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
  });
  for (const diagnostic of bundleConfig.diagnostics) {
    params.warn?.(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  mergedConfig = applyMergePatch(mergedConfig, bundleConfig.config) as BundleMcpConfig;
  if (params.additionalConfig) {
    mergedConfig = applyMergePatch(mergedConfig, params.additionalConfig) as BundleMcpConfig;
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

  return await prepareModeSpecificBundleMcpConfig({
    mode,
    backend: params.backend,
    mergedConfig: resolvedBearerConfig.config,
    env: resolvedBearerConfig.env,
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
  if (resolveBundleMcpMode(params.mode) === "gemini-system-settings") {
    return await writeGeminiMcpCaptureSettings({
      inheritedEnv: params.env,
      captureKey: params.captureKey,
    });
  }
  if (resolveBundleMcpMode(params.mode) === "claude-config-file") {
    const mcpConfigPath =
      findClaudeMcpConfigPath(params.backend?.args) ??
      findClaudeMcpConfigPath(params.backend?.resumeArgs);
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
