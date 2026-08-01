import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../../test-support/streaming-error-response.js";

type EndpointCall = {
  url: string;
  timeoutSeconds: number;
  init: RequestInit;
};

const endpointMockState = vi.hoisted(() => ({
  calls: [] as EndpointCall[],
  responses: [] as Response[],
}));

vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>();
  const runEndpoint = async (
    params: EndpointCall,
    run: (response: Response) => Promise<unknown>,
  ) => {
    endpointMockState.calls.push(params);
    const response = endpointMockState.responses.shift();
    if (!response) {
      throw new Error("Missing mocked Parallel MCP response.");
    }
    return await run(response);
  };
  return {
    ...actual,
    withTrustedWebSearchEndpoint: vi.fn(runEndpoint),
  };
});

import { runParallelMcpSearch } from "./parallel-mcp-search.runtime.js";

function jsonResponse(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function rawResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

function readBody(call: EndpointCall): Record<string, unknown> {
  if (typeof call.init.body !== "string") {
    throw new Error("Expected a JSON string body.");
  }
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

function headerOf(call: EndpointCall, name: string): string | undefined {
  return (call.init.headers as Record<string, string>)[name];
}

function requireEndpointCall(index: number): EndpointCall {
  return expectDefined(endpointMockState.calls[index], `Parallel MCP endpoint call ${index}`);
}

describe("runParallelMcpSearch", () => {
  beforeEach(() => {
    endpointMockState.calls = [];
    endpointMockState.responses = [];
  });

  it("handles SSE notifications, multiline events, JSON batches, and structured payloads", async () => {
    endpointMockState.responses.push(
      rawResponse(
        [
          'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
          "",
          'data: {"jsonrpc":"2.0","id":"ignored",',
          'data: "result":{"protocolVersion":"2025-06-18"}}',
          "",
        ].join("\n"),
        "text/event-stream",
      ),
      jsonResponse({ jsonrpc: "2.0" }),
      jsonResponse([
        { jsonrpc: "2.0", method: "notifications/progress" },
        {
          jsonrpc: "2.0",
          id: "ignored",
          result: {
            structuredContent: {
              search_id: "search_sse",
              results: [{ url: "https://example.com", title: "Example", excerpts: ["hi"] }],
            },
          },
        },
      ]),
    );

    await expect(
      runParallelMcpSearch({ searchQueries: ["test"], maxResults: 5 }),
    ).resolves.toMatchObject({
      search_id: "search_sse",
      results: [{ url: "https://example.com", title: "Example" }],
    });
  });

  it.each([
    [{ error: { code: -1, message: "boom" } }, "Parallel MCP error"],
    [{ result: { isError: true } }, "Parallel MCP tool error"],
    [{ result: { content: [] } }, "Parallel MCP returned no parseable content"],
  ])("surfaces bounded tool-envelope failures", async (envelope, expectedPrefix) => {
    const detail = `${"x".repeat(600)}😀tail`;
    const detailedEnvelope =
      "error" in envelope
        ? { error: { ...envelope.error, detail } }
        : { result: { ...envelope.result, detail } };
    endpointMockState.responses.push(
      jsonResponse({ result: { protocolVersion: "2025-06-18" } }),
      jsonResponse({}),
      jsonResponse(detailedEnvelope),
    );

    await expect(runParallelMcpSearch({ searchQueries: ["test"], maxResults: 5 })).rejects.toThrow(
      expectedPrefix,
    );
  });

  it("runs the 3-step handshake and maps results into the REST-compatible shape", async () => {
    endpointMockState.responses.push(
      jsonResponse(
        { jsonrpc: "2.0", id: "ignored", result: { protocolVersion: "2025-06-18" } },
        { "mcp-session-id": "server-session-1" },
      ),
      jsonResponse({ jsonrpc: "2.0" }), // notifications/initialized ack
      jsonResponse({
        jsonrpc: "2.0",
        id: "ignored",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                search_id: "search_abc",
                results: [
                  {
                    url: "https://example.com",
                    title: "Example",
                    publish_date: "2024-01-01",
                    excerpts: ["hi"],
                  },
                  { url: "https://second.com", title: "Second", excerpts: ["yo"] },
                ],
              }),
            },
          ],
        },
      }),
    );

    const response = await runParallelMcpSearch({
      objective: "find examples",
      searchQueries: ["example query"],
      maxResults: 1,
      modelName: "claude-opus-4-8",
    });

    // 3 HTTP calls: initialize, notifications/initialized, tools/call.
    expect(endpointMockState.calls.map((c) => readBody(c).method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    // Server session id + a negotiated protocol version are echoed post-init.
    expect(headerOf(requireEndpointCall(1), "Mcp-Session-Id")).toBe("server-session-1");
    expect(headerOf(requireEndpointCall(2), "Mcp-Session-Id")).toBe("server-session-1");
    expect(headerOf(requireEndpointCall(2), "MCP-Protocol-Version")).toBe("2025-06-18");
    // No bearer token on the anonymous free path.
    expect(headerOf(requireEndpointCall(0), "Authorization")).toBeUndefined();
    // Every call identifies OpenClaw at the HTTP layer (not just node).
    for (const call of endpointMockState.calls) {
      expect(headerOf(call, "User-Agent")).toMatch(/^openclaw-parallel\//);
    }
    // tools/call carries the documented web_search args.
    const callArgs = (readBody(requireEndpointCall(2)).params as Record<string, unknown>)
      .arguments as Record<string, unknown>;
    expect(callArgs).toMatchObject({
      objective: "find examples",
      search_queries: ["example query"],
      model_name: "claude-opus-4-8",
    });
    expect(typeof callArgs.session_id).toBe("string");

    // maxResults applied client-side; mapped to the REST-compatible response.
    expect(response.search_id).toBe("search_abc");
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({ url: "https://example.com", title: "Example" });
  });

  it("uses the search queries as the objective when none was supplied", async () => {
    endpointMockState.responses.push(
      jsonResponse({ jsonrpc: "2.0", id: "i", result: {} }, { "mcp-session-id": "s" }),
      jsonResponse({ jsonrpc: "2.0" }),
      jsonResponse({
        jsonrpc: "2.0",
        id: "c",
        result: { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] },
      }),
    );

    await runParallelMcpSearch({ searchQueries: ["alpha", "beta"], maxResults: 5 });

    const callArgs = (readBody(requireEndpointCall(2)).params as Record<string, unknown>)
      .arguments as Record<string, unknown>;
    expect(callArgs.objective).toBe("alpha beta");
  });

  it("forwards a caller-supplied session id verbatim (no re-minting)", async () => {
    endpointMockState.responses.push(
      jsonResponse({ jsonrpc: "2.0", id: "i", result: {} }, { "mcp-session-id": "s" }),
      jsonResponse({ jsonrpc: "2.0" }),
      jsonResponse({
        jsonrpc: "2.0",
        id: "c",
        result: { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] },
      }),
    );
    // The MCP client is a dumb transport: an already-normalized caller id (the
    // provider runtime caps it at the free MCP's 100-char limit) is forwarded as
    // sent, so the MCP session, cache key, and reported id stay in agreement.
    const callerSessionId = `sess-${"a".repeat(40)}`;
    const response = await runParallelMcpSearch({
      searchQueries: ["x"],
      maxResults: 5,
      sessionId: callerSessionId,
    });
    const callArgs = (readBody(requireEndpointCall(2)).params as Record<string, unknown>)
      .arguments as Record<string, unknown>;
    expect(callArgs.session_id).toBe(callerSessionId);
    expect(response.session_id).toBe(callerSessionId);
  });

  it("throws when initialize fails", async () => {
    endpointMockState.responses.push(new Response("nope", { status: 500 }));
    await expect(runParallelMcpSearch({ searchQueries: ["x"], maxResults: 5 })).rejects.toThrow(
      /initialize failed \(500\)/,
    );
  });

  it("throws when the initialized acknowledgement fails", async () => {
    endpointMockState.responses.push(
      jsonResponse(
        { jsonrpc: "2.0", id: "i", result: { protocolVersion: "2025-06-18" } },
        { "mcp-session-id": "server-session-1" },
      ),
      new Response("ack nope", { status: 500 }),
    );

    await expect(runParallelMcpSearch({ searchQueries: ["x"], maxResults: 5 })).rejects.toThrow(
      /notifications\/initialized failed \(500\): ack nope/,
    );

    expect(endpointMockState.calls.map((c) => readBody(c).method)).toEqual([
      "initialize",
      "notifications/initialized",
    ]);
    expect(headerOf(requireEndpointCall(1), "Mcp-Session-Id")).toBe("server-session-1");
    expect(headerOf(requireEndpointCall(1), "MCP-Protocol-Version")).toBe("2025-06-18");
  });

  it("bounds initialize error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"parallel mcp unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    endpointMockState.responses.push(tracked.response);

    const error = await runParallelMcpSearch({ searchQueries: ["x"], maxResults: 5 }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/initialize failed \(503\): parallel mcp unavailable/);
    expect((error as Error).message).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("bounds successful MCP bodies without using response.text()", async () => {
    const streamed = createStreamingResponse({
      chunkCount: 32,
      chunkSize: 1024 * 1024,
      text: "x",
      headers: { "Content-Type": "application/json" },
    });
    const textSpy = vi.spyOn(streamed.response, "text").mockRejectedValue(new Error("unbounded"));
    endpointMockState.responses.push(streamed.response);

    const error = await runParallelMcpSearch({ searchQueries: ["x"], maxResults: 5 }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Parallel MCP: text response exceeds 16777216 bytes",
    );
    expect(streamed.getReadCount()).toBeLessThan(32);
    expect(streamed.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });
});
