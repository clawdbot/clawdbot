import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type EndpointCall = {
  url: string;
  timeoutSeconds: number;
  init: RequestInit;
};

const endpointMockState = vi.hoisted(() => ({
  calls: [] as EndpointCall[],
  responses: [] as Response[],
}));

function requireEndpointCall(index: number): EndpointCall {
  return expectDefined(endpointMockState.calls[index], `Parallel endpoint call ${index}`);
}

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

import { createParallelFreeWebSearchProvider } from "./parallel-free-web-search-provider.js";

function jsonResponse(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function pushHandshake(toolPayload: unknown): void {
  endpointMockState.responses.push(
    jsonResponse(
      { jsonrpc: "2.0", id: "i", result: { protocolVersion: "2025-06-18" } },
      {
        "mcp-session-id": "sess-1",
      },
    ),
    jsonResponse({ jsonrpc: "2.0" }),
    jsonResponse({
      jsonrpc: "2.0",
      id: "c",
      result: { content: [{ type: "text", text: JSON.stringify(toolPayload) }] },
    }),
  );
}

describe("parallel-free web search provider", () => {
  beforeEach(() => {
    endpointMockState.calls = [];
    endpointMockState.responses = [];
  });

  it("exposes keyless metadata without claiming auto-detect fallback", () => {
    const provider = createParallelFreeWebSearchProvider();
    expect(provider.id).toBe("parallel-free");
    expect(provider.label).toBe("Parallel Search (Free)");
    expect(provider.requiresCredential).toBe(false);
    expect(provider.envVars).toEqual([]);
    expect(provider.autoDetectOrder).toBeUndefined();
  });

  it("advertises the shared count contract and free MCP's tighter session_id cap", () => {
    const provider = createParallelFreeWebSearchProvider();
    const tool = provider.createTool({ config: {}, searchConfig: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const sessionIdParam = (
      tool.parameters as { properties: Record<string, { maxLength?: number }> }
    ).properties.session_id;
    expect(expectDefined(sessionIdParam, "Parallel session_id parameter").maxLength).toBe(100);
    const countParam = (
      tool.parameters as {
        properties: Record<string, { type?: string; minimum?: number; maximum?: number }>;
      }
    ).properties.count;
    expect(countParam).toMatchObject({ type: "integer", minimum: 1, maximum: 40 });
  });

  it("searches via the free MCP and brands the result, with no API key", async () => {
    // No PARALLEL_API_KEY needed — the free path ignores keys entirely.
    vi.stubEnv("PARALLEL_API_KEY", "par-should-be-ignored"); // pragma: allowlist secret
    pushHandshake({
      search_id: "s1",
      results: [
        {
          url: "https://example.com",
          title: "Example",
          publish_date: "2024-01-01",
          excerpts: ["hi"],
        },
      ],
    });
    const provider = createParallelFreeWebSearchProvider();
    const tool = provider.createTool({ config: {}, searchConfig: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const result = await tool.execute({
      objective: "find examples",
      search_queries: ["example"],
    });

    // Three MCP calls (initialize -> notifications -> tools/call) to the free MCP.
    expect(endpointMockState.calls).toHaveLength(3);
    const firstCall = requireEndpointCall(0);
    expect(firstCall.url).toBe("https://search.parallel.ai/mcp");
    // No bearer token on the anonymous free path.
    expect((firstCall.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(result).toMatchObject({ provider: "parallel-free" });
    expect(Array.isArray(result.results)).toBe(true);
    expect((result.results as unknown[]).length).toBe(1);
    vi.unstubAllEnvs();
  });

  it("drops an over-limit caller session id and mints one within the free MCP's 100-char cap", async () => {
    pushHandshake({ search_id: "s1", results: [] });
    const provider = createParallelFreeWebSearchProvider();
    const tool = provider.createTool({ config: {}, searchConfig: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    await tool.execute({
      objective: "session cap check",
      search_queries: ["session cap"],
      session_id: "x".repeat(150),
    });

    const toolsCallArgs = (
      JSON.parse(requireEndpointCall(2).init.body as string).params as Record<string, unknown>
    ).arguments as Record<string, unknown>;
    const sentSessionId = toolsCallArgs.session_id as string;
    // The 150-char caller id is out-of-contract for the free MCP; it is dropped
    // and replaced by a generated id that stays within the advertised 100-char cap.
    expect(sentSessionId).not.toBe("x".repeat(150));
    expect(sentSessionId.length).toBeLessThanOrEqual(100);
  });

  it("returns a structured error when search_queries is missing", async () => {
    const provider = createParallelFreeWebSearchProvider();
    const tool = provider.createTool({ config: {}, searchConfig: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const result = await tool.execute({ objective: "x" });
    expect(result.error).toBe("invalid_search_queries");
    expect(endpointMockState.calls).toHaveLength(0);
  });

  it("rejects invalid counts before calling the free MCP", async () => {
    const provider = createParallelFreeWebSearchProvider();
    const tool = provider.createTool({ config: {}, searchConfig: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    for (const count of [4.5, "3abc", 41]) {
      await expect(
        tool.execute({
          objective: "Count validation",
          search_queries: ["count validation"],
          count,
        }),
      ).rejects.toThrow("count must be an integer from 1 to 40.");
    }
    expect(endpointMockState.calls).toHaveLength(0);
  });
});
