/** Wraps normalizeToolParameterSchema so malformed external schemas skip the tool instead of crashing the pool. */
import { normalizeToolParameterSchema } from "@openclaw/ai/internal/openai";
import { logWarn } from "../logger.js";
import type { McpCatalogTool } from "./agent-bundle-mcp-types.js";

export function tryNormalizeToolParameterSchema(
  tool: McpCatalogTool,
): Record<string, unknown> | undefined {
  try {
    return normalizeToolParameterSchema(tool.inputSchema) as Record<string, unknown>;
  } catch (error) {
    logWarn(
      `bundle-mcp: failed to materialize tool "${tool.toolName}" from server "${tool.serverName}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}
