// Gateway MCP loopback JSON-RPC handlers.
// Implements initialize, tools/list, tools/call, and notification handling.
import crypto from "node:crypto";
import { ContentBlockSchema, type ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runBeforeToolCallHook, type HookContext } from "../agents/agent-tools.before-tool-call.js";
import {
  formatToolExecutionErrorMessage,
  resolveToolExecutionErrorKind,
  resolveToolResultFailureKind,
} from "../agents/tool-result-error.js";
import type { McpLoopbackToolCallOutcome } from "./mcp-http.loopback-runtime.js";
import {
  MCP_LOOPBACK_SERVER_NAME,
  MCP_LOOPBACK_SERVER_VERSION,
  MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS,
  jsonRpcError,
  jsonRpcResult,
  type JsonRpcRequest,
} from "./mcp-http.protocol.js";
import {
  readMcpLoopbackToolName,
  type McpLoopbackTool,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";

function stringifyMcpContent(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

const MCP_LOOPBACK_CONTENT_TYPES = new Set<ContentBlock["type"]>(["text", "image", "resource"]);

// Tool implementations may return MCP content blocks, plain strings, or
// arbitrary JSON. Preserve the valid block types shared by every protocol revision
// this server advertises; newer and malformed shapes remain visible as text.
function normalizeToolCallContent(result: unknown): ContentBlock[] {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      const parsed = ContentBlockSchema.safeParse(block);
      if (parsed.success && MCP_LOOPBACK_CONTENT_TYPES.has(parsed.data.type)) {
        return parsed.data;
      }
      return {
        type: "text" as const,
        text: stringifyMcpContent(block),
      };
    });
  }
  return [
    {
      type: "text",
      text: stringifyMcpContent(result),
    },
  ];
}

/** Handles one MCP loopback JSON-RPC message and returns a response or notification null. */
export async function handleMcpJsonRpc(params: {
  message: JsonRpcRequest;
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
  hookContext?: HookContext;
  signal?: AbortSignal;
  /** Revalidate short-lived client authority immediately before side effects. */
  authorizeToolCall?: () => boolean;
  onToolCallResult?: (
    call: {
      toolName: string;
      args: Record<string, unknown>;
    } & McpLoopbackToolCallOutcome,
  ) => void;
  onToolCallPrepared?: (call: { toolName: string; args: Record<string, unknown> }) => void;
}): Promise<object | null> {
  const { id, method, params: methodParams } = params.message;

  switch (method) {
    case "initialize": {
      const clientVersion = (methodParams?.protocolVersion as string) ?? "";
      // Prefer the client-requested protocol when supported, otherwise fall
      // back to the newest/first supported version advertised by this server.
      const negotiated =
        MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === clientVersion) ??
        MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS[0];
      return jsonRpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: {
          name: MCP_LOOPBACK_SERVER_NAME,
          version: MCP_LOOPBACK_SERVER_VERSION,
        },
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "tools/list":
      return jsonRpcResult(id, { tools: params.toolSchema });
    case "tools/call": {
      const toolName = typeof methodParams?.name === "string" ? methodParams.name.trim() : "";
      const rawToolArgs = methodParams?.arguments;
      if (rawToolArgs !== undefined && !isRecord(rawToolArgs)) {
        return jsonRpcError(id, -32602, "Invalid params: tools/call arguments must be an object");
      }
      const toolArgs = rawToolArgs ?? {};
      if (!toolName) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: "Tool not available: unknown" }],
          isError: true,
        });
      }
      if (!params.toolSchema.some((tool) => tool.name === toolName)) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Tool not available: ${toolName}` }],
          isError: true,
        });
      }
      const tool = params.tools.find(
        (candidate) => readMcpLoopbackToolName(candidate) === toolName,
      );
      if (!tool) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Tool not available: ${toolName}` }],
          isError: true,
        });
      }
      const toolCallId = `mcp-${crypto.randomUUID()}`;
      let executedToolArgs = toolArgs;
      const reportToolCallResult = (outcome: McpLoopbackToolCallOutcome) => {
        try {
          params.onToolCallResult?.({
            toolName,
            args: executedToolArgs,
            ...outcome,
          });
        } catch {
          // Observability callbacks must never alter the tool result returned to the MCP client.
        }
      };
      try {
        const preparedToolArgs = tool.prepareBeforeToolCallParams
          ? await tool.prepareBeforeToolCallParams(toolArgs, {
              toolCallId,
              hookContext: params.hookContext,
              signal: params.signal,
            })
          : toolArgs;
        executedToolArgs = preparedToolArgs as Record<string, unknown>;
        // Gateway before-tool hooks still run for loopback MCP calls so policy
        // and audit behavior matches native tool calls from normal chat runs.
        // Preserve prepared params so exec can restore private workdir/env state after hooks.
        const hookResult = await runBeforeToolCallHook({
          toolName,
          params: preparedToolArgs,
          toolCallId,
          ctx: params.hookContext,
          signal: params.signal,
        });
        if (hookResult.blocked) {
          const disposition = hookResult.kind === "failure" ? hookResult.disposition : "blocked";
          reportToolCallResult(
            disposition === "blocked"
              ? {
                  outcome: disposition,
                  deniedReason: hookResult.deniedReason ?? "plugin-before-tool-call",
                }
              : { outcome: disposition },
          );
          return jsonRpcResult(id, {
            content: [{ type: "text", text: hookResult.reason }],
            isError: true,
          });
        }
        const finalizedToolArgs =
          tool.finalizeBeforeToolCallParams?.(hookResult.params, preparedToolArgs) ??
          hookResult.params;
        executedToolArgs = finalizedToolArgs as Record<string, unknown>;
        try {
          params.onToolCallPrepared?.({ toolName, args: executedToolArgs });
        } catch {
          // Observability callbacks must never alter the tool result returned to the MCP client.
        }
        if (params.authorizeToolCall && !params.authorizeToolCall()) {
          reportToolCallResult({ outcome: "blocked", deniedReason: "client-grant-revoked" });
          return jsonRpcResult(id, {
            content: [{ type: "text", text: "Tool call authorization expired" }],
            isError: true,
          });
        }
        const result = await tool.execute(toolCallId, finalizedToolArgs, params.signal);
        const failureKind = resolveToolResultFailureKind(result);
        reportToolCallResult(
          failureKind === "blocked"
            ? { outcome: "blocked", deniedReason: "tool_result_blocked" }
            : { outcome: failureKind ?? "completed", result },
        );
        return jsonRpcResult(id, {
          content: normalizeToolCallContent(result),
          isError: failureKind !== undefined,
        });
      } catch (error) {
        // A disconnected request does not identify the enclosing run outcome,
        // but its payload may prove partial delivery and prevent a duplicate send.
        reportToolCallResult({
          outcome: params.signal?.aborted ? "unknown" : resolveToolExecutionErrorKind(error),
          result: error,
        });
        const message = formatToolExecutionErrorMessage(error, "tool execution failed");
        return jsonRpcResult(id, {
          content: [{ type: "text", text: message || "tool execution failed" }],
          isError: true,
        });
      }
    }
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}
