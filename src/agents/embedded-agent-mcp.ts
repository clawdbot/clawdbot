import type { SessionToolOverrides } from "../config/sessions/types.js";
/**
 * Embedded agent MCP config loader.
 *
 * Embedded runs use this to merge bundled/plugin MCP server config and return
 * the launchable server map plus diagnostics for the caller.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  BundleMcpDataDirOwnership,
  BundleMcpDiagnostic,
  BundleMcpServerConfig,
} from "../plugins/bundle-mcp.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { loadMergedBundleMcpConfig } from "./bundle-mcp-config.js";

type EmbeddedAgentMcpConfig = {
  mcpServers: Record<string, BundleMcpServerConfig>;
  diagnostics: BundleMcpDiagnostic[];
  prepareDataDirsByServer: Record<string, BundleMcpDataDirOwnership>;
};

/** Loads merged MCP server config for an embedded agent workspace. */
export function loadEmbeddedAgentMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers">;
}): EmbeddedAgentMcpConfig {
  const bundleMcp = loadMergedBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
    toolOverrides: params.toolOverrides,
  });

  return {
    mcpServers: bundleMcp.config.mcpServers,
    diagnostics: bundleMcp.diagnostics,
    prepareDataDirsByServer: bundleMcp.prepareDataDirsByServer,
  };
}
