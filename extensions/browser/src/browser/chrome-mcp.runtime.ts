export type ChromeMcpModule = typeof import("./chrome-mcp.js");

export async function getChromeMcpModule(): Promise<ChromeMcpModule> {
  return await import("./chrome-mcp.js");
}
