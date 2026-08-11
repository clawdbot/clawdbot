import type { McpCatalogTool } from "./agent-bundle-mcp-types.js";

export function isMcpToolModelVisible(tool: Pick<McpCatalogTool, "uiVisibility">): boolean {
  return tool.uiVisibility === undefined || tool.uiVisibility.includes("model");
}
