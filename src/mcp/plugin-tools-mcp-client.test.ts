import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginToolsMcpServer } from "./plugin-tools-serve.js";

describe("plugin tools MCP client bridge", () => {
  it("lists and calls a plugin tool through a real MCP client", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "MCP fact: the codename is ORBIT-9." }],
    });
    const tool = {
      name: "memory_search",
      description: "Search memory",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          maxResults: { type: "number" },
        },
        required: ["query"],
      },
      execute,
    } as unknown as AnyAgentTool;

    const server = createPluginToolsMcpServer({
      config: { plugins: { enabled: true } } as OpenClawConfig,
      tools: [tool],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "plugin-tools-test-client", version: "0.0.0" },
      { capabilities: {} },
    );

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((listedTool) => listedTool.name)).toContain("memory_search");

      const result = await client.callTool({
        name: "memory_search",
        arguments: { query: "ORBIT-9 codename", maxResults: 3 },
      });

      expect(execute).toHaveBeenCalledWith(
        expect.stringMatching(
          /^mcp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
        { query: "ORBIT-9 codename", maxResults: 3 },
        expect.any(AbortSignal),
        undefined,
      );
      expect(JSON.stringify(result.content)).toContain("ORBIT-9");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
