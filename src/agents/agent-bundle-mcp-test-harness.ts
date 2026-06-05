/** Test helper for resetting bundle MCP runtime state between harness tests. */
/** Reset session-scoped bundle MCP runtime manager state. */
export async function cleanupBundleMcpHarness(): Promise<void> {
  const { testing } = await import("./agent-bundle-mcp-tools.js");
  await testing.resetSessionMcpRuntimeManager();
}
