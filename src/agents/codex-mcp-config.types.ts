import type { SessionToolOverrides } from "../config/sessions/types.js";
/**
 * Shared types for projecting bundle MCP config into Codex app-server threads.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpDiagnostic } from "../plugins/bundle-mcp.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";

/** Codex app-server `mcp_servers` config map. */
export type CodexMcpServersConfig = Record<string, Record<string, unknown>>;

/** Loaded Codex thread-config patch plus diagnostics and cache metadata. */
export type CodexBundleMcpThreadConfig = {
  configPatch?: {
    mcp_servers: CodexMcpServersConfig;
  };
  diagnostics: BundleMcpDiagnostic[];
  evaluated: boolean;
  fingerprint?: string;
  /** Enabled static servers across bundle defaults and owner config. */
  staticServerNames: string[];
  /** Enabled static servers originating from owner `mcp.servers` config. */
  userStaticServerNames: string[];
};

/** Inputs used to load a Codex bundle-MCP thread config patch. */
export type LoadCodexBundleMcpThreadConfigParams = {
  workspaceDir: string;
  agentId?: string;
  /** Read-only initialization cannot provision data directories or requester transports. */
  preparationOnly?: true;
  cfg?: OpenClawConfig;
  toolsEnabled?: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
};
