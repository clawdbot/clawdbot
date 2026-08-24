import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../../test-support/streaming-error-response.js";
type EndpointCall = {
  url: string;
  timeoutSeconds: number;
  init: RequestInit;
  signal?: AbortSignal;
};
type JsonRecord = Record<string, unknown>;
type ToolParameters = {
  properties: Record<
    string,
    { type?: string; minimum?: number; maximum?: number; maxLength?: number }
  >;
};
const endpointMockState = vi.hoisted(() => ({
  calls: [] as EndpointCall[],
  effects: [] as Array<(() => void) | undefined>,
  responses: [] as Response[],
}));
vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>();
  return {
    ...actual,
    withTrustedWebSearchEndpoint: vi.fn(
      async (params: EndpointCall, run: (response: Response) => Promise<unknown>) => {
        endpointMockState.calls.push(params);
        const response = endpointMockState.responses.shift();
        if (!response) {
          throw new Error("Missing mocked Parallel response.");
        }
        endpointMockState.effects.shift()?.();
        return await run(response);
      },
    ),
  };
});
import { testing } from "../test-api.js";
import { createParallelWebSearchProvider as createContractParallelWebSearchProvider } from "../web-search-contract-api.js";
import { createParallelFreeWebSearchProvider } from "./parallel-free-web-search-provider.js";
import { runParallelMcpSearch } from "./parallel-mcp-search.runtime.js";
import { createParallelWebSearchProvider } from "./parallel-web-search-provider.js";
const EMPTY_SEARCH_RESPONSE = { search_id: "x", session_id: "y", results: [] };
function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
function enqueueJson(body: unknown = EMPTY_SEARCH_RESPONSE): void {
  endpointMockState.responses.push(jsonResponse(body));
}
function paidTool(searchConfig: Record<string, unknown> = { parallel: { apiKey: "par-secret" } }) {
  return expectDefined(
    createParallelWebSearchProvider().createTool({ config: {}, searchConfig } as never),
    "Parallel tool definition",
  );
}
function freeTool() {
  return expectDefined(
    createParallelFreeWebSearchProvider().createTool({ config: {}, searchConfig: {} }),
    "Parallel free tool definition",
  );
}
function endpointCall(index: number): EndpointCall {
  return expectDefined(endpointMockState.calls[index], `Parallel endpoint call ${index}`);
}
function readBody(call: EndpointCall = endpointCall(0)): JsonRecord {
  if (typeof call.init.body !== "string") {
    throw new Error("Expected a JSON string body.");
  }
  return JSON.parse(call.init.body) as JsonRecord;
}
function callArguments(index = 2): JsonRecord {
  return (readBody(endpointCall(index)).params as JsonRecord).arguments as JsonRecord;
}
function headerOf(call: EndpointCall, name: string): string | undefined {
  return (call.init.headers as Record<string, string>)[name];
}
function pushMcpHandshake(
  toolPayload: unknown,
  sessionId = "sess-1",
  protocolVersion: string | null = "2025-06-18",
): void {
  endpointMockState.responses.push(
    jsonResponse(
      { jsonrpc: "2.0", id: "i", result: protocolVersion ? { protocolVersion } : {} },
      { "mcp-session-id": sessionId },
    ),
    jsonResponse({ jsonrpc: "2.0" }),
    jsonResponse({
      jsonrpc: "2.0",
      id: "c",
      result: { content: [{ type: "text", text: JSON.stringify(toolPayload) }] },
    }),
  );
}
function cancelTrackedResponse(text: string, init: ResponseInit) {
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
type CacheKeyParams = Parameters<typeof testing.buildParallelCacheKey>[0];
const CACHE_KEY_BASE: CacheKeyParams = {
  endpoint: "https://api.parallel.ai/v1/search",
  objective: "Find OpenClaw on GitHub",
  searchQueries: ["openclaw github"],
  count: 5,
};
const cacheKey = (overrides: Partial<CacheKeyParams> = {}) =>
  testing.buildParallelCacheKey({ ...CACHE_KEY_BASE, ...overrides });
beforeEach(() => {
  endpointMockState.calls = [];
  endpointMockState.effects = [];
  endpointMockState.responses = [];
});
describe("parallel web search provider", () => {
  it("exposes the expected metadata and selection wiring", () => {
    const provider = createParallelWebSearchProvider();
    const applied = expectDefined(provider.applySelectionConfig, "applySelectionConfig")({});
    expect(provider.id).toBe("parallel");
    expect(provider.onboardingScopes).toEqual(["text-inference"]);
    expect(provider.credentialPath).toBe("plugins.entries.parallel.config.webSearch.apiKey");
    expect(expectDefined(applied.plugins?.entries?.parallel, "Parallel plugin entry").enabled).toBe(
      true,
    );
  });
  it("advertises count as an integer from 1 to 40", () => {
    const countParam = (paidTool({}).parameters as ToolParameters).properties.count;
    expect(countParam).toMatchObject({ type: "integer", minimum: 1, maximum: 40 });
  });
  it("keeps the lightweight contract surface aligned with provider metadata", () => {
    const provider = createParallelWebSearchProvider();
    const contractProvider = createContractParallelWebSearchProvider();
    const applied = expectDefined(
      contractProvider.applySelectionConfig,
      "contract applySelectionConfig",
    )({});
    const keys = [
      "id",
      "label",
      "hint",
      "onboardingScopes",
      "credentialLabel",
      "envVars",
      "placeholder",
      "signupUrl",
      "docsUrl",
      "autoDetectOrder",
      "credentialPath",
    ] as const;
    expect(Object.fromEntries(keys.map((key) => [key, contractProvider[key]]))).toEqual(
      Object.fromEntries(keys.map((key) => [key, provider[key]])),
    );
    expect(contractProvider.createTool({ config: {}, searchConfig: {} })).toBeNull();
    expect(expectDefined(applied.plugins?.entries?.parallel, "contract plugin entry").enabled).toBe(
      true,
    );
  });
  it("prefers scoped configured api keys over environment fallbacks", () => {
    expect(testing.resolveParallelApiKey({ apiKey: "par-secret" })).toBe("par-secret");
  });
  it("resolves Parallel search base URL overrides", () => {
    expect(testing.resolveParallelSearchEndpoint()).toEqual({
      endpoint: "https://api.parallel.ai/v1/search",
    });
    expect(
      testing.resolveParallelSearchEndpoint({ baseUrl: "https://proxy.example/parallel" }),
    ).toEqual({ endpoint: "https://proxy.example/parallel/v1/search" });
    expect(
      testing.resolveParallelSearchEndpoint({ baseUrl: "proxy.example/parallel/v1/search/" }),
    ).toEqual({ endpoint: "https://proxy.example/parallel/v1/search" });
    expect(
      testing.resolveParallelSearchEndpoint({ baseUrl: "ftp://proxy.example/parallel" }),
    ).toEqual({
      docs: "https://docs.openclaw.ai/tools/parallel-search",
      error: "invalid_base_url",
      message:
        "plugins.entries.parallel.config.webSearch.baseUrl must be a valid http(s) URL. Got: ftp://proxy.example/parallel",
    });
  });
  it("partitions Parallel cache keys by resolved endpoint", () => {
    expect(cacheKey()).not.toBe(cacheKey({ endpoint: "https://proxy.example/parallel/v1/search" }));
  });
  it("partitions Parallel cache keys by resolved result count", () => {
    expect(cacheKey()).not.toBe(cacheKey({ count: 10 }));
  });
  it("partitions Parallel cache keys by objective and by search_queries set", () => {
    expect(cacheKey()).not.toBe(cacheKey({ objective: "Find the OpenClaw release notes" }));
    expect(cacheKey()).not.toBe(
      cacheKey({ searchQueries: ["openclaw github", "openclaw repository"] }),
    );
  });
  it("partitions Parallel cache keys by caller-provided session id", () => {
    expect(cacheKey({ sessionId: "session-a" })).not.toBe(cacheKey({ sessionId: "session-b" }));
    expect(cacheKey()).not.toBe(cacheKey({ sessionId: "session-a" }));
  });
  it("partitions Parallel cache keys by client_model so per-model results never bleed", () => {
    expect(cacheKey({ clientModel: "claude-opus-4-7" })).not.toBe(
      cacheKey({ clientModel: "gpt-5.5" }),
    );
    expect(cacheKey()).not.toBe(cacheKey({ clientModel: "claude-opus-4-7" }));
  });
  it("normalizes objectives by trimming and capping at 5000 chars", () => {
    expect(testing.normalizeParallelObjective("  Find OpenClaw  ")).toBe("Find OpenClaw");
    expect(testing.normalizeParallelObjective(undefined)).toBeUndefined();
    expect(testing.normalizeParallelObjective("")).toBeUndefined();
    expect((testing.normalizeParallelObjective("x".repeat(6000)) ?? "").length).toBe(5000);
    expect(testing.normalizeParallelObjective(`${"x".repeat(4999)}🚀tail`)).toBe("x".repeat(4999));
  });
  it("normalizes search_queries: trim, drop blanks, dedupe, cap length, cap count", () => {
    expect(
      testing.normalizeParallelSearchQueries([
        "openclaw github",
        "  openclaw github  ",
        "",
        " ",
        42,
        "openclaw releases",
      ]),
    ).toEqual(["openclaw github", "openclaw releases"]);
    expect(testing.normalizeParallelSearchQueries(undefined)).toEqual([]);
    expect(testing.normalizeParallelSearchQueries("openclaw github")).toEqual([]);
    expect(testing.normalizeParallelSearchQueries(["x".repeat(250)])).toEqual(["x".repeat(200)]);
    expect(testing.normalizeParallelSearchQueries([`${"x".repeat(199)}🚀tail`])).toEqual([
      "x".repeat(199),
    ]);
    expect(testing.normalizeParallelSearchQueries(["a", "b", "c", "d", "e", "f"])).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });
  it("normalizes session ids, rejecting blanks and values past the given limit", () => {
    expect(testing.normalizeParallelSessionId("session-abc", 1000)).toBe("session-abc");
    expect(testing.normalizeParallelSessionId("  ", 1000)).toBeUndefined();
    expect(testing.normalizeParallelSessionId(undefined, 1000)).toBeUndefined();
    expect(testing.normalizeParallelSessionId("x".repeat(1001), 1000)).toBeUndefined();
    expect(testing.normalizeParallelSessionId("x".repeat(101), 100)).toBeUndefined();
    expect(testing.normalizeParallelSessionId("x".repeat(100), 100)).toBe("x".repeat(100));
  });
  it("normalizes client_model identifiers", () => {
    expect(testing.normalizeParallelClientModel("claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(testing.normalizeParallelClientModel("  gpt-5.5  ")).toBe("gpt-5.5");
    expect(testing.normalizeParallelClientModel(undefined)).toBeUndefined();
    expect((testing.normalizeParallelClientModel("a".repeat(200)) ?? "").length).toBe(100);
    expect(testing.normalizeParallelClientModel(`${"m".repeat(99)}🚀tail`)).toBe("m".repeat(99));
  });
  it("normalizes the Parallel /v1/search response shape", () => {
    expect(
      testing.normalizeParallelResults({
        results: [
          {
            url: "https://example.com/a",
            title: "Sample",
            publish_date: "2026-04-01",
            excerpts: ["first", "second"],
          },
          "not-an-object",
        ],
      }),
    ).toEqual([
      {
        url: "https://example.com/a",
        title: "Sample",
        publish_date: "2026-04-01",
        excerpts: ["first", "second"],
      },
    ]);
    expect(testing.normalizeParallelResults({})).toEqual([]);
    expect(testing.normalizeParallelResults(null)).toEqual([]);
  });
  it("resolves configured counts while strictly validating the tool schema range", () => {
    expect(testing.resolveParallelSearchCount({}, undefined)).toBe(5);
    expect(testing.resolveParallelSearchCount({}, 120)).toBe(40);
    expect(testing.resolveParallelSearchCount({}, 0)).toBe(1);
    expect(testing.resolveParallelSearchCount({ count: 40 }, 5)).toBe(40);
    for (const count of [0, 4.5, "3abc", 41]) {
      expect(() => testing.resolveParallelSearchCount({ count }, 5)).toThrow(
        "count must be an integer from 1 to 40.",
      );
    }
  });
  it("returns a stable missing-key payload that points at the real config path", () => {
    expect(testing.missingParallelKeyPayload()).toEqual({
      error: "missing_parallel_api_key",
      message:
        "web_search (parallel) needs a Parallel API key. Set PARALLEL_API_KEY in the Gateway environment, or configure plugins.entries.parallel.config.webSearch.apiKey.",
      docs: "https://docs.openclaw.ai/tools/parallel-search",
    });
  });
  it("identifies the plugin via a versioned User-Agent header", () => {
    expect(testing.USER_AGENT).toMatch(/^openclaw-parallel\/\d+\.\d+\.\d+/);
  });
  it("treats objective as optional and omits it from the request when absent", async () => {
    enqueueJson();
    const result = await paidTool().execute({ search_queries: ["openclaw"] });
    expect(endpointMockState.calls).toHaveLength(1);
    const body = readBody();
    expect(body).not.toHaveProperty("objective");
    expect(body).toMatchObject({ search_queries: ["openclaw"] });
    expect(result).not.toHaveProperty("objective");
    expect(result).toMatchObject({ provider: "parallel" });
  });
  it("forwards paid-search cancellation to the guarded endpoint", async () => {
    enqueueJson();
    const controller = new AbortController();

    await paidTool().execute(
      { search_queries: ["parallel active cancellation"] },
      { signal: controller.signal },
    );

    expect(endpointCall(0).signal).toBe(controller.signal);
  });
  it("does not bill an already canceled paid search", async () => {
    enqueueJson();
    const controller = new AbortController();
    controller.abort(new Error("Parallel caller canceled"));

    await expect(
      paidTool().execute(
        { search_queries: ["parallel pre-canceled"] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("Parallel caller canceled");
    expect(endpointMockState.calls).toHaveLength(0);
  });
  it("returns an error payload when search_queries is missing or empty", async () => {
    const tool = paidTool();
    expect(await tool.execute({ objective: "Find OpenClaw on GitHub" })).toMatchObject({
      error: "invalid_search_queries",
    });
    expect(
      await tool.execute({ objective: "Find OpenClaw on GitHub", search_queries: [] }),
    ).toMatchObject({ error: "invalid_search_queries" });
    expect(endpointMockState.calls).toHaveLength(0);
  });
  it("promotes a generic `query` arg into search_queries when search_queries is absent (no synthesized objective)", async () => {
    enqueueJson();
    const result = await paidTool().execute({ query: "OpenClaw GitHub", count: 3 });
    expect(endpointMockState.calls).toHaveLength(1);
    const body = readBody();
    expect(body).not.toHaveProperty("objective");
    expect(body).toMatchObject({
      search_queries: ["OpenClaw GitHub"],
      advanced_settings: { max_results: 3 },
    });
    expect(result).not.toHaveProperty("objective");
    expect(result).toMatchObject({ provider: "parallel" });
  });
  it("rejects invalid counts before calling Parallel", async () => {
    const tool = paidTool();
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
  it("prefers explicit objective+search_queries over the generic `query` fallback when all are present", async () => {
    enqueueJson();
    await paidTool().execute({
      objective: "Native objective",
      search_queries: ["native query"],
      query: "legacy fallback",
    });
    expect(readBody()).toMatchObject({
      objective: "Native objective",
      search_queries: ["native query"],
    });
  });
  it("honors top-level web search settings and sends the native Parallel payload shape", async () => {
    enqueueJson({
      search_id: "search_test",
      session_id: "session_test",
      results: [{ url: "https://example.com/a", title: "A", excerpts: ["alpha"] }],
    });
    const result = await paidTool({
      parallel: { apiKey: "par-secret" },
      maxResults: 3,
      timeoutSeconds: 5,
    }).execute({
      objective: "Find the OpenClaw repository on GitHub",
      search_queries: ["openclaw github", "openclaw repository"],
    });
    expect(endpointMockState.calls).toHaveLength(1);
    const call = endpointCall(0);
    expect(call.url).toBe("https://api.parallel.ai/v1/search");
    expect(call.timeoutSeconds).toBe(5);
    expect(readBody(call)).toEqual({
      objective: "Find the OpenClaw repository on GitHub",
      search_queries: ["openclaw github", "openclaw repository"],
      advanced_settings: { max_results: 3 },
    });
    const headers = (call.init.headers ?? {}) as Record<string, string>;
    expect(headers["x-api-key"]).toBe("par-secret");
    expect(headers["User-Agent"]).toMatch(/^openclaw-parallel\//);
    expect(result).toMatchObject({
      provider: "parallel",
      searchId: "search_test",
      sessionId: "session_test",
    });
  });
  it("threads caller-supplied session_id and client_model through to Parallel", async () => {
    enqueueJson({ search_id: "search_test", session_id: "session-caller-supplied", results: [] });
    const result = await paidTool().execute({
      objective: "Find the OpenClaw repository on GitHub",
      search_queries: ["openclaw github"],
      session_id: "session-caller-supplied",
      client_model: "claude-opus-4-7",
    });
    expect(readBody()).toMatchObject({
      objective: "Find the OpenClaw repository on GitHub",
      search_queries: ["openclaw github"],
      session_id: "session-caller-supplied",
      client_model: "claude-opus-4-7",
    });
    expect(result).toMatchObject({ sessionId: "session-caller-supplied" });
  });
  it("always sends max_results matching the OpenClaw web_search default when no count is provided", async () => {
    enqueueJson();
    await paidTool().execute({ objective: "Find OpenClaw", search_queries: ["openclaw"] });
    expect(endpointMockState.calls).toHaveLength(1);
    const body = readBody() as { advanced_settings?: { max_results?: number } };
    expect(body.advanced_settings?.max_results).toBe(5);
  });
  it("caps returned and cached results when paid Parallel exceeds the requested count", async () => {
    enqueueJson({
      search_id: "parallel-result-cap",
      session_id: "parallel-cap-session",
      results: [
        { url: "https://example.com/first", title: "First", excerpts: ["first"] },
        { url: "https://example.com/second", title: "Second", excerpts: ["second"] },
        { url: "https://example.com/third", title: "Third", excerpts: ["third"] },
      ],
      warnings: ["provider warning"],
      usage: [{ count: 1 }],
    });
    const tool = paidTool();
    const args = {
      search_queries: ["parallel result count owner"],
      session_id: "parallel-cap-session",
      count: 1,
    };

    const first = await tool.execute(args);
    const cached = await tool.execute(args);

    expect(endpointMockState.calls).toHaveLength(1);
    expect(readBody()).toMatchObject({ advanced_settings: { max_results: 1 } });
    expect(first).toMatchObject({
      count: 1,
      searchId: "parallel-result-cap",
      sessionId: "parallel-cap-session",
      warnings: ["provider warning"],
      usage: [{ count: 1 }],
    });
    expect(first.results).toHaveLength(1);
    expect(cached).toEqual({ ...first, cached: true });
  });
  it("bounds Parallel API error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"parallel upstream unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    endpointMockState.responses.push(tracked.response);
    const error = await paidTool()
      .execute({
        objective: `parallel-error-body-${Date.now()}`,
        search_queries: ["openclaw"],
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /Parallel API error \(503\): parallel upstream unavailable/,
    );
    expect((error as Error).message).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });
  it("redacts reflected credentials from Parallel API error bodies", async () => {
    // No dictionary words: the value must be masked even when only the
    // header-shaped (x-api-key: <value>) redaction can catch it.
    const apiKey = "par-live-4c9d2e7ab1f0c9d2e7ab1f0c9d2e7";
    endpointMockState.responses.push(
      new Response(`<html><body>edge failure for request with x-api-key: ${apiKey}</body></html>`, {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "Content-Type": "text/html" },
      }),
    );
    const error = await paidTool({ parallel: { apiKey } })
      .execute({
        objective: `parallel-error-redact-${Date.now()}`,
        search_queries: ["openclaw"],
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Parallel API error (502)");
    expect((error as Error).message).not.toContain(apiKey);
  });
  it("redacts credentials reflected in the statusText fallback when the body is empty", async () => {
    const apiKey = "par-live-4c9d2e7ab1f0c9d2e7ab1f0c9d2e7";
    endpointMockState.responses.push(
      new Response("", {
        status: 502,
        statusText: `Bad Gateway reflected x-api-key: ${apiKey}`,
      }),
    );
    const error = await paidTool({ parallel: { apiKey } })
      .execute({
        objective: `parallel-error-redact-reason-${Date.now()}`,
        search_queries: ["openclaw"],
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Parallel API error (502)");
    expect((error as Error).message).not.toContain(apiKey);
  });
  it("applies configured logging.redactPatterns to reflected Parallel error bodies", async () => {
    // Organization-specific secret shape that no built-in pattern covers, plus a
    // configured field-name pattern that would rewrite the x-api-key header name
    // before the structured matcher can see it — the key value must stay masked.
    const orgSecret = "acme-internal-bluefin-042";
    const apiKey = "par-live-4c9d2e7ab1f0c9d2e7ab1f0c9d2e7";
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-redact-config-"));
    const configPath = path.join(configDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        logging: { redactPatterns: ["acme-internal-[a-z0-9-]+", "api[_-]?key"] },
      }),
    );
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    try {
      endpointMockState.responses.push(
        new Response(
          `<html><body>edge failure for ${orgSecret} on request with x-api-key: ${apiKey}</body></html>`,
          {
            status: 502,
            statusText: "Bad Gateway",
            headers: { "Content-Type": "text/html" },
          },
        ),
      );
      const error = await paidTool({ parallel: { apiKey } })
        .execute({
          objective: `parallel-error-redact-config-${Date.now()}`,
          search_queries: ["openclaw"],
        })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Parallel API error (502)");
      expect((error as Error).message).not.toContain(orgSecret);
      expect((error as Error).message).not.toContain(apiKey);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(configDir, { force: true, recursive: true });
    }
  });
  it("bounds successful Parallel JSON bodies instead of buffering the whole response", async () => {
    const streamed = createStreamingResponse({
      chunkCount: 200,
      chunkSize: 1024 * 1024,
      text: "a",
      headers: { "Content-Type": "application/json" },
    });
    endpointMockState.responses.push(streamed.response);
    const error = await paidTool()
      .execute({
        objective: `parallel-success-body-${Date.now()}-${Math.random()}`,
        search_queries: ["openclaw"],
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      new RegExp(
        `Parallel API: JSON response exceeds ${testing.PARALLEL_SEARCH_RESPONSE_LIMIT_BYTES} bytes`,
      ),
    );
    expect(streamed.getReadCount()).toBeLessThan(200);
    expect(streamed.wasCanceled()).toBe(true);
  });
  it("parses a well-formed Parallel JSON body under the byte cap", async () => {
    enqueueJson({
      search_id: "ok",
      session_id: "ok-session",
      results: [{ url: "https://example.com/a", title: "A", excerpts: ["alpha"] }],
    });
    const result = await paidTool().execute({
      objective: `parallel-success-ok-${Date.now()}-${Math.random()}`,
      search_queries: ["openclaw"],
    });
    expect(result).toMatchObject({ provider: "parallel", searchId: "ok", count: 1 });
  });
  it("does not surface a Parallel-generated sessionId on a cache hit", async () => {
    const objective = `parallel-cache-isolation-${Date.now()}-${Math.random()}`;
    enqueueJson({ search_id: "first", session_id: "session-generated-by-parallel", results: [] });
    const tool = paidTool();
    const firstResult = await tool.execute({ objective, search_queries: ["openclaw github"] });
    expect(firstResult.sessionId).toBe("session-generated-by-parallel");
    const secondResult = await tool.execute({ objective, search_queries: ["openclaw github"] });
    expect(endpointMockState.calls).toHaveLength(1);
    expect(secondResult.sessionId).toBeUndefined();
  });
  it("preserves caller-supplied sessionId across cache hits", async () => {
    const objective = `parallel-cache-session-${Date.now()}-${Math.random()}`;
    const sessionId = `session-${Date.now()}`;
    enqueueJson({ search_id: "first", session_id: sessionId, results: [] });
    const tool = paidTool();
    await tool.execute({ objective, search_queries: ["openclaw github"], session_id: sessionId });
    const cached = await tool.execute({
      objective,
      search_queries: ["openclaw github"],
      session_id: sessionId,
    });
    expect(endpointMockState.calls).toHaveLength(1);
    expect(cached.sessionId).toBe(sessionId);
  });
});
describe("runParallelMcpSearch", () => {
  it("handles SSE notifications, multiline events, JSON batches, and structured payloads", async () => {
    endpointMockState.responses.push(
      new Response(
        [
          'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
          "",
          'data: {"jsonrpc":"2.0","id":"ignored",',
          'data: "result":{"protocolVersion":"2025-06-18"}}',
          "",
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
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
    pushMcpHandshake(
      {
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
      },
      "server-session-1",
    );
    const response = await runParallelMcpSearch({
      objective: "find examples",
      searchQueries: ["example query"],
      maxResults: 1,
      modelName: "claude-opus-4-8",
    });
    expect(endpointMockState.calls.map((call) => readBody(call).method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(headerOf(endpointCall(1), "Mcp-Session-Id")).toBe("server-session-1");
    expect(headerOf(endpointCall(2), "Mcp-Session-Id")).toBe("server-session-1");
    expect(headerOf(endpointCall(2), "MCP-Protocol-Version")).toBe("2025-06-18");
    expect(headerOf(endpointCall(0), "Authorization")).toBeUndefined();
    for (const call of endpointMockState.calls) {
      expect(headerOf(call, "User-Agent")).toMatch(/^openclaw-parallel\//);
    }
    const args = callArguments();
    expect(args).toMatchObject({
      objective: "find examples",
      search_queries: ["example query"],
      model_name: "claude-opus-4-8",
    });
    expect(typeof args.session_id).toBe("string");
    expect(response.search_id).toBe("search_abc");
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({ url: "https://example.com", title: "Example" });
  });
  it("uses the search queries as the objective when none was supplied", async () => {
    pushMcpHandshake({ results: [] }, "s", null);
    await runParallelMcpSearch({ searchQueries: ["alpha", "beta"], maxResults: 5 });
    expect(callArguments().objective).toBe("alpha beta");
    expect(headerOf(endpointCall(1), "MCP-Protocol-Version")).toBe("2025-06-18");
  });
  it("forwards a caller-supplied session id verbatim (no re-minting)", async () => {
    pushMcpHandshake({ results: [] }, "s");
    const callerSessionId = `sess-${"a".repeat(40)}`;
    const response = await runParallelMcpSearch({
      searchQueries: ["x"],
      maxResults: 5,
      sessionId: callerSessionId,
    });
    expect(callArguments().session_id).toBe(callerSessionId);
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
    expect(endpointMockState.calls.map((call) => readBody(call).method)).toEqual([
      "initialize",
      "notifications/initialized",
    ]);
    expect(headerOf(endpointCall(1), "Mcp-Session-Id")).toBe("server-session-1");
    expect(headerOf(endpointCall(1), "MCP-Protocol-Version")).toBe("2025-06-18");
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
describe("parallel-free web search provider", () => {
  it("keeps caller cancellation attached to every free MCP handshake step", async () => {
    pushMcpHandshake({ search_id: "free-cancellation", results: [] });
    const controller = new AbortController();

    await freeTool().execute(
      { search_queries: ["parallel free cancellation control"] },
      { signal: controller.signal },
    );

    expect(endpointMockState.calls).toHaveLength(3);
    expect(endpointMockState.calls.every((call) => call.signal === controller.signal)).toBe(true);
  });

  it("does not cache a free MCP result completed after caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("Parallel free search cancelled after response");
    pushMcpHandshake({ search_id: "cancelled-free", results: [] });
    pushMcpHandshake({ search_id: "recovered-free", results: [] });
    endpointMockState.effects.push(undefined, undefined, () => controller.abort(reason));
    const args = {
      objective: "verify Parallel cancellation cache ownership",
      search_queries: ["parallel cancellation cache"],
    };

    await expect(freeTool().execute(args, { signal: controller.signal })).rejects.toBe(reason);
    const recovered = await freeTool().execute(args);

    expect(endpointMockState.calls).toHaveLength(6);
    expect(recovered.searchId).toBe("recovered-free");
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
    const parameters = freeTool().parameters as ToolParameters;
    expect(expectDefined(parameters.properties.session_id, "session_id parameter").maxLength).toBe(
      100,
    );
    expect(parameters.properties.count).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 40,
    });
  });
  it("searches via the free MCP and brands the result, with no API key", async () => {
    vi.stubEnv("PARALLEL_API_KEY", "par-should-be-ignored"); // pragma: allowlist secret
    pushMcpHandshake({
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
    const result = await freeTool().execute({
      objective: "find examples",
      search_queries: ["example"],
    });
    expect(endpointMockState.calls).toHaveLength(3);
    const firstCall = endpointCall(0);
    expect(firstCall.url).toBe("https://search.parallel.ai/mcp");
    expect((firstCall.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(result).toMatchObject({ provider: "parallel-free" });
    expect(Array.isArray(result.results)).toBe(true);
    expect((result.results as unknown[]).length).toBe(1);
    vi.unstubAllEnvs();
  });
  it("drops an over-limit caller session id and mints one within the free MCP's 100-char cap", async () => {
    pushMcpHandshake({ search_id: "s1", results: [] });
    await freeTool().execute({
      objective: "session cap check",
      search_queries: ["session cap"],
      session_id: "x".repeat(150),
    });
    const sentSessionId = callArguments().session_id as string;
    expect(sentSessionId).not.toBe("x".repeat(150));
    expect(sentSessionId.length).toBeLessThanOrEqual(100);
  });
  it("returns a structured error when search_queries is missing", async () => {
    const result = await freeTool().execute({ objective: "x" });
    expect(result.error).toBe("invalid_search_queries");
    expect(endpointMockState.calls).toHaveLength(0);
  });
  it("rejects invalid counts before calling the free MCP", async () => {
    const tool = freeTool();
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
