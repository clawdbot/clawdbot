import { normalizeConfiguredMcpServers } from "../../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { BundleMcpConfig, BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import {
  applyCommonServerConfig,
  decodeHeaderEnvPlaceholder,
  normalizeStringRecord,
} from "./bundle-mcp-adapter-shared.js";
import { buildCodexMcpServersConfig } from "../codex-mcp-config.js";
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

function isOpenClawLoopbackMcpServer(name: string, server: BundleMcpServerConfig): boolean {
  return (
    name === "openclaw" &&
    typeof server.url === "string" &&
    /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/mcp(?:[?#].*)?$/.test(server.url)
  );
}

function normalizeCodexServerConfig(
  name: string,
  server: BundleMcpServerConfig,
): CodexThreadConfigObject {
  const next: CodexThreadConfigObject = {};
  applyCommonServerConfig(next, server);
  if (isOpenClawLoopbackMcpServer(name, server)) {
    next.default_tools_approval_mode = "approve";
  }
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
): { mcp_servers: CodexThreadConfigObject } | undefined {
  const userServers = normalizeConfiguredMcpServers(cfg?.mcp?.servers);
  const entries = Object.entries(userServers);
  if (entries.length === 0) {
    return undefined;
  }
  const mcp_servers: CodexThreadConfigObject = {};
  for (const [name, server] of entries) {
    mcp_servers[name] = normalizeCodexServerConfig(name, server as BundleMcpServerConfig);
  }
  return { mcp_servers };
}
