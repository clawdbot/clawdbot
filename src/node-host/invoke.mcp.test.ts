/** Tests the built-in node-host MCP invocation command. */
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { handleInvoke } from "./invoke.js";
import { NodeHostMcpError, type NodeHostMcpManager } from "./mcp.js";

const MEBIBYTE = 1024 * 1024;

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
    descriptors: [],
    callMcpTool,
    close: async () => undefined,
  };
}

describe("mcp.tools.call.v1", () => {
  it("dispatches validated params and preserves raw MCP content for one final projection", async () => {
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
        {
          type: "resource_link",
          uri: "https://example.com/report",
          name: "report",
          title: "Report",
        },
      ],
      structuredContent: { ok: true },
    });
  });

  it("returns MCP tool errors as results while thrown failures fail the invoke", async () => {
    const toolError = await invokeMcp(
      managerWith(async () => ({
        isError: true,
        content: [{ type: "text", text: "bad query" }],
        structuredContent: { retryable: true },
      })),
      { server: "docs", tool: "search" },
    );
    expect(toolError).toEqual({
      id: "invoke-mcp",
      nodeId: "node-1",
      ok: true,
      payload: {
        content: [{ type: "text", text: "bad query" }],
        structuredContent: { retryable: true },
        isError: true,
      },
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

  it("does not publish an MCP result after its invocation is canceled", async () => {
    const controller = new AbortController();
    let resolveTool:
      | ((result: { content: Array<{ type: "text"; text: string }> }) => void)
      | undefined;
    const callMcpTool = vi.fn<NodeHostMcpManager["callMcpTool"]>(
      () =>
        new Promise((resolve) => {
          resolveTool = resolve;
        }),
    );
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);

    const invoking = handleInvoke(
      {
        id: "invoke-mcp-canceled",
        nodeId: "node-1",
        command: "mcp.tools.call.v1",
        paramsJSON: JSON.stringify({ server: "docs", tool: "search" }),
        timeoutMs: 321,
      },
      { request } as unknown as GatewayClient,
      { current: async () => [] },
      managerWith(callMcpTool),
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(callMcpTool).toHaveBeenCalledOnce());
    expect(callMcpTool.mock.calls[0]?.[0].signal).toBe(controller.signal);

    controller.abort();
    resolveTool?.({ content: [{ type: "text", text: "stale MCP result" }] });
    await invoking;

    expect(request).not.toHaveBeenCalled();
  });

  it("caps aggregate MCP text content at one megabyte with a truncation note", async () => {
    const result = await invokeMcp(
      managerWith(async () => ({
        content: [
          { type: "text", text: "a".repeat(MEBIBYTE) },
          { type: "text", text: "overflow" },
        ],
      })),
      { server: "docs", tool: "large" },
    );
    const payload = result.payload as {
      content: Array<{ type: string; text: string }>;
    };
    const text = payload.content.map((block) => block.text).join("");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MEBIBYTE);
    expect(text).toContain("truncated: MCP text content exceeded 1 MB");
  });

  it("drops oversized images and structured content before node.invoke serialization", async () => {
    const oversized = "A".repeat(20 * MEBIBYTE);
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
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(20 * MEBIBYTE);
    expect(payload.content).toEqual([
      { type: "text", text: "[truncated: MCP result exceeded 20 MB]" },
    ]);
    expect(payload.structuredContent).toBeUndefined();
  });

  it("preserves structured content and recovery guidance when an exact JSON mirror is oversized", async () => {
    const structuredContent = {
      oversized: "S".repeat(10 * MEBIBYTE),
    };
    const recovery = "authentication expired; run login";
    const result = await invokeMcp(
      managerWith(async () => ({
        content: [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
          {
            type: "image",
            data: "I".repeat(10 * MEBIBYTE),
            mimeType: "image/png",
          },
          { type: "text", text: recovery },
        ],
        structuredContent,
        isError: true,
      })),
      { server: "docs", tool: "recover" },
    );
    const payload = result.payload as {
      content: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    expect(payload.isError).toBe(true);
    expect(payload.structuredContent).toBeDefined();
    expect(payload.structuredContent?.oversized).toHaveLength(structuredContent.oversized.length);
    expect(payload.content).toEqual([
      { type: "text", text: recovery },
      { type: "text", text: "[truncated: MCP result exceeded 20 MB]" },
    ]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(20 * MEBIBYTE);
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
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(20 * MEBIBYTE);
  });
});
