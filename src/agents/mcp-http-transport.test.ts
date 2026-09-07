import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";
import { disposeMcpClient } from "./mcp-client-lifecycle.js";
import { redactMcpDiagnosticError } from "./mcp-error.js";
import {
  OpenClawSSEClientTransport,
  OpenClawStreamableHTTPClientTransport,
} from "./mcp-http-transport.js";

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), {
    ...init,
    headers,
  });
}

function initializedFetch(params: {
  onGet: () => Promise<Response> | Response;
  onDelete?: (init: RequestInit) => void;
  onPost?: (message: { id?: string | number; method?: string }) => Promise<Response> | Response;
}) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      params.onDelete?.(init);
      return new Response(null, { status: 204 });
    }
    if (init?.method === "GET") {
      return await params.onGet();
    }
    if (typeof init?.body !== "string") {
      throw new Error("expected serialized JSON-RPC request body");
    }
    const message = JSON.parse(init.body) as { id?: number; method?: string };
    if (message.method === "initialize") {
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fixture", version: "1" },
          },
        },
        { headers: { "mcp-session-id": "session-1" } },
      );
    }
    if (params.onPost) {
      return await params.onPost(message);
    }
    return new Response(null, { status: 202 });
  });
}

const MCP_HTTP_MAX_PARSE_BYTES = 10 * 1024 * 1024;
const OVERSIZED_MCP_TEXT = "x".repeat(MCP_HTTP_MAX_PARSE_BYTES + 1024);

function mcpResultResponse(
  id: string | number | undefined,
  result: unknown,
  options?: { contentType?: string; stream?: boolean },
): Response {
  const payload = JSON.stringify({ jsonrpc: "2.0", id, result });
  return new Response(options?.stream ? `event: message\ndata: ${payload}\n\n` : payload, {
    headers: {
      "content-type":
        options?.contentType ?? (options?.stream ? "text/event-stream" : "application/json"),
    },
  });
}

describe("OpenClaw MCP HTTP lifecycle adapters", () => {
  it.each([
    "Streamable HTTP error: Error POSTing to endpoint: bearer=body-secret",
    "Error POSTing to endpoint (HTTP 500): bearer=body-secret",
  ])("redacts an HTTP response body from %s", (message) => {
    const redacted = redactMcpDiagnosticError(new Error(message));
    expect(redacted).not.toContain("body-secret");
    expect(redacted).toContain("[redacted response body]");
  });

  it("rejects an oversized JSON message before the SDK parses it", async () => {
    const fetchMock = initializedFetch({
      onGet: () => new Response(null, { status: 405 }),
      onPost: (message) => {
        if (message.method !== "tools/call") {
          return new Response(null, { status: 202 });
        }
        return mcpResultResponse(
          message.id,
          { content: [{ type: "text", text: OVERSIZED_MCP_TEXT }] },
          { contentType: 'application/json; note="text/event-stream"' },
        );
      },
    });
    const transport = new OpenClawStreamableHTTPClientTransport(new URL("http://mcp.invalid/mcp"), {
      fetch: fetchMock,
    });
    const client = new Client({ name: "test", version: "1" });

    try {
      await client.connect(transport);
      const error = await client.callTool({ name: "oversized", arguments: {} }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(String(error)).toContain("HTTP response exceeds 10485760 bytes");
    } finally {
      await disposeMcpClient({ client, transport, transportType: "streamable-http" });
    }
  });

  it("rejects an oversized SSE message before the SDK parses it", async () => {
    const fetchMock = initializedFetch({
      onGet: () => new Response(null, { status: 405 }),
      onPost: (message) => {
        if (message.method !== "tools/call") {
          return new Response(null, { status: 202 });
        }
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: OVERSIZED_MCP_TEXT }] },
        });
        return new Response(`event: message\ndata: ${payload}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const transport = new OpenClawStreamableHTTPClientTransport(new URL("http://mcp.invalid/mcp"), {
      fetch: fetchMock,
    });
    const client = new Client({ name: "test", version: "1" });
    const onerror = vi.fn();
    // MCP clients expose callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    client.onerror = onerror;

    try {
      await client.connect(transport);
      const error = await client
        .callTool({ name: "oversized", arguments: {} }, undefined, { timeout: 100 })
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );
      expect(String(error)).toContain("Connection closed");
      expect(onerror).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("SSE event exceeds 10485760") }),
      );
    } finally {
      await disposeMcpClient({ client, transport, transportType: "streamable-http" });
    }
  });

  it.each([
    { label: "JSON", stream: false },
    { label: "SSE", stream: true },
  ])("accepts an under-limit $label message", async ({ stream }) => {
    const fetchMock = initializedFetch({
      onGet: () => new Response(null, { status: 405 }),
      onPost: (message) =>
        message.method === "tools/call"
          ? mcpResultResponse(
              message.id,
              { content: [{ type: "text", text: "under-limit" }] },
              { stream },
            )
          : new Response(null, { status: 202 }),
    });
    const transport = new OpenClawStreamableHTTPClientTransport(new URL("http://mcp.invalid/mcp"), {
      fetch: fetchMock,
    });
    const client = new Client({ name: "test", version: "1" });

    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "under_limit", arguments: {} });
      expect(result).toMatchObject({ content: [{ type: "text", text: "under-limit" }] });
    } finally {
      await disposeMcpClient({ client, transport, transportType: "streamable-http" });
    }
  });

  it("keeps a legacy SSE stream open beyond the cumulative message limit", async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") {
        return new Response(null, { status: 202 });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const transport = new OpenClawSSEClientTransport(new URL("http://mcp.invalid/sse"), {
      fetch: fetchMock,
      eventSourceInit: { fetch: fetchMock },
    });
    let messageCount = 0;
    let lastMessage: unknown;
    // MCP transports expose callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    transport.onmessage = (message) => {
      messageCount += 1;
      lastMessage = message;
    };

    try {
      await transport.start();
      const notificationEvent = encoder.encode(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level: "info", data: "k".repeat(32 * 1024) },
        })}\n\n`,
      );
      for (let index = 0; index < 321; index += 1) {
        streamController?.enqueue(notificationEvent);
      }
      streamController?.enqueue(
        encoder.encode('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
      );

      await vi.waitFor(() => expect(messageCount).toBe(322));
      expect(lastMessage).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    } finally {
      await transport.close();
    }
  });

  it("closes legacy SSE after an oversized event without reconnecting", async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let getCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") {
        return new Response(null, { status: 202 });
      }
      getCount += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode("retry: 1\n\nevent: endpoint\ndata: /messages\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const transport = new OpenClawSSEClientTransport(new URL("http://mcp.invalid/sse"), {
      fetch: fetchMock,
      eventSourceInit: { fetch: fetchMock },
    });
    const onclose = vi.fn();
    const onerror = vi.fn();
    // MCP transports expose callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    transport.onclose = onclose;
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    transport.onerror = onerror;

    try {
      await transport.start();
      streamController?.enqueue(encoder.encode(`event: message\ndata: ${OVERSIZED_MCP_TEXT}\n\n`));

      await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(onerror).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("SSE event exceeds 10485760") }),
      );
      expect(getCount).toBe(1);
    } finally {
      await transport.close();
    }
  });

  it("turns legacy SSE HTTP 204 into owner-visible closure", async () => {
    const transport = new OpenClawSSEClientTransport(new URL("http://mcp.invalid/sse"), {
      eventSourceInit: {
        fetch: async () => new Response(null, { status: 204, statusText: "No Content" }),
      },
    });
    const onclose = vi.fn();
    // MCP transports expose callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    transport.onclose = onclose;

    await expect(transport.start()).rejects.toThrow();
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
  });

  it("closes an established legacy SSE transport after a terminal reconnect response", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        return new Response(null, { status: 202 });
      }
      if (!streamController) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(
                encoder.encode("retry: 1\n\nevent: endpoint\ndata: /messages\n\n"),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(null, { status: 503, statusText: "Unavailable" });
    });
    const transport = new OpenClawSSEClientTransport(new URL("http://mcp.invalid/sse"), {
      fetch: fetchMock,
      eventSourceInit: { fetch: fetchMock },
    });
    const onclose = vi.fn();
    // MCP transports expose callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    transport.onclose = onclose;

    try {
      await transport.start();
      streamController?.close();

      await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
      await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).rejects.toThrow(
        "closed",
      );
      expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
    } finally {
      await transport.close();
    }
  });

  it("closes after Streamable notification retry exhaustion", async () => {
    let getCount = 0;
    const fetchMock = initializedFetch({
      onGet: () => {
        getCount += 1;
        return getCount === 1
          ? new Response(new ReadableStream({ start: (controller) => controller.close() }), {
              headers: { "content-type": "text/event-stream" },
            })
          : new Response(null, { status: 503, statusText: "Unavailable" });
      },
    });
    const transport = new OpenClawStreamableHTTPClientTransport(new URL("http://mcp.invalid/mcp"), {
      fetch: fetchMock,
      reconnectionOptions: {
        initialReconnectionDelay: 1,
        maxReconnectionDelay: 1,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 2,
      },
    });
    const client = new Client({ name: "test", version: "1" });
    const onclose = vi.fn();
    // MCP clients expose callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    client.onclose = onclose;

    await client.connect(transport);
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "GET")).toHaveLength(3);
  });

  it("closes a stateful Streamable session when its initial notification GET expired", async () => {
    const fetchMock = initializedFetch({
      onGet: () => new Response("Session not found", { status: 404, statusText: "Not Found" }),
    });
    const transport = new OpenClawStreamableHTTPClientTransport(new URL("http://mcp.invalid/mcp"), {
      fetch: fetchMock,
    });
    const client = new Client({ name: "test", version: "1" });
    const onclose = vi.fn();
    // MCP clients expose callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    client.onclose = onclose;

    try {
      await client.connect(transport);

      await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
      expect(transport.sessionId).toBe("session-1");
      expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "GET")).toHaveLength(1);
    } finally {
      await disposeMcpClient({ client, transport, transportType: "streamable-http" });
    }
  });

  it("sends stateful DELETE after failed initialization closed the SDK transport", async () => {
    const deleteRequests: RequestInit[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleteRequests.push(init);
        return new Response(null, { status: 204 });
      }
      return new Response("initialize failed", {
        status: 500,
        headers: { "mcp-session-id": "allocated-before-failure" },
      });
    });
    const transport = new OpenClawStreamableHTTPClientTransport(new URL("http://mcp.invalid/mcp"), {
      fetch: fetchMock,
    });
    const client = new Client({ name: "test", version: "1" });

    await expect(client.connect(transport)).rejects.toThrow("initialize failed");
    await disposeMcpClient({ client, transport, transportType: "streamable-http" });

    expect(deleteRequests).toHaveLength(1);
    expect(new Headers(deleteRequests[0]?.headers).get("mcp-session-id")).toBe(
      "allocated-before-failure",
    );
    expect(deleteRequests[0]?.signal?.aborted).toBe(false);
  });

  it("does not hang terminateSession when DELETE body cancel never settles", async () => {
    let deleteCount = 0;
    const sockets = new Set<Socket>();
    let server: Server | undefined;
    try {
      server = createServer((request, response) => {
        response.on("error", () => {});
        if (request.method === "DELETE") {
          deleteCount += 1;
          // Real wire DELETE completes with 204. Fetch forbids constructing a
          // Response with status 204 + body, so the never-settling cancel fault
          // is injected via a hanging ReadableStream after real fetch returns.
          response.writeHead(204).end();
          return;
        }
        if (request.method === "GET") {
          response.writeHead(405).end();
          return;
        }
        response.writeHead(500, { "mcp-session-id": "hang-cancel-session" });
        response.end("initialize failed");
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      server.on("clientError", (_err, socket) => socket.destroy());
      await new Promise<void>((resolve) => {
        server?.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === "string") {
        throw new Error("expected loopback TCP address");
      }
      const baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);

      // Production cleanup path: real fetch against loopback DELETE (204). After
      // the wire response returns, replace the (empty) body with a ReadableStream
      // whose cancel() never settles — the fault terminateSession must not await.
      const cleanupFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetch(input, init);
        if (init?.method !== "DELETE") {
          return response;
        }
        expect(response.status).toBe(204);
        // Status must stay ok for terminateSession; Fetch rejects 204 + body.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("bye"));
            },
            cancel() {
              return new Promise(() => {});
            },
          }),
          {
            status: 200,
            statusText: response.statusText,
            headers: response.headers,
          },
        );
      };

      const transport = new OpenClawStreamableHTTPClientTransport(baseUrl, {
        fetch: cleanupFetch,
      });
      const client = new Client({ name: "test", version: "1" });

      await expect(client.connect(transport)).rejects.toThrow("initialize failed");
      expect(transport.sessionId).toBe("hang-cancel-session");

      const startedAt = Date.now();
      await expect(
        Promise.race([
          transport.terminateSession(),
          new Promise<never>((_, reject) => {
            AbortSignal.timeout(1_000).addEventListener("abort", () => {
              reject(new Error("terminateSession hung waiting for body.cancel"));
            });
          }),
        ]),
      ).resolves.toBeUndefined();
      const elapsedMs = Date.now() - startedAt;

      expect(deleteCount).toBe(1);
      expect(elapsedMs).toBeLessThan(1_000);

      // Marked terminated — a second call must not issue another DELETE.
      await transport.terminateSession();
      expect(deleteCount).toBe(1);

      await disposeMcpClient({ client, transport, transportType: "streamable-http" });
      expect(deleteCount).toBe(1);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      if (server) {
        const active = server;
        await new Promise<void>((resolve) => {
          active.close(() => resolve());
          active.closeAllConnections();
        });
      }
    }
  });

  it("does not fetch another notification stream after close returns", async () => {
    let getCount = 0;
    const fetchMock = initializedFetch({
      onGet: () => {
        getCount += 1;
        return new Response(new ReadableStream({ start: (controller) => controller.close() }), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const transport = new OpenClawStreamableHTTPClientTransport(new URL("http://mcp.invalid/mcp"), {
      fetch: fetchMock,
      reconnectionOptions: {
        initialReconnectionDelay: 20,
        maxReconnectionDelay: 20,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 2,
      },
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    await vi.waitFor(() => expect(getCount).toBe(1));

    await client.close();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 80);
    });
    expect(getCount).toBe(1);
  });
});
