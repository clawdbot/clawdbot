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

import {
  extractMcpToolPayload,
  iterMcpMessages,
  runParallelMcpSearch,
  selectMcpEnvelope,
} from "./parallel-mcp-search.runtime.js";

function jsonResponse(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
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

function boundaryJsonPayload(base: Record<string, unknown>): {
  payload: Record<string, unknown>;
  truncatedJson: string;
} {
  const empty = { ...base, detail: "" };
  const jsonPrefix = JSON.stringify(empty).slice(0, -2);
  const detailPrefix = "x".repeat(499 - jsonPrefix.length);
  return {
    payload: { ...base, detail: `${detailPrefix}😀tail` },
    truncatedJson: `${jsonPrefix}${detailPrefix}`,
  };
}

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected call to throw.");
}

describe("iterMcpMessages", () => {
  it("parses a single JSON object body", () => {
    expect(iterMcpMessages('{"id":"a","result":{}}')).toEqual([{ id: "a", result: {} }]);
  });

  it("flattens a JSON array batch", () => {
    expect(iterMcpMessages('[{"id":"a"},{"id":"b"}]')).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("parses SSE events with concatenated data lines", () => {
    const sse = [
      "event: message",
      'data: {"id":"a",',
      'data: "result":{}}',
      "",
      'data: {"id":"b"}',
      "",
    ].join("\n");
    expect(iterMcpMessages(sse)).toEqual([{ id: "a", result: {} }, { id: "b" }]);
  });

  it("skips unparseable chunks and empty bodies", () => {
    expect(iterMcpMessages("")).toEqual([]);
    expect(iterMcpMessages("not json")).toEqual([]);
    expect(iterMcpMessages("data: {bad json}\n\n")).toEqual([]);
  });
});

describe("selectMcpEnvelope", () => {
  it("returns the message whose id matches, skipping notifications", () => {
    const body = [
      '{"jsonrpc":"2.0","method":"notifications/progress"}',
      '{"jsonrpc":"2.0","id":"other","result":{"n":1}}',
      '{"jsonrpc":"2.0","id":"want","result":{"n":2}}',
    ]
      .map((line) => `data: ${line}`)
      .join("\n\n");
    expect(selectMcpEnvelope(body, "want")).toMatchObject({ id: "want", result: { n: 2 } });
  });

  it("falls back to the last result-bearing message when no id matches", () => {
    const body = '{"id":"x","result":{"first":true}}\n';
    expect(selectMcpEnvelope(body, "missing")).toMatchObject({ result: { first: true } });
  });

  it("returns {} when there is no result or error message", () => {
    expect(selectMcpEnvelope('{"method":"notifications/initialized"}', "any")).toEqual({});
  });
});

describe("extractMcpToolPayload", () => {
  it("prefers structuredContent", () => {
    expect(extractMcpToolPayload({ result: { structuredContent: { results: [1] } } })).toEqual({
      results: [1],
    });
  });

  it("parses the first JSON-parseable text block", () => {
    expect(
      extractMcpToolPayload({
        result: {
          content: [
            { type: "text", text: "not json" },
            { type: "text", text: '{"ok":true}' },
          ],
        },
      }),
    ).toEqual({ ok: true });
  });

  it("throws on a JSON-RPC error", () => {
    const { payload, truncatedJson } = boundaryJsonPayload({ code: -1, message: "boom" });

    expect(thrownMessage(() => extractMcpToolPayload({ error: payload }))).toBe(
      `Parallel MCP error: ${truncatedJson}`,
    );
  });

  it("throws on a tool-level isError", () => {
    const { payload, truncatedJson } = boundaryJsonPayload({ isError: true });

    expect(thrownMessage(() => extractMcpToolPayload({ result: payload }))).toBe(
      `Parallel MCP tool error: ${truncatedJson}`,
    );
  });

  it("throws when there is no parseable content", () => {
    const { payload, truncatedJson } = boundaryJsonPayload({ content: [] });

    expect(thrownMessage(() => extractMcpToolPayload({ result: payload }))).toBe(
      `Parallel MCP returned no parseable content: ${truncatedJson}`,
    );
  });
});

describe("runParallelMcpSearch", () => {
  beforeEach(() => {
    endpointMockState.calls = [];
    endpointMockState.responses = [];
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
    expect(headerOf(endpointMockState.calls[1], "Mcp-Session-Id")).toBe("server-session-1");
    expect(headerOf(endpointMockState.calls[2], "Mcp-Session-Id")).toBe("server-session-1");
    expect(headerOf(endpointMockState.calls[2], "MCP-Protocol-Version")).toBe("2025-06-18");
    // No bearer token on the anonymous free path.
    expect(headerOf(endpointMockState.calls[0], "Authorization")).toBeUndefined();
    // Every call identifies OpenClaw at the HTTP layer (not just node).
    for (const call of endpointMockState.calls) {
      expect(headerOf(call, "User-Agent")).toMatch(/^openclaw-parallel\//);
    }
    // tools/call carries the documented web_search args.
    const callArgs = (readBody(endpointMockState.calls[2]).params as Record<string, unknown>)
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

    const callArgs = (readBody(endpointMockState.calls[2]).params as Record<string, unknown>)
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
    const callArgs = (readBody(endpointMockState.calls[2]).params as Record<string, unknown>)
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
