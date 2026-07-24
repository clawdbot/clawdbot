/**
 * Server-granular allowlist selection for MCP servers. Answers "which declared
 * static servers does the effective tool allowlist reference?" so a shared-thread
 * harness can expose exactly those as dynamic tools on a scoped-allowlist turn.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { assignSafeServerNames, TOOL_NAME_SEPARATOR } from "./agent-bundle-mcp-names.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import { partitionMcpServersByConnectionScope } from "./mcp-connection-resolver.js";
import { normalizeToolName } from "./tool-policy-shared.js";

/** Allowlist tokens that grant every MCP server. */
function isGlobalMcpAllowToken(token: string): boolean {
  // Mirrors the bundle-MCP allowlist contract in tool-policy: a literal wildcard,
  // the `bundle-mcp` plugin entry, and the `group:plugins` group all mean "every
  // user MCP server".
  return token === "*" || token === "bundle-mcp" || token === "group:plugins";
}

/**
 * Returns true when the effective tool allowlist references a configured MCP
 * server (server-granular): any entry that names the server (`<server>__*` or
 * `<server>__<tool>`) references the whole server.
 *
 * Matching uses the **provider-safe** model-facing server id OpenClaw exposes
 * (`<sanitizedServer>`, see `agent-bundle-mcp-names`), not the raw `mcp.servers`
 * config key, so `safeServerName` must be the sanitized name. Rules over
 * normalized tokens:
 *   - allowlist `undefined`                -> include (no restriction)
 *   - `*` / `bundle-mcp` / `group:plugins` -> include
 *   - `<safeServer>__<anything>`           -> include
 *   - no matching token                    -> exclude the server
 */
function isMcpServerToolAllowlisted(
  safeServerName: string,
  toolsAllow: string[] | undefined,
): boolean {
  if (toolsAllow === undefined) {
    return true;
  }
  const prefix = normalizeToolName(`${safeServerName}${TOOL_NAME_SEPARATOR}`);
  for (const raw of toolsAllow) {
    const token = normalizeToolName(raw);
    if (!token) {
      continue;
    }
    if (isGlobalMcpAllowToken(token)) {
      return true;
    }
    // A `<server>__<...>` entry (glob or specific tool) references this server;
    // require a non-empty fragment after the prefix so a bare `<server>__` does
    // not match.
    if (token.length > prefix.length && token.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Names of declared **static** MCP servers the effective allowlist references.
 * Requester-scoped servers are excluded (they resolve on their own path).
 * Safe names come from the FULL declared set so a collision suffix matches the
 * model-facing tool id the operator's allowlist targets. Returns an empty set
 * when the allowlist imposes no restriction (nothing to narrow to a subset).
 */
export function selectAllowlistedStaticMcpServerNames(params: {
  cfg?: OpenClawConfig;
  workspaceDir: string;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  toolsAllow?: string[];
}): Set<string> {
  const selected = new Set<string>();
  if (params.toolsAllow === undefined) {
    return selected;
  }
  const fullConfig = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    logDiagnostics: false,
    manifestRegistry: params.manifestRegistry,
  });
  const { staticServers } = partitionMcpServersByConnectionScope(fullConfig.loaded.mcpServers);
  const safeServerNamesByServer = assignSafeServerNames(Object.keys(fullConfig.loaded.mcpServers));
  for (const serverName of Object.keys(staticServers)) {
    const safeServerName = safeServerNamesByServer.get(serverName) ?? serverName;
    if (isMcpServerToolAllowlisted(safeServerName, params.toolsAllow)) {
      selected.add(serverName);
    }
  }
  return selected;
}
