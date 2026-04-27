import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadEnabledBundleMcpConfig,
  type BundleMcpConfig,
  type BundleMcpDiagnostic,
  type BundleMcpServerConfig,
} from "../plugins/bundle-mcp.js";

export type MergedBundleMcpConfig = {
  config: BundleMcpConfig;
  diagnostics: BundleMcpDiagnostic[];
};

export type BundleMcpServerMapper = (
  server: BundleMcpServerConfig,
  name: string,
) => BundleMcpServerConfig;

const OPENCLAW_TRANSPORT_TO_CLI_BUNDLE_TYPE: Record<string, string> = {
  "streamable-http": "http",
  http: "http",
  sse: "sse",
  stdio: "stdio",
};

/**
 * User config stores OpenClaw MCP transport names, while CLI backends such as
 * Claude Code and Gemini expect a downstream `type` field. Keep this adapter
 * out of the generic merge path because embedded Pi still consumes the raw
 * OpenClaw `transport` shape directly.
 */
export function toCliBundleMcpServerConfig(server: BundleMcpServerConfig): BundleMcpServerConfig {
  const next = { ...server } as Record<string, unknown>;
  const rawTransport = next.transport;
  delete next.transport;
  if (typeof next.type === "string") {
    return next as BundleMcpServerConfig;
  }
  if (typeof rawTransport === "string") {
    const mapped = OPENCLAW_TRANSPORT_TO_CLI_BUNDLE_TYPE[rawTransport];
    if (mapped) {
      next.type = mapped;
    }
  }
  return next as BundleMcpServerConfig;
}

export function loadMergedBundleMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  mapConfiguredServer?: BundleMcpServerMapper;
}): MergedBundleMcpConfig {
  const bundleMcp = loadEnabledBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);
  const mapConfiguredServer = params.mapConfiguredServer ?? ((server) => server);

  return {
    config: {
      // OpenClaw config is the owner-managed layer, so it overrides bundle defaults.
      mcpServers: {
        ...bundleMcp.config.mcpServers,
        ...Object.fromEntries(
          Object.entries(configuredMcp).map(([name, server]) => [
            name,
            mapConfiguredServer(server as BundleMcpServerConfig, name),
          ]),
        ),
      } satisfies BundleMcpConfig["mcpServers"],
    },
    diagnostics: bundleMcp.diagnostics,
  };
}
