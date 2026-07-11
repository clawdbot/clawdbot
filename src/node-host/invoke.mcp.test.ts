/** Tests the built-in node-host MCP invocation command. */
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { handleInvoke, testing } from "./invoke.js";
import { NodeHostMcpError, type NodeHostMcpManager } from "./mcp.js";

async function invokeMcp(manager: NodeHostMcpManager, params: unknown) {
  const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
  await handleInvoke(
    {
      id: "invoke-mcp",
      nodeId: "node-1",
      command: "mcp.tools.call.v1",
      paramsJSON: JSON.stringify(params),
      timeoutMs: 321,
    },
    { request } as unknown as GatewayClient,
    { current: async () => [] },
    manager,
  );
  return (request.mock.calls[0]?.[1] ?? {}) as {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string;
    error?: { code?: string; message?: string };
  };
}

function managerWith(callMcpTool: NodeHostMcpManager["callMcpTool"]): NodeHostMcpManager {
  return {
    configuredServerCount: 1,
    descriptors: [],
    callMcpTool,
    close: async () => undefined,
  };
}

describe("mcp.tools.call.v1", () => {
  it("dispatches validated params and preserves text/image content", async () => {
    const callMcpTool = vi.fn<NodeHostMcpManager["callMcpTool"]>().mockResolvedValue({
      content: [
        { type: "text", text: "pong" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        {
          type: "resource_link",
          uri: "https://example.com/report",
          name: "report",
          title: "Report",
        },
      ],
      structuredContent: { ok: true },
    });
    const result = await invokeMcp(managerWith(callMcpTool), {
      server: "docs",
      tool: "search",
      arguments: { query: "x" },
    });

    expect(callMcpTool).toHaveBeenCalledWith({
      server: "docs",
      tool: "search",
      arguments: { query: "x" },
      timeoutMs: 321,
    });
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({
      content: [
        { type: "text", text: "pong" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "text", text: "[Report] https://example.com/report" },
      ],
      structuredContent: { ok: true },
    });
  });

  it("maps MCP tool errors and unavailable servers to failed invokes", async () => {
    const toolError = await invokeMcp(
      managerWith(async () => ({ isError: true, content: [{ type: "text", text: "bad query" }] })),
      { server: "docs", tool: "search" },
    );
    expect(toolError).toMatchObject({
      ok: false,
      error: { code: "MCP_TOOL_ERROR", message: "bad query" },
    });

    const unavailable = await invokeMcp(
      managerWith(async () => {
        throw new NodeHostMcpError("MCP_SERVER_UNAVAILABLE", "server unavailable");
      }),
      { server: "docs", tool: "search" },
    );
    expect(unavailable).toMatchObject({
      ok: false,
      error: { code: "MCP_SERVER_UNAVAILABLE", message: "server unavailable" },
    });

    const unexpected = await invokeMcp(
      managerWith(async () => {
        throw new Error("x".repeat(2_000));
      }),
      { server: "docs", tool: "search" },
    );
    expect(unexpected.error?.code).toBe("MCP_TOOL_ERROR");
    expect(unexpected.error?.message).toHaveLength(1_024);
  });

  it("caps aggregate MCP text content at one megabyte with a truncation note", async () => {
    const result = await invokeMcp(
      managerWith(async () => ({
        content: [
          { type: "text", text: "a".repeat(testing.MCP_TEXT_CONTENT_MAX_BYTES) },
          { type: "text", text: "overflow" },
        ],
      })),
      { server: "docs", tool: "large" },
    );
    const payload = result.payload as {
      content: Array<{ type: string; text: string }>;
    };
    const text = payload.content.map((block) => block.text).join("");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(testing.MCP_TEXT_CONTENT_MAX_BYTES);
    expect(text).toContain("truncated: MCP text content exceeded 1 MB");
  });

  it("drops oversized images and structured content before node.invoke serialization", async () => {
    const oversized = "A".repeat(testing.MCP_INVOKE_PAYLOAD_MAX_BYTES);
    const result = await invokeMcp(
      managerWith(async () => ({
        content: [{ type: "image", data: oversized, mimeType: "image/png" }],
        structuredContent: { oversized },
      })),
      { server: "docs", tool: "large-image" },
    );
    const payload = result.payload as {
      content: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
    };
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      testing.MCP_INVOKE_PAYLOAD_MAX_BYTES,
    );
    expect(payload.content).toEqual([
      { type: "text", text: "[truncated: MCP result exceeded 20 MB]" },
    ]);
    expect(payload.structuredContent).toBeUndefined();
  });

  it("sends MCP payloads as structured invoke data without double JSON escaping", async () => {
    const escaped = "\\".repeat(8 * 1024 * 1024);
    const result = await invokeMcp(
      managerWith(async () => ({ content: [], structuredContent: { escaped } })),
      { server: "docs", tool: "escaped" },
    );
    expect(result.payloadJSON).toBeUndefined();
    expect(
      (result.payload as { structuredContent: { escaped: string } }).structuredContent.escaped,
    ).toBe(escaped);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      testing.MCP_INVOKE_PAYLOAD_MAX_BYTES,
    );
  });
});
