import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Plugin MCP tool handlers route plugin tool calls through the active runtime.
import {
  consumeAdjustedParamsForToolCall,
  isToolWrappedWithBeforeToolCallHook,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agents/agent-tools.before-tool-call.js";
import { BEFORE_TOOL_CALL_HOOK_CONTEXT } from "../agents/before-tool-call-metadata.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { formatErrorMessage } from "../infra/errors.js";
import { coerceChatContentText } from "../shared/chat-content.js";

type CallPluginToolParams = {
  name: string;
  arguments?: unknown;
};

function toMcpContentBlock(block: unknown): unknown {
  if (!isRecord(block)) {
    return { type: "text", text: coerceChatContentText(block) };
  }
  if (block.type !== "image") {
    return block;
  }

  if (typeof block.data === "string" && typeof block.mimeType === "string") {
    return block;
  }

  const source = block.source;
  if (
    isRecord(source) &&
    source.type === "base64" &&
    typeof source.data === "string" &&
    typeof source.media_type === "string"
  ) {
    return {
      type: "image",
      data: source.data,
      mimeType: source.media_type,
    };
  }

  return { type: "text", text: coerceChatContentText(block) };
}

function resolveJsonSchemaForTool(tool: AnyAgentTool): Record<string, unknown> {
  const params = tool.parameters;
  if (params && typeof params === "object" && "type" in params) {
    return params as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

function resolveBeforeToolCallRunId(tool: AnyAgentTool): string | undefined {
  const context = (tool as unknown as Record<symbol, unknown>)[BEFORE_TOOL_CALL_HOOK_CONTEXT];
  return isRecord(context) && typeof context.runId === "string" ? context.runId : undefined;
}

export function createPluginToolsMcpHandlers(tools: AnyAgentTool[]) {
  const wrappedTools = tools.map((tool) => {
    if (isToolWrappedWithBeforeToolCallHook(tool)) {
      return rewrapToolWithBeforeToolCallHook(tool, undefined, { approvalMode: "report" });
    }
    // The ACPX MCP bridge should enforce the same pre-execution hook boundary
    // as the agent and HTTP tool execution paths.
    return wrapToolWithBeforeToolCallHook(tool, undefined, { approvalMode: "report" });
  });
  const toolMap = new Map<string, { tool: AnyAgentTool; runId: string | undefined }>();
  for (const tool of wrappedTools) {
    toolMap.set(tool.name, { tool, runId: resolveBeforeToolCallRunId(tool) });
  }

  return {
    listTools: async () => ({
      tools: wrappedTools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: resolveJsonSchemaForTool(tool),
      })),
    }),
    callTool: async (params: CallPluginToolParams, signal?: AbortSignal) => {
      const entry = toolMap.get(params.name);
      if (!entry) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${params.name}` }],
          isError: true,
        };
      }
      const toolCallId = `mcp-${randomUUID()}`;
      try {
        const result = await entry.tool.execute(toolCallId, params.arguments ?? {}, signal);
        const rawContent =
          result && typeof result === "object" && "content" in result
            ? (result as { content?: unknown }).content
            : result;
        return {
          content: Array.isArray(rawContent)
            ? rawContent.map(toMcpContentBlock)
            : [{ type: "text", text: coerceChatContentText(rawContent) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Tool error: ${formatErrorMessage(err)}` }],
          isError: true,
        };
      } finally {
        // Direct MCP calls have no agent event consumer, so release the cloned
        // hook arguments as soon as the tool reaches a terminal state.
        consumeAdjustedParamsForToolCall(toolCallId, entry.runId);
      }
    },
  };
}
