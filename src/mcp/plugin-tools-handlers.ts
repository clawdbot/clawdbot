import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agents/pi-tools.before-tool-call.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { formatErrorMessage } from "../infra/errors.js";

type CallPluginToolParams = {
  name: string;
  arguments?: unknown;
};

function resolveJsonSchemaForTool(tool: AnyAgentTool): Record<string, unknown> {
  const params = tool.parameters;
  if (params && typeof params === "object" && "type" in params) {
    return params as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

export function createPluginToolsMcpHandlers(tools: AnyAgentTool[]) {
  const wrappedTools = tools.map((tool) => {
    if (isToolWrappedWithBeforeToolCallHook(tool)) {
      return tool;
    }
    // The ACPX MCP bridge should enforce the same pre-execution hook boundary
    // as the agent and HTTP tool execution paths.
    return wrapToolWithBeforeToolCallHook(tool);
  });
  const toolMap = new Map<string, AnyAgentTool>();
  for (const tool of wrappedTools) {
    toolMap.set(tool.name, tool);
  }

  return {
    listTools: async () => ({
      tools: wrappedTools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: resolveJsonSchemaForTool(tool),
      })),
    }),
    callTool: async (params: CallPluginToolParams) => {
      const tool = toolMap.get(params.name);
      if (!tool) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${params.name}` }],
          isError: true,
        };
      }
      try {
        const result = await tool.execute(`mcp-${Date.now()}`, params.arguments ?? {});
        return {
          content: Array.isArray(result.content)
            ? result.content
            : [{ type: "text", text: String(result.content) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Tool error: ${formatErrorMessage(err)}` }],
          isError: true,
        };
      }
    },
  };
}
