/** Public facade for bundle MCP tool materialization and session-scoped runtime management. */
export type { McpToolCatalogDiagnostic } from "./agent-bundle-mcp-types.js";
export {
  testing,
  testing as __testing,
  disposeAllSessionMcpRuntimes,
  getOrCreateSessionMcpRuntime,
  peekSessionMcpRuntime,
  resolveSessionMcpConfigSummary,
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "./agent-bundle-mcp-runtime.js";
export {
  buildBundleMcpToolsFromCatalog,
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
