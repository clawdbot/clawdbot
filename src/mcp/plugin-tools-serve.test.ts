import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";

const callGatewayTool = vi.hoisted(() => vi.fn());
const connectToolsMcpServerToStdioMock = vi.hoisted(() => vi.fn());
const createToolsMcpServerMock = vi.hoisted(() => vi.fn(() => ({ close: vi.fn() })));
const getRuntimeConfigMock = vi.hoisted(() => vi.fn(() => ({ plugins: { enabled: true } })));
const resolvePluginToolsMock = vi.hoisted(() => vi.fn<() => AnyAgentTool[]>(() => []));
const routeLogsToStderrMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/tools/gateway.js", () => ({
  callGatewayTool,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("../logging/console.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/console.js")>();
  return {
    ...actual,
    routeLogsToStderr: routeLogsToStderrMock,
  };
});

vi.mock("../plugins/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/tools.js")>();
  return {
    ...actual,
    resolvePluginTools: resolvePluginToolsMock,
  };
});

vi.mock("./tools-stdio-server.js", () => ({
  connectToolsMcpServerToStdio: connectToolsMcpServerToStdioMock,
  createToolsMcpServer: createToolsMcpServerMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
  callGatewayTool.mockReset();
  connectToolsMcpServerToStdioMock.mockReset();
  createToolsMcpServerMock.mockClear();
  getRuntimeConfigMock.mockClear();
  resolvePluginToolsMock.mockReset();
  resolvePluginToolsMock.mockReturnValue([]);
  routeLogsToStderrMock.mockReset();
  resetGlobalHookRunner();
});

describe("plugin tools MCP server", () => {
  it("routes logs to stderr before resolving tools for stdio", async () => {
    const { servePluginToolsMcp } = await import("./plugin-tools-serve.js");
    resolvePluginToolsMock.mockReturnValue([
      {
        name: "memory_recall",
        label: "Recall memory",
        description: "Recall stored memory",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
    ]);

    await servePluginToolsMcp();

    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(1);
    expect(resolvePluginToolsMock).toHaveBeenCalledTimes(1);
    expect(routeLogsToStderrMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolvePluginToolsMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(connectToolsMcpServerToStdioMock).toHaveBeenCalledOnce();
  });

  it("lists registered plugin tools and serializes non-array tool content", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: "Stored.",
    });
    const tool = {
      name: "memory_recall",
      description: "Recall stored memory",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      execute,
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([tool]);
    const listed = await handlers.listTools();
    expect(listed.tools).toEqual([
      expect.objectContaining({
        name: "memory_recall",
        description: "Recall stored memory",
        inputSchema: expect.objectContaining({
          type: "object",
          required: ["query"],
        }),
      }),
    ]);

    const result = await handlers.callTool({
      name: "memory_recall",
      arguments: { query: "remember this" },
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/^mcp-\d+$/),
      {
        query: "remember this",
      },
      undefined,
      undefined,
    );
    expect(result.content).toEqual([{ type: "text", text: "Stored." }]);
  });

  it("serializes plugin tool results that do not use the MCP content envelope", async () => {
    const execute = vi.fn().mockResolvedValue({
      provider: "kitchen-sink-search",
      results: [{ title: "Kitchen Sink image fixture" }],
    });
    const tool = {
      name: "kitchen_sink_search",
      description: "Search Kitchen Sink fixture content",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
      execute,
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([tool]);
    const result = await handlers.callTool({
      name: "kitchen_sink_search",
      arguments: { query: "kitchen sink" },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          provider: "kitchen-sink-search",
          results: [{ title: "Kitchen Sink image fixture" }],
        }),
      },
    ]);
  });

  it("returns MCP errors for unknown tools and thrown tool errors", async () => {
    const failingTool = {
      name: "memory_forget",
      description: "Forget memory",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([failingTool]);
    const unknown = await handlers.callTool({
      name: "missing_tool",
      arguments: {},
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toEqual([{ type: "text", text: "Unknown tool: missing_tool" }]);

    const failed = await handlers.callTool({
      name: "memory_forget",
      arguments: {},
    });
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([{ type: "text", text: "Tool error: boom" }]);
  });

  it("blocks tool execution when before_tool_call requires approval on the MCP bridge", async () => {
    let hookCalls = 0;
    const execute = vi.fn().mockResolvedValue({
      content: "Stored.",
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => {
            hookCalls += 1;
            return {
              requireApproval: {
                pluginId: "test-plugin",
                title: "Approval required",
                description: "Approval required",
              },
            };
          },
        },
      ]),
    );
    callGatewayTool.mockRejectedValueOnce(new Error("gateway unavailable"));
    const tool = {
      name: "memory_store",
      description: "Store memory",
      parameters: { type: "object", properties: {} },
      execute,
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([tool]);
    const result = await handlers.callTool({
      name: "memory_store",
      arguments: { text: "remember this" },
    });
    expect(hookCalls).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Tool error: Plugin approval required (gateway unavailable)" },
    ]);
  });
});
