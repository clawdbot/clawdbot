import "./mcp-ui-resource.js";

type McpUiResourceTestApi = {
  clearViewStore(): void;
};

export const testing = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.mcpUiResourceTestApi")
] as McpUiResourceTestApi;
