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
    return new Response(null, { status: 202 });
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
