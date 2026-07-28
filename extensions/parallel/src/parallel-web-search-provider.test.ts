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
      throw new Error("Missing mocked Parallel response.");
    }
    return await run(response);
  };
  return {
    ...actual,
    withTrustedWebSearchEndpoint: vi.fn(runEndpoint),
  };
});

function readMockedBody(call: EndpointCall | undefined): unknown {
  if (!call || typeof call.init.body !== "string") {
    throw new Error("Expected mocked Parallel request to carry a JSON string body.");
  }
  return JSON.parse(call.init.body);
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

import { testing } from "../test-api.js";
import { createParallelWebSearchProvider as createContractParallelWebSearchProvider } from "../web-search-contract-api.js";
import { createParallelWebSearchProvider } from "./parallel-web-search-provider.js";

describe("parallel web search provider", () => {
  beforeEach(() => {
    endpointMockState.calls = [];
    endpointMockState.responses = [];
  });

  it("exposes the expected metadata and selection wiring", () => {
    const provider = createParallelWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("parallel");
    expect(provider.onboardingScopes).toEqual(["text-inference"]);
    expect(provider.credentialPath).toBe("plugins.entries.parallel.config.webSearch.apiKey");
    const pluginEntry = applied.plugins?.entries?.parallel;
    if (!pluginEntry) {
      throw new Error("expected Parallel plugin entry");
    }
    expect(pluginEntry.enabled).toBe(true);
  });

  it("advertises count as an integer from 1 to 40", () => {
    const tool = createParallelWebSearchProvider().createTool({ config: {}, searchConfig: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const countParam = (
      tool.parameters as {
        properties: Record<string, { type?: string; minimum?: number; maximum?: number }>;
      }
    ).properties.count;
    expect(countParam).toMatchObject({ type: "integer", minimum: 1, maximum: 40 });
  });

  it("keeps the lightweight contract surface aligned with provider metadata", () => {
    const provider = createParallelWebSearchProvider();
    const contractProvider = createContractParallelWebSearchProvider();
    if (!contractProvider.applySelectionConfig) {
      throw new Error("Expected contract applySelectionConfig to be defined");
    }
    const applied = contractProvider.applySelectionConfig({});

    expect({
      id: contractProvider.id,
      label: contractProvider.label,
      hint: contractProvider.hint,
      onboardingScopes: contractProvider.onboardingScopes,
      credentialLabel: contractProvider.credentialLabel,
      envVars: contractProvider.envVars,
      placeholder: contractProvider.placeholder,
      signupUrl: contractProvider.signupUrl,
      docsUrl: contractProvider.docsUrl,
      autoDetectOrder: contractProvider.autoDetectOrder,
      credentialPath: contractProvider.credentialPath,
    }).toEqual({
      id: provider.id,
      label: provider.label,
      hint: provider.hint,
      onboardingScopes: provider.onboardingScopes,
      credentialLabel: provider.credentialLabel,
      envVars: provider.envVars,
      placeholder: provider.placeholder,
      signupUrl: provider.signupUrl,
      docsUrl: provider.docsUrl,
      autoDetectOrder: provider.autoDetectOrder,
      credentialPath: provider.credentialPath,
    });
    expect(contractProvider.createTool({ config: {}, searchConfig: {} })).toBeNull();
    const pluginEntry = applied.plugins?.entries?.parallel;
    if (!pluginEntry) {
      throw new Error("expected contract Parallel plugin entry");
    }
    expect(pluginEntry.enabled).toBe(true);
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
    ).toEqual({
      endpoint: "https://proxy.example/parallel/v1/search",
    });
    expect(
      testing.resolveParallelSearchEndpoint({ baseUrl: "proxy.example/parallel/v1/search/" }),
    ).toEqual({
      endpoint: "https://proxy.example/parallel/v1/search",
    });
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
    const base = {
      objective: "Find OpenClaw on GitHub",
      searchQueries: ["openclaw github"],
      count: 5,
    };
    expect(
      testing.buildParallelCacheKey({
        ...base,
        endpoint: "https://api.parallel.ai/v1/search",
      }),
    ).not.toBe(
      testing.buildParallelCacheKey({
        ...base,
        endpoint: "https://proxy.example/parallel/v1/search",
      }),
    );
  });

  it("partitions Parallel cache keys by resolved result count", () => {
    const base = {
      endpoint: "https://api.parallel.ai/v1/search",
      objective: "Find OpenClaw on GitHub",
      searchQueries: ["openclaw github"],
    };
    expect(testing.buildParallelCacheKey({ ...base, count: 5 })).not.toBe(
      testing.buildParallelCacheKey({ ...base, count: 10 }),
    );
  });

  it("partitions Parallel cache keys by objective and by search_queries set", () => {
    const base = {
      endpoint: "https://api.parallel.ai/v1/search",
      count: 5,
    };
    expect(
      testing.buildParallelCacheKey({
        ...base,
        objective: "Find OpenClaw on GitHub",
        searchQueries: ["openclaw github"],
      }),
    ).not.toBe(
      testing.buildParallelCacheKey({
        ...base,
        objective: "Find the OpenClaw release notes",
        searchQueries: ["openclaw github"],
      }),
    );
    expect(
      testing.buildParallelCacheKey({
        ...base,
        objective: "Find OpenClaw on GitHub",
        searchQueries: ["openclaw github"],
      }),
    ).not.toBe(
      testing.buildParallelCacheKey({
        ...base,
        objective: "Find OpenClaw on GitHub",
        searchQueries: ["openclaw github", "openclaw repository"],
      }),
    );
  });

  it("partitions Parallel cache keys by caller-provided session id", () => {
    const base = {
      endpoint: "https://api.parallel.ai/v1/search",
      objective: "Find OpenClaw on GitHub",
      searchQueries: ["openclaw github"],
      count: 5,
    };
    expect(testing.buildParallelCacheKey({ ...base, sessionId: "session-a" })).not.toBe(
      testing.buildParallelCacheKey({ ...base, sessionId: "session-b" }),
    );
    expect(testing.buildParallelCacheKey({ ...base })).not.toBe(
      testing.buildParallelCacheKey({ ...base, sessionId: "session-a" }),
    );
  });

  it("partitions Parallel cache keys by client_model so per-model results never bleed", () => {
    const base = {
      endpoint: "https://api.parallel.ai/v1/search",
      objective: "Find OpenClaw on GitHub",
      searchQueries: ["openclaw github"],
      count: 5,
    };
    expect(testing.buildParallelCacheKey({ ...base, clientModel: "claude-opus-4-7" })).not.toBe(
      testing.buildParallelCacheKey({ ...base, clientModel: "gpt-5.5" }),
    );
    expect(testing.buildParallelCacheKey({ ...base })).not.toBe(
      testing.buildParallelCacheKey({ ...base, clientModel: "claude-opus-4-7" }),
    );
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
    const six = ["a", "b", "c", "d", "e", "f"];
    expect(testing.normalizeParallelSearchQueries(six)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("normalizes session ids, rejecting blanks and values past the given limit", () => {
    expect(testing.normalizeParallelSessionId("session-abc", 1000)).toBe("session-abc");
    expect(testing.normalizeParallelSessionId("  ", 1000)).toBeUndefined();
    expect(testing.normalizeParallelSessionId(undefined, 1000)).toBeUndefined();
    expect(testing.normalizeParallelSessionId("x".repeat(1001), 1000)).toBeUndefined();
    // Free Search MCP caps session_id at 100, so the tighter limit drops longer ids.
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
    // Parallel's `/v1/search` API documents `objective` as `string | null`.
    // When agent callers only supply `search_queries`, the runtime should not
    // synthesize an objective from the keyword phrase (that would misrepresent
    // intent); it should simply leave the field out of the request body.
    endpointMockState.responses.push(
      new Response(JSON.stringify({ search_id: "x", session_id: "y", results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = createParallelWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { parallel: { apiKey: "par-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const result = await tool.execute({ search_queries: ["openclaw"] });
    expect(endpointMockState.calls).toHaveLength(1);
    const body = readMockedBody(endpointMockState.calls[0]) as Record<string, unknown>;
    expect(body).not.toHaveProperty("objective");
    expect(body).toMatchObject({ search_queries: ["openclaw"] });
    expect(result).not.toHaveProperty("objective");
    expect(result).toMatchObject({ provider: "parallel" });
  });

  it("returns an error payload when search_queries is missing or empty", async () => {
    const provider = createParallelWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { parallel: { apiKey: "par-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    expect(await tool.execute({ objective: "Find OpenClaw on GitHub" })).toMatchObject({
      error: "invalid_search_queries",
    });
    expect(
      await tool.execute({ objective: "Find OpenClaw on GitHub", search_queries: [] }),
    ).toMatchObject({ error: "invalid_search_queries" });
    expect(endpointMockState.calls).toHaveLength(0);
  });

  it("promotes a generic `query` arg into search_queries when search_queries is absent (no synthesized objective)", async () => {
    // The operator CLI (`openclaw capability web.search`) always sends the
    // shared lowest-common-denominator shape `{ query, count, limit }` and
    // doesn't know about provider-specific schemas. The runtime promotes
    // `query` into the lone `search_queries` entry so that CLI keeps working
    // when Parallel is the active provider. `objective` is *not* synthesized
    // from the keyword phrase — Parallel treats it as optional natural-language
    // intent and reusing a keyword as objective would misrepresent intent.
    endpointMockState.responses.push(
      new Response(JSON.stringify({ search_id: "x", session_id: "y", results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = createParallelWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { parallel: { apiKey: "par-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const result = await tool.execute({ query: "OpenClaw GitHub", count: 3 });
    expect(endpointMockState.calls).toHaveLength(1);
    const body = readMockedBody(endpointMockState.calls[0]) as Record<string, unknown>;
    expect(body).not.toHaveProperty("objective");
    expect(body).toMatchObject({
      search_queries: ["OpenClaw GitHub"],
      advanced_settings: { max_results: 3 },
    });
    expect(result).not.toHaveProperty("objective");
    expect(result).toMatchObject({ provider: "parallel" });
  });

  it("rejects invalid counts before calling Parallel", async () => {
    const provider = createParallelWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { parallel: { apiKey: "par-secret" } },
    });
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

  it("prefers explicit objective+search_queries over the generic `query` fallback when all are present", async () => {
    endpointMockState.responses.push(
      new Response(JSON.stringify({ search_id: "x", session_id: "y", results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = createParallelWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { parallel: { apiKey: "par-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    await tool.execute({
      objective: "Native objective",
      search_queries: ["native query"],
      query: "legacy fallback",
    });
    const body = readMockedBody(endpointMockState.calls[0]) as Record<string, unknown>;
    expect(body).toMatchObject({
      objective: "Native objective",
      search_queries: ["native query"],
    });
  });

  it("honors top-level web search settings and sends the native Parallel payload shape", async () => {
    endpointMockState.responses.push(
      new Response(
        JSON.stringify({
          search_id: "search_test",
          session_id: "session_test",
          results: [{ url: "https://example.com/a", title: "A", excerpts: ["alpha"] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const provider = createParallelWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        parallel: { apiKey: "par-secret" },
        maxResults: 3,
        timeoutSeconds: 5,
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const result = await tool.execute({
      objective: "Find the OpenClaw repository on GitHub",
      search_queries: ["openclaw github", "openclaw repository"],
    });

    expect(endpointMockState.calls).toHaveLength(1);
    const call = expectDefined(endpointMockState.calls[0], "Parallel search endpoint call");
    expect(call.url).toBe("https://api.parallel.ai/v1/search");
    expect(call.timeoutSeconds).toBe(5);
    expect(readMockedBody(call)).toEqual({
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
    endpointMockState.responses.push(
      new Response(
        JSON.stringify({
          search_id: "search_test",
          session_id: "session-caller-supplied",
          results: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const provider = createParallelWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { parallel: { apiKey: "par-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const result = await tool.execute({
      objective: "Find the OpenClaw repository on GitHub",
      search_queries: ["openclaw github"],
      session_id: "session-caller-supplied",
      client_model: "claude-opus-4-7",
    });
    const body = readMockedBody(endpointMockState.calls[0]) as Record<string, unknown>;
    expect(body).toMatchObject({
      objective: "Find the OpenClaw repository on GitHub",
      search_queries: ["openclaw github"],
      session_id: "session-caller-supplied",
      client_model: "claude-opus-4-7",
    });
    expect(result).toMatchObject({ sessionId: "session-caller-supplied" });
  });

  it("always sends max_results matching the OpenClaw web_search default when no count is provided", async () => {
    endpointMockState.responses.push(
      new Response(JSON.stringify({ search_id: "x", session_id: "y", results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = createParallelWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { parallel: { apiKey: "par-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    await tool.execute({
      objective: "Find OpenClaw",
      search_queries: ["openclaw"],
    });
    expect(endpointMockState.calls).toHaveLength(1);
    const body = readMockedBody(endpointMockState.calls[0]) as {
      advanced_settings?: { max_results?: number };
    };
    // OpenClaw's web_search default is 5 results; Parallel's own default is 10.
    // Sending an explicit max_results keeps result volume consistent across providers.
    expect(body.advanced_settings?.max_results).toBe(5);
  });

  it("bounds Parallel API error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"parallel upstream unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    endpointMockState.responses.push(tracked.response);
    const provider = createParallelWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { parallel: { apiKey: "par-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const error = await tool
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

  it("bounds successful Parallel JSON bodies instead of buffering the whole response", async () => {
    // 200-chunk x 1 MiB body (~200 MiB) caps at 16 MiB: the bounded reader must
    // stop pulling chunks and cancel the stream well before draining it, then
    // surface a bounded error rather than buffering the whole payload.
    const streamed = createStreamingResponse({
      chunkCount: 200,
      chunkSize: 1024 * 1024,
      text: "a",
      headers: { "Content-Type": "application/json" },
    });
    endpointMockState.responses.push(streamed.response);
    const provider = createParallelWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { parallel: { apiKey: "par-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const error = await tool
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
    // Stopped well before draining all 200 chunks, and cancelled the stream.
    expect(streamed.getReadCount()).toBeLessThan(200);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("parses a well-formed Parallel JSON body under the byte cap", async () => {
    endpointMockState.responses.push(
      new Response(
        JSON.stringify({
          search_id: "ok",
          session_id: "ok-session",
          results: [{ url: "https://example.com/a", title: "A", excerpts: ["alpha"] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const provider = createParallelWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { parallel: { apiKey: "par-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const result = (await tool.execute({
      objective: `parallel-success-ok-${Date.now()}-${Math.random()}`,
      search_queries: ["openclaw"],
    })) as { provider?: string; searchId?: string; count?: number };
    expect(result).toMatchObject({ provider: "parallel", searchId: "ok", count: 1 });
  });

  it("does not surface a Parallel-generated sessionId on a cache hit", async () => {
    // Unique objective so this test does not collide with the SDK's
    // module-level web-search cache across other cases.
    const objective = `parallel-cache-isolation-${Date.now()}-${Math.random()}`;
    endpointMockState.responses.push(
      new Response(
        JSON.stringify({
          search_id: "first",
          session_id: "session-generated-by-parallel",
          results: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const provider = createParallelWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { parallel: { apiKey: "par-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const firstResult = (await tool.execute({
      objective,
      search_queries: ["openclaw github"],
    })) as { sessionId?: string };
    expect(firstResult.sessionId).toBe("session-generated-by-parallel");

    // Second identical call without a caller-supplied session_id must hit the
    // cache (no second HTTP call) and must NOT leak the first task's
    // auto-generated sessionId — otherwise an agent threading it back into
    // follow-up calls would group unrelated tasks on Parallel's side.
    const secondResult = (await tool.execute({
      objective,
      search_queries: ["openclaw github"],
    })) as { sessionId?: string };
    expect(endpointMockState.calls).toHaveLength(1);
    expect(secondResult.sessionId).toBeUndefined();
  });

  it("preserves caller-supplied sessionId across cache hits", async () => {
    const objective = `parallel-cache-session-${Date.now()}-${Math.random()}`;
    const sessionId = `session-${Date.now()}`;
    endpointMockState.responses.push(
      new Response(
        JSON.stringify({
          search_id: "first",
          session_id: sessionId,
          results: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const provider = createParallelWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { parallel: { apiKey: "par-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    await tool.execute({
      objective,
      search_queries: ["openclaw github"],
      session_id: sessionId,
    });
    const cached = (await tool.execute({
      objective,
      search_queries: ["openclaw github"],
      session_id: sessionId,
    })) as { sessionId?: string };
    expect(endpointMockState.calls).toHaveLength(1);
    expect(cached.sessionId).toBe(sessionId);
  });
});
