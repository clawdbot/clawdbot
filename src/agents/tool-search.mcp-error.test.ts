import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { runAgentLoop, type AgentEvent, type AgentMessage } from "./runtime/index.js";
import { isToolResultError } from "./tool-result-error.js";
import {
  applyToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

const testUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeMcpRuntime(result: CallToolResult): SessionMcpRuntime {
  const tool = {
    serverName: "searchServer",
    safeServerName: "searchServer",
    toolName: "query",
    description: "Query the search backend",
    inputSchema: { type: "object", properties: {} },
    fallbackDescription: "Query the search backend",
  };
  const catalog = {
    version: 1 as const,
    generatedAt: 0,
    servers: {
      searchServer: {
        serverName: "searchServer",
        launchSummary: "searchServer",
        toolCount: 1,
        supportsParallelToolCalls: false,
      },
    },
    tools: [tool],
  };
  return {
    sessionId: "session-tool-search-mcp-error",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    callTool: async () => result,
    dispose: async () => {},
  };
}

function createToolSearchControl(target: AnyAgentTool, name: string, mode: "code" | "tools") {
  const config = { tools: { toolSearch: { enabled: true, mode } } };
  const catalogRef = createToolSearchCatalogRef();
  const controls = createToolSearchTools({ config, catalogRef });
  applyToolSearchCatalog({ tools: [...controls, target], config, catalogRef });
  return expectDefined(
    controls.find((tool) => tool.name === name),
    `${name} control`,
  );
}

function createDeferredCall(target: AnyAgentTool) {
  return createToolSearchControl(target, TOOL_CALL_RAW_TOOL_NAME, "tools");
}

async function createDeferredMcpCall(result: CallToolResult) {
  const materialized = await materializeBundleMcpToolsForRun({
    runtime: makeMcpRuntime(result),
  });
  const target = expectDefined(materialized.tools[0], "materialized MCP tool");
  return { callTool: createDeferredCall(target), target };
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: testUsage,
    stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 1,
  };
}

describe("Tool Search MCP failures", () => {
  it("keeps a materialized MCP failure failed through structured tool_call", async () => {
    const { callTool, target } = await createDeferredMcpCall({
      content: [{ type: "text", text: "Backend request failed" }],
      isError: true,
    });

    const directResult = await target.execute("direct-mcp-call", {});
    expect(directResult).toMatchObject({
      details: {
        mcpServer: "searchServer",
        mcpTool: "query",
        status: "error",
      },
    });
    expect(isToolResultError(directResult)).toBe(true);

    const wrappedResult = await callTool.execute("deferred-mcp-call", {
      id: target.name,
      args: {},
    });
    expect(wrappedResult.details).toMatchObject({
      tool: { name: target.name },
      result: directResult,
      status: "failed",
    });
    const wrappedDetails = wrappedResult.details as {
      tool: unknown;
      result: unknown;
      status: unknown;
    };
    expect(wrappedResult.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining(
          JSON.stringify({ tool: wrappedDetails.tool, result: wrappedDetails.result }, null, 2),
        ),
      },
    ]);
    expect(wrappedResult.content[0]).toMatchObject({
      text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
    });
    expect(isToolResultError(wrappedResult)).toBe(true);
  });

  it.each([
    { innerStatus: "blocked", outerStatus: "blocked" },
    { innerStatus: "timeout", outerStatus: "timed_out" },
    { innerStatus: "cancelled", outerStatus: "cancelled" },
  ] as const)(
    "preserves a deferred $innerStatus terminal kind",
    async ({ innerStatus, outerStatus }) => {
      const target: AnyAgentTool = {
        name: `native_${innerStatus}`,
        label: `Native ${innerStatus}`,
        description: `Return a resolved ${innerStatus} result`,
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => jsonResult({ status: innerStatus }),
      };
      const callTool = createDeferredCall(target);

      const wrappedResult = await callTool.execute(`deferred-${innerStatus}`, {
        id: target.name,
        args: {},
      });

      expect(wrappedResult.details).toMatchObject({
        result: { details: { status: innerStatus } },
        status: outerStatus,
      });
      expect(isToolResultError(wrappedResult)).toBe(true);
    },
  );

  it("records the outer tool_call lifecycle and transcript result as failed", async () => {
    const { callTool, target } = await createDeferredMcpCall({
      content: [{ type: "text", text: "Backend request failed" }],
      isError: true,
    });
    const events: AgentEvent[] = [];
    let turn = 0;
    const streamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? assistantMessage([
                {
                  type: "toolCall",
                  id: "deferred-mcp-call",
                  name: callTool.name,
                  arguments: { id: target.name, args: {} },
                },
              ])
            : assistantMessage([{ type: "text", text: "done" }]);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };

    const messages = await runAgentLoop(
      [{ role: "user", content: "query the backend", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [callTool] },
      {
        model,
        convertToLlm: (agentMessages) => agentMessages as Message[],
        // Mirror the embedded extension's production classification rule here
        // to isolate agent-core lifecycle and transcript propagation.
        afterToolCall: async ({ result, isError }) => ({
          isError: isError || isToolResultError(result),
        }),
      },
      (event) => {
        events.push(event);
      },
      undefined,
      streamFn,
    );

    expect(
      events.find(
        (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
          event.type === "tool_execution_end" && event.toolName === TOOL_CALL_RAW_TOOL_NAME,
      ),
    ).toMatchObject({ isError: true, result: { details: { status: "failed" } } });
    expect(
      messages.find(
        (message): message is Extract<AgentMessage, { role: "toolResult" }> =>
          message.role === "toolResult" && message.toolName === TOOL_CALL_RAW_TOOL_NAME,
      ),
    ).toMatchObject({ isError: true, details: { status: "failed" } });
  });

  it("keeps successful MCP and native deferred calls successful", async () => {
    const { callTool: mcpCall, target: mcpTarget } = await createDeferredMcpCall({
      content: [{ type: "text", text: "No error records found" }],
      isError: false,
    });
    const directMcpResult = await mcpTarget.execute("direct-mcp-call", {});
    const wrappedMcpResult = await mcpCall.execute("deferred-mcp-call", {
      id: mcpTarget.name,
      args: {},
    });

    expect(isToolResultError(directMcpResult)).toBe(false);
    expect(isToolResultError(wrappedMcpResult)).toBe(false);

    const nativeTarget: AnyAgentTool = {
      name: "native_success",
      label: "Native success",
      description: "Return a successful native result",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => jsonResult({ status: "ok", text: "error is only text" }),
    };
    const nativeCall = createDeferredCall(nativeTarget);
    const wrappedNativeResult = await nativeCall.execute("deferred-native-call", {
      id: nativeTarget.name,
      args: {},
    });

    expect(isToolResultError(wrappedNativeResult)).toBe(false);
  });

  it("lets tool_search_code recover from a nested MCP failure", async () => {
    const { target } = await createDeferredMcpCall({
      content: [{ type: "text", text: "Backend request failed" }],
      isError: true,
    });
    const codeTool = createToolSearchControl(target, TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code");
    const result = await codeTool.execute("code-mode-mcp-call", {
      code: `
        const call = await openclaw.tools.call(${JSON.stringify(target.name)}, {});
        return { recovered: call.result.details.status === "error" };
      `,
    });

    expect(result.details).toMatchObject({ ok: true, value: { recovered: true } });
    expect(isToolResultError(result)).toBe(false);
  });

  it("continues to throw target execution exceptions", async () => {
    const target: AnyAgentTool = {
      name: "native_failure",
      label: "Native failure",
      description: "Throw a native execution error",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        throw new Error("native target failed");
      },
    };
    const callTool = createDeferredCall(target);

    await expect(
      callTool.execute("deferred-native-failure", { id: target.name, args: {} }),
    ).rejects.toThrow("native target failed");
  });
});
