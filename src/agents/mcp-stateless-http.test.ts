import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

/**
 * Acceptance coverage for the 2026-07-28 MCP spec migration (#119294): a
 * stateless server reached over Streamable HTTP must serve connect,
 * tools/list, and tools/call per request — no initialize handshake and no
 * Mcp-Session-Id coupling. OpenClaw ships no production HTTP MCP client, so
 * the criterion is exercised in-process against the same v2 SDK packages the
 * runtime depends on.
 */
describe("MCP 2026-07-28 stateless HTTP compatibility", () => {
  it("lists and calls tools without initialize or Mcp-Session-Id", async () => {
    const seenMethods: string[] = [];
    const sessionHeaders: string[] = [];

    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "stateless-http-probe", version: "1.0.0" });
      server.registerTool("probe", { description: "Stateless HTTP probe" }, async () => ({
        content: [{ type: "text", text: "FROM-STATELESS-HTTP" }],
      }));
      return server;
    });

    try {
      const transport = new StreamableHTTPClientTransport(new URL("http://stateless.invalid/mcp"), {
        // Serve every request in-process and observe the wire: which
        // JSON-RPC methods arrive, and whether the server ever stamps a
        // session id header.
        fetch: async (url, init) => {
          const body = init?.body;
          if (typeof body === "string" && body.trim()) {
            const parsed: unknown = JSON.parse(body);
            for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
              if (message && typeof message === "object" && "method" in message) {
                seenMethods.push(String((message as { method: unknown }).method));
              }
            }
          }
          const response = await handler.fetch(new Request(url, init));
          const sessionId = response.headers.get("mcp-session-id");
          if (sessionId) {
            sessionHeaders.push(sessionId);
          }
          return response;
        },
      });

      const client = new Client(
        { name: "openclaw-stateless-probe", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["probe"]);

      const result = await client.callTool({ name: "probe", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: "FROM-STATELESS-HTTP" }]);

      expect(seenMethods).not.toContain("initialize");
      expect(seenMethods).toContain("tools/list");
      expect(seenMethods).toContain("tools/call");
      expect(sessionHeaders).toEqual([]);

      await client.close();
    } finally {
      await handler.close();
    }
  });
});
