import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  extractMcpServerMap,
  loadEnabledBundleMcpConfig,
  type BundleMcpConfig,
  type BundleMcpServerConfig,
} from "../../plugins/bundle-mcp.js";
import type { CliBundleMcpMode } from "../../plugins/types.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { serializeTomlInlineValue } from "./toml-inline.js";

type PreparedCliBundleMcpConfig = {
  backend: CliBackendConfig;
  cleanup?: () => Promise<void>;
  mcpConfigHash?: string;
  env?: Record<string, string>;
};

function resolveBundleMcpMode(mode: CliBundleMcpMode | undefined): CliBundleMcpMode {
  return mode ?? "claude-config-file";
}

async function readExternalMcpConfig(configPath: string): Promise<BundleMcpConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(configPath, "utf-8")) as unknown;
    return { mcpServers: extractMcpServerMap(raw) };
  } catch {
    return { mcpServers: {} };
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? ({ ...raw } as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function findMcpConfigPath(args?: string[]): string | undefined {
  if (!args?.length) {
    return undefined;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--mcp-config") {
      return normalizeOptionalString(args[i + 1]);
    }
    if (arg.startsWith("--mcp-config=")) {
      return normalizeOptionalString(arg.slice("--mcp-config=".length));
    }
  }
  return undefined;
}

function injectClaudeMcpConfigArgs(args: string[] | undefined, mcpConfigPath: string): string[] {
  const next: string[] = [];
  for (let i = 0; i < (args?.length ?? 0); i += 1) {
    const arg = args?.[i] ?? "";
    if (arg === "--strict-mcp-config") {
      continue;
    }
    if (arg === "--mcp-config") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--mcp-config=")) {
      continue;
    }
    next.push(arg);
  }
  next.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => {
    return typeof entry[1] === "string";
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function decodeHeaderEnvPlaceholder(value: string): { envVar: string; bearer: boolean } | null {
  const bearerMatch = /^Bearer \${([A-Z0-9_]+)}$/.exec(value);
  if (bearerMatch) {
    return { envVar: bearerMatch[1], bearer: true };
  }
  const envMatch = /^\${([A-Z0-9_]+)}$/.exec(value);
  if (envMatch) {
    return { envVar: envMatch[1], bearer: false };
  }
  return null;
}

function applyCommonServerConfig(
  next: Record<string, unknown>,
  server: BundleMcpServerConfig,
): void {
  if (typeof server.command === "string") {
    next.command = server.command;
  }
  const args = normalizeStringArray(server.args);
  if (args) {
    next.args = args;
  }
  const env = normalizeStringRecord(server.env);
  if (env) {
    next.env = env;
  }
  if (typeof server.cwd === "string") {
    next.cwd = server.cwd;
  }
  if (typeof server.url === "string") {
    next.url = server.url;
  }
}

function normalizeCodexServerConfig(server: BundleMcpServerConfig): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  applyCommonServerConfig(next, server);
  const httpHeaders = normalizeStringRecord(server.headers);
  if (httpHeaders) {
    const staticHeaders: Record<string, string> = {};
    const envHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(httpHeaders)) {
      const decoded = decodeHeaderEnvPlaceholder(value);
      if (!decoded) {
        staticHeaders[name] = value;
        continue;
      }
      if (decoded.bearer && normalizeOptionalLowercaseString(name) === "authorization") {
        next.bearer_token_env_var = decoded.envVar;
        continue;
      }
      envHeaders[name] = decoded.envVar;
    }
    if (Object.keys(staticHeaders).length > 0) {
      next.http_headers = staticHeaders;
    }
    if (Object.keys(envHeaders).length > 0) {
      next.env_http_headers = envHeaders;
    }
  }
  return next;
}

function resolveEnvPlaceholder(
  value: string,
  inheritedEnv: Record<string, string> | undefined,
): string {
  const decoded = decodeHeaderEnvPlaceholder(value);
  if (!decoded) {
    return value;
  }
  const resolved = inheritedEnv?.[decoded.envVar] ?? process.env[decoded.envVar] ?? "";
  return decoded.bearer ? `Bearer ${resolved}` : resolved;
}

function normalizeGeminiServerConfig(
  server: BundleMcpServerConfig,
  inheritedEnv: Record<string, string> | undefined,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  applyCommonServerConfig(next, server);
  if (typeof server.type === "string") {
    next.type = server.type;
  }
  const headers = normalizeStringRecord(server.headers);
  if (headers) {
    next.headers = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        resolveEnvPlaceholder(value, inheritedEnv),
      ]),
    );
  }
  if (typeof server.trust === "boolean") {
    next.trust = server.trust;
  }
  return next;
}

function injectCodexMcpConfigArgs(args: string[] | undefined, config: BundleMcpConfig): string[] {
  const overrides = serializeTomlInlineValue(
    Object.fromEntries(
      Object.entries(config.mcpServers).map(([name, server]) => [
        name,
        normalizeCodexServerConfig(server),
      ]),
    ),
  );
  return [...(args ?? []), "-c", `mcp_servers=${overrides}`];
}

async function writeGeminiSystemSettings(
  mergedConfig: BundleMcpConfig,
  inheritedEnv: Record<string, string> | undefined,
): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gemini-mcp-"));
  const settingsPath = path.join(tempDir, "settings.json");
  const existingSettingsPath =
    inheritedEnv?.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  const base =
    typeof existingSettingsPath === "string" && existingSettingsPath.trim()
      ? await readJsonObject(existingSettingsPath)
      : {};
  const normalizedConfig: BundleMcpConfig = {
    mcpServers: Object.fromEntries(
      Object.entries(mergedConfig.mcpServers).map(([name, server]) => [
        name,
        normalizeGeminiServerConfig(server, inheritedEnv),
      ]),
    ) as BundleMcpConfig["mcpServers"],
  };
  const settings = applyMergePatch(base, {
    mcp: {
      allowed: Object.keys(normalizedConfig.mcpServers),
    },
    mcpServers: normalizedConfig.mcpServers,
  }) as Record<string, unknown>;
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  return {
    env: {
      ...inheritedEnv,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath,
    },
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
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
      env: params.env,
    };
  }

  if (params.mode === "gemini-system-settings") {
    const settings = await writeGeminiSystemSettings(params.mergedConfig, params.env);
    return {
      backend: params.backend,
      mcpConfigHash,
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
      ? (findMcpConfigPath(params.backend.resumeArgs) ?? findMcpConfigPath(params.backend.args))
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

  const bundleConfig = loadEnabledBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.config,
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
