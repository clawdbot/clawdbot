import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { tryReadJson } from "../../infra/json-files.js";
import { extractMcpServerMap, type BundleMcpConfig } from "../../plugins/bundle-mcp.js";
import type { CliBundleMcpMode } from "../../plugins/types.js";
import { loadMergedBundleMcpConfig, toCliBundleMcpServerConfig } from "../bundle-mcp-config.js";
import { isRecord } from "./bundle-mcp-adapter-shared.js";
import { findClaudeMcpConfigPath, injectClaudeMcpConfigArgs } from "./bundle-mcp-claude.js";
import { injectCodexMcpConfigArgs } from "./bundle-mcp-codex.js";
import { writeGeminiSystemSettings } from "./bundle-mcp-gemini.js";

type PreparedCliBundleMcpConfig = {
  backend: CliBackendConfig;
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

function canonicalizeBundleMcpConfigForResume(config: BundleMcpConfig): BundleMcpConfig {
  const canonicalServers = Object.fromEntries(
    Object.entries(config.mcpServers).map(([name, server]) => {
      if (name !== "openclaw" || typeof server.url !== "string") {
        return [name, sortJsonValue(server)];
      }
      return [
        name,
        sortJsonValue({
          ...server,
          url: normalizeOpenClawLoopbackUrl(server.url),
        }),
      ];
    }),
  ) as BundleMcpConfig["mcpServers"];
  return {
    mcpServers: sortJsonValue(canonicalServers) as BundleMcpConfig["mcpServers"],
  };
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
  await fs.writeFile(mcpConfigPath, serializedConfig, "utf-8");
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
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

export async function prepareCliBundleMcpConfig(params: {
  enabled: boolean;
  mode?: CliBundleMcpMode;
  backend: CliBackendConfig;
  workspaceDir: string;
  config?: OpenClawConfig;
  additionalConfig?: BundleMcpConfig;
  env?: Record<string, string>;
  warn?: (message: string) => void;
}): Promise<PreparedCliBundleMcpConfig> {
  if (!params.enabled) {
    return { backend: params.backend, env: params.env };
  }

  const mode = resolveBundleMcpMode(params.mode);
  const existingMcpConfigPath =
    mode === "claude-config-file"
      ? (findClaudeMcpConfigPath(params.backend.resumeArgs) ??
        findClaudeMcpConfigPath(params.backend.args))
      : undefined;
  let mergedConfig: BundleMcpConfig = { mcpServers: {} };

  if (existingMcpConfigPath) {
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

  return await prepareModeSpecificBundleMcpConfig({
    mode,
    backend: params.backend,
    mergedConfig,
    env: params.env,
  });
}
