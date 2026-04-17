import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { createPluginToolsMcpServer } from "./plugin-tools-serve.js";

async function connectPluginToolsServer(tools: AnyAgentTool[]) {
  const server = createPluginToolsMcpServer({ tools });
  const client = new Client({ name: "plugin-tools-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetGlobalHookRunner();
});

describe("plugin tools MCP server", () => {
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

    const session = await connectPluginToolsServer([tool]);
    try {
      const listed = await session.client.listTools();
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

      const result = await session.client.callTool({
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
    } finally {
      await session.close();
    }
  });

  it("returns MCP errors for unknown tools and thrown tool errors", async () => {
    const failingTool = {
      name: "memory_forget",
      description: "Forget memory",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as AnyAgentTool;

    const session = await connectPluginToolsServer([failingTool]);
    try {
      const unknown = await session.client.callTool({
        name: "missing_tool",
        arguments: {},
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.content).toEqual([{ type: "text", text: "Unknown tool: missing_tool" }]);

      const failed = await session.client.callTool({
        name: "memory_forget",
        arguments: {},
      });
      expect(failed.isError).toBe(true);
      expect(failed.content).toEqual([{ type: "text", text: "Tool error: boom" }]);
    } finally {
      await session.close();
    }
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
    const tool = {
      name: "memory_store",
      description: "Store memory",
      parameters: { type: "object", properties: {} },
      execute,
    } as unknown as AnyAgentTool;

    const session = await connectPluginToolsServer([tool]);
    try {
      const result = await session.client.callTool({
        name: "memory_store",
        arguments: { text: "remember this" },
      });
      expect(hookCalls).toBe(1);
      expect(execute).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "Tool error: Plugin approval required (gateway unavailable)" },
      ]);
    } finally {
      await session.close();
    }
  });
});
