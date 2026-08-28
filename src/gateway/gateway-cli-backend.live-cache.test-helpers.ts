import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { computeCacheHitRate } from "../agents/live-cache-test-support.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";

export const MCP_SCHEMA_PROBE_PLUGIN_ID = "mcp-schema-probe";
export const MCP_SCHEMA_PROBE_TOOL_NAME = "mcp_schema_probe_no_args";
export const CLI_CACHE_AUTH_PROFILE_ID = "claude-cli:live-cache";

const execFileAsync = promisify(execFile);

export type RuntimeBackendEntry = ReturnType<
  (typeof import("../plugins/cli-backends.runtime.js"))["resolveRuntimeCliBackends"]
>[number];

export async function initializeCacheProbeGitWorkspace(workspaceDir: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet", workspaceDir]);
  await execFileAsync("git", ["-C", workspaceDir, "config", "user.name", "OpenClaw Tests"]);
  await execFileAsync("git", [
    "-C",
    workspaceDir,
    "config",
    "user.email",
    "openclaw-tests@localhost",
  ]);
  await execFileAsync("git", ["-C", workspaceDir, "add", "--all"]);
  await execFileAsync("git", [
    "-C",
    workspaceDir,
    "commit",
    "--quiet",
    "-m",
    "cache probe baseline",
  ]);
}

type CliCacheUsage = {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export function logCliCacheUsage(turn: string, result: unknown): number {
  const typedResult =
    // SAFETY: agent results expose this optional metadata shape; every field stays optional below.
    result as {
      meta?: {
        agentMeta?: {
          usage?: CliCacheUsage;
          lastCallUsage?: CliCacheUsage;
        };
      };
    };
  const agentMeta = typedResult.meta?.agentMeta;
  const usage = agentMeta?.lastCallUsage ?? agentMeta?.usage;
  if (!usage) {
    throw new Error("Claude CLI cache probe did not return normalized usage metadata");
  }
  const hitRate = computeCacheHitRate(usage);
  process.stderr.write(
    `[gateway-cli-cache] ${turn} input=${usage.input ?? 0} cacheRead=${usage.cacheRead ?? 0} cacheWrite=${usage.cacheWrite ?? 0} hitRate=${(hitRate * 100).toFixed(2)}%\n`,
  );
  return hitRate;
}

export async function createMcpSchemaProbePlugin(
  tempDir: string,
): Promise<{ pluginPath: string; resultToken: string }> {
  const pluginDir = path.join(tempDir, MCP_SCHEMA_PROBE_PLUGIN_ID);
  const resultToken = `MCP-SCHEMA-${randomBytes(6).toString("hex").toUpperCase()}`;
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: MCP_SCHEMA_PROBE_PLUGIN_ID,
        name: "MCP Schema Probe",
        description: "Live test plugin for no-argument MCP tool schemas",
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        contracts: { tools: [MCP_SCHEMA_PROBE_TOOL_NAME] },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "index.cjs"),
    `module.exports = {
  id: "${MCP_SCHEMA_PROBE_PLUGIN_ID}",
  name: "MCP Schema Probe",
  register(api) {
    api.registerTool({
      name: "${MCP_SCHEMA_PROBE_TOOL_NAME}",
      description: "Live test no-argument tool for MCP schema normalization",
      parameters: { type: "object" },
      async execute() {
        return { content: [{ type: "text", text: "${resultToken}" }] };
      },
    });
  },
};
`,
  );
  return { pluginPath: pluginDir, resultToken };
}

export function prepareClaudeCacheProbeBackend(params: {
  config: OpenClawConfig;
  liveBackend: RuntimeBackendEntry;
  providerId: string;
}): RuntimeBackendEntry {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY_OLD?.trim();
  if (!apiKey) {
    throw new Error("Claude CLI cache probe requires an Anthropic API key");
  }
  // Exercise the same profile-owned secret-input path as an operator-configured key.
  // The isolated state directory is removed when this live test finishes.
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        [CLI_CACHE_AUTH_PROFILE_ID]: {
          type: "api_key",
          provider: "claude-cli",
          key: apiKey,
        },
      },
      order: { "claude-cli": [CLI_CACHE_AUTH_PROFILE_ID] },
    },
    resolveAgentDir(params.config, "dev"),
    { syncExternalCli: false },
  );

  // This Vitest gateway uses the minimal startup path, so load the owning bundled plugin
  // explicitly. The production Gateway loads the same runtime registration at startup.
  const registry = loadOpenClawPlugins({
    cache: false,
    config: params.config,
    onlyPluginIds: ["anthropic"],
  });
  const registration = registry.cliBackends.find((entry) => entry.backend.id === params.providerId);
  if (!registration) {
    const pluginStates = registry.plugins
      .map((plugin) => `${plugin.id}:${plugin.status}${plugin.error ? ` (${plugin.error})` : ""}`)
      .join(", ");
    throw new Error(
      `cache probe could not load runtime CLI backend ${params.providerId}; plugins=${pluginStates || "none"}`,
    );
  }
  return {
    ...registration.backend,
    // Keep the live harness's installed command and explicit API-key passthrough while
    // exercising the owning plugin's real prepare/argv hooks.
    config: params.liveBackend.config,
    pluginId: registration.pluginId,
    ...(registration.builtWithOpenClawVersion
      ? { builtWithOpenClawVersion: registration.builtWithOpenClawVersion }
      : {}),
  };
}
