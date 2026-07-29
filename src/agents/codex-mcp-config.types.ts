/**
 * Shared types for projecting bundle MCP config into Codex app-server threads.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpDiagnostic } from "../plugins/bundle-mcp.js";

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
};

/** Inputs used to load a Codex bundle-MCP thread config patch. */
export type LoadCodexBundleMcpThreadConfigParams = {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  toolsEnabled?: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
};
