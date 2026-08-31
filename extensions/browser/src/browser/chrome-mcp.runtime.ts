/**
 * Lazy Chrome MCP module loader.
 *
 * Keeps the heavy chrome-devtools-mcp adapter behind a runtime import boundary
 * for routes that only need it when existing-session profiles are selected.
 */
type ChromeMcpModule = typeof import("./chrome-mcp.js");

/** Import the Chrome MCP adapter module on demand. */
export async function getChromeMcpModule(): Promise<ChromeMcpModule> {
  return await import("./chrome-mcp.js");
}
