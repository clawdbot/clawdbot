import { normalizeConfiguredMcpServers } from "../../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { BundleMcpConfig, BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
import { isValidAgentId, normalizeAgentId } from "../../routing/session-key.js";
import { buildCodexMcpServersConfig, normalizeCodexMcpServerConfig } from "../codex-mcp-config.js";
import { isRecord } from "./bundle-mcp-adapter-shared.js";
import { serializeTomlInlineValue } from "./toml-inline.js";

// Mutable JSON shape structurally compatible with the bundled Codex
// app-server thread-config JsonObject (see the protocol module in the codex
// plugin). Defined locally so this projection result stays assignable to
// mergeCodexThreadConfigs without pulling plugin-local types across the
// extensions boundary.
type CodexThreadConfigValue =
  | string
  | number
  | boolean
  | null
  | CodexThreadConfigValue[]
  | { [key: string]: CodexThreadConfigValue };
type CodexThreadConfigObject = { [key: string]: CodexThreadConfigValue };

type CodexUserMcpServersProjectionOptions = {
  agentId?: string;
};

function normalizeAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => isValidAgentId(entry))
    .map((entry) => normalizeAgentId(entry));
}

function readCodexProjectionConfig(server: BundleMcpServerConfig): Record<string, unknown> {
  return isRecord(server.codex) ? server.codex : {};
}

function isCodexMcpServerAllowedForAgent(
  server: BundleMcpServerConfig,
  options: CodexUserMcpServersProjectionOptions | undefined,
): boolean {
  const codex = readCodexProjectionConfig(server);
  if (!Object.hasOwn(codex, "agents")) {
    return true;
  }
  const agentIds = normalizeAgentIds(codex.agents);
  if (agentIds.length === 0 || !options?.agentId) {
    return false;
  }
  return agentIds.includes(normalizeAgentId(options.agentId));
}

export function injectCodexMcpConfigArgs(
  args: string[] | undefined,
  config: BundleMcpConfig,
): string[] {
  const overrides = serializeTomlInlineValue(buildCodexMcpServersConfig(config));
  return [...(args ?? []), "-c", `mcp_servers=${overrides}`];
}

/**
 * Codex app-server runtime (extensions/codex) receives its thread config as a
 * JSON object through JSON-RPC `thread/start`/`thread/resume`, not as `-c` CLI
 * args. This returns a thread-config patch projecting user-configured
 * `cfg.mcp.servers` entries into Codex's `mcp_servers` table using the same
 * per-server normalization the CLI path uses, so app-server agents see the
 * same user MCP servers the CLI runtime exposes via `injectCodexMcpConfigArgs`.
 *
 * Only user-configured servers (`cfg.mcp.servers`) are projected. Plugin-
 * curated app-server apps are already attached separately through the codex
 * plugin thread-config `apps` patch, so they must not be re-projected here.
 */
export function buildCodexUserMcpServersThreadConfigPatch(
  cfg: OpenClawConfig | undefined,
  options?: CodexUserMcpServersProjectionOptions,
): { mcp_servers: CodexThreadConfigObject } | undefined {
  const userServers = normalizeConfiguredMcpServers(cfg?.mcp?.servers);
  const entries = Object.entries(userServers);
  if (entries.length === 0) {
    return undefined;
  }
  const mcp_servers: CodexThreadConfigObject = {};
  for (const [name, server] of entries) {
    if (!isCodexMcpServerAllowedForAgent(server as BundleMcpServerConfig, options)) {
      continue;
    }
    mcp_servers[name] = normalizeCodexMcpServerConfig(
      name,
      server as BundleMcpServerConfig,
    ) as CodexThreadConfigObject;
  }
  if (Object.keys(mcp_servers).length === 0) {
    return undefined;
  }
  return { mcp_servers };
}
