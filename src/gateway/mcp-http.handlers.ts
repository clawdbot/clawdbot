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
import { isAutomationsToolName } from "../agents/tools/automations-tool-name.js";
import type { McpLoopbackClientGrantAuthorization } from "./mcp-grant-store.js";
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
  /** Revalidate the exact client grant/capture authority around side effects. */
  resolveToolCallAuthorization?: () => McpLoopbackClientGrantAuthorization;
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
      const requestedToolName =
        typeof methodParams?.name === "string" ? methodParams.name.trim() : "";
      // "cron" is a permanently accepted inbound alias for the scheduler tool
      // (owner decision, RFC 0026; same contract as bash -> exec). Resolve it to
      // the published canonical tool without re-advertising it in tools/list.
      const toolName =
        !params.toolSchema.some((tool) => tool.name === requestedToolName) &&
        isAutomationsToolName(requestedToolName)
          ? (params.toolSchema.find((tool) => isAutomationsToolName(tool.name))?.name ??
            requestedToolName)
          : requestedToolName;
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
      let toolExecutionAdmitted = false;
      let toolCallResultReported = false;
      const reportToolCallResult = (outcome: McpLoopbackToolCallOutcome) => {
        if (toolCallResultReported) {
          return;
        }
        toolCallResultReported = true;
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
      const rejectExpiredAuthorization = (
        authorization: Exclude<McpLoopbackClientGrantAuthorization, "active">,
      ) => {
        // A fully revoked grant still belongs to the admitted run, so retain
        // blocked/delivery evidence. An ended or replaced capture owns nothing.
        if (authorization === "grant-revoked") {
          reportToolCallResult({ outcome: "blocked", deniedReason: "client-grant-revoked" });
        }
        return jsonRpcResult(id, {
          content: [{ type: "text", text: "Tool call authorization expired" }],
          isError: true,
        });
      };
      const resolveAuthorization = (): McpLoopbackClientGrantAuthorization =>
        params.resolveToolCallAuthorization?.() ?? "active";
      try {
        let authorization = resolveAuthorization();
        if (authorization !== "active") {
          return rejectExpiredAuthorization(authorization);
        }
        const preparedToolArgs = tool.prepareBeforeToolCallParams
          ? await tool.prepareBeforeToolCallParams(toolArgs, {
              toolCallId,
              hookContext: params.hookContext,
              signal: params.signal,
            })
          : toolArgs;
        executedToolArgs = preparedToolArgs as Record<string, unknown>;
        authorization = resolveAuthorization();
        if (authorization !== "active") {
          return rejectExpiredAuthorization(authorization);
        }
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
        authorization = resolveAuthorization();
        if (authorization !== "active") {
          return rejectExpiredAuthorization(authorization);
        }
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
        authorization = resolveAuthorization();
        if (authorization !== "active") {
          return rejectExpiredAuthorization(authorization);
        }
        toolExecutionAdmitted = true;
        const result = await tool.execute(toolCallId, finalizedToolArgs, params.signal);
        const failureKind = resolveToolResultFailureKind(result);
        authorization = resolveAuthorization();
        if (authorization !== "capture-ended") {
          reportToolCallResult(
            failureKind === "blocked"
              ? { outcome: "blocked", deniedReason: "tool_result_blocked" }
              : { outcome: failureKind ?? "completed", result },
          );
        }
        // A tool may ignore abort. Capture its settled outcome, then revalidate
        // before disclosing output to a client whose authority may have ended.
        if (authorization !== "active") {
          return rejectExpiredAuthorization(authorization);
        }
        return jsonRpcResult(id, {
          content: normalizeToolCallContent(result),
          isError: failureKind !== undefined,
        });
      } catch (error) {
        const authorization = resolveAuthorization();
        if (toolExecutionAdmitted) {
          // An admitted execution may settle after revocation. Preserve the actual
          // terminal evidence exactly once, while still redacting the HTTP response.
          if (authorization !== "capture-ended") {
            reportToolCallResult({
              outcome: params.signal?.aborted ? "unknown" : resolveToolExecutionErrorKind(error),
              result: error,
            });
          }
        }
        if (authorization !== "active") {
          return rejectExpiredAuthorization(authorization);
        }
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
