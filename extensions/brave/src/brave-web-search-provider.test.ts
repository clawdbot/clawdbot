import fs from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createBraveWebSearchProvider as createBraveWebSearchContractProvider } from "../web-search-contract-api.js";
import { createBraveWebSearchProvider } from "./brave-web-search-provider.js";

const loggerInfoMock = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({
    info: loggerInfoMock,
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    raw: vi.fn(),
    isEnabled: () => true,
    child: () => ({
      info: loggerInfoMock,
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      raw: vi.fn(),
      isEnabled: () => true,
      child: vi.fn(),
    }),
  }),
}));

const braveManifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
) as {
  configSchema?: Record<string, unknown>;
};

afterAll(() => {
  vi.doUnmock("node:dns/promises");
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.resetModules();
});

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function malformedJsonResponse(): Response {
  return new Response("{ nope", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function emptyWebSearchResponse(): Response {
  return jsonResponse({ web: { results: [] } });
}

function installBraveLlmContextFetch() {
  const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
    return jsonResponse({
      grounding: {
        generic: [
          {
            url: "https://example.com/context",
            title: "Context",
            snippets: ["snippet"],
          },
        ],
      },
      sources: [],
    });
  });
  global.fetch = mockFetch as typeof global.fetch;
  return mockFetch;
}

function readHeader(init: unknown, name: string): string | null {
  const headers = (init as { headers?: HeadersInit } | undefined)?.headers;
  if (!headers) {
    return null;
  }
  return new Headers(headers).get(name);
}

function fetchCall(mockFetch: { mock: { calls: Array<Array<unknown>> } }, index = 0) {
  const call = mockFetch.mock.calls[index];
  if (!call) {
    throw new Error(`Expected fetch call ${index + 1}`);
  }
  return call;
}

function fetchRequestUrl(mockFetch: { mock: { calls: Array<Array<unknown>> } }, index = 0) {
  return new URL(String(fetchCall(mockFetch, index)[0]));
}

function fetchRequestInit(mockFetch: { mock: { calls: Array<Array<unknown>> } }, index = 0) {
  return fetchCall(mockFetch, index)[1];
}

function createBodyOnlyErrorResponse(params: { body: string; status: number }): Response {
  const bytes = new TextEncoder().encode(params.body);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    ok: false,
    status: params.status,
    statusText: "Too Many Requests",
    headers: new Headers(),
    body,
  } as Response;
}

function createBraveTool(
  params: {
    webSearch?: Record<string, unknown>;
    searchConfig?: Record<string, unknown>;
    config?: Record<string, unknown>;
  } = {},
) {
  const tool = createBraveWebSearchProvider().createTool({
    config: {
      ...params.config,
      plugins: {
        entries: {
          brave: {
            config: {
              webSearch: params.webSearch ?? {},
            },
          },
        },
      },
    },
    searchConfig: params.searchConfig ?? {},
  } as never);
  if (!tool) {
    throw new Error("Expected tool definition");
  }
  return tool;
}

describe("brave web search provider", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    loggerInfoMock.mockClear();
    global.fetch = priorFetch;
  });

  it("points provider metadata at the canonical Brave docs page", () => {
    expect(createBraveWebSearchProvider().docsUrl).toBe(
      "https://docs.openclaw.ai/tools/brave-search",
    );
    expect(createBraveWebSearchContractProvider().docsUrl).toBe(
      "https://docs.openclaw.ai/tools/brave-search",
    );
  });

  it("points missing-key users to fetch/browser alternatives", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const tool = createBraveTool();

    const result = await tool.execute({ query: "OpenClaw docs" });

    expect(result).toEqual({
      error: "missing_brave_api_key",
      message:
        "web_search (brave) needs a Brave Search API key. Run `openclaw configure --section web` to store it, or set BRAVE_API_KEY in the Gateway environment. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it.each(["web", "llm-context"] as const)(
    "does not start an already canceled %s search",
    async (mode) => {
      const fetchMock = vi.fn(async () => emptyWebSearchResponse());
      global.fetch = fetchMock as typeof global.fetch;
      const tool = createBraveTool({ webSearch: { apiKey: "brave-test-key", mode } });
      const controller = new AbortController();
      controller.abort(new Error("Brave caller canceled"));

      await expect(
        tool.execute({ query: `brave pre-canceled ${mode}` }, { signal: controller.signal }),
      ).rejects.toThrow("Brave caller canceled");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["web", "llm-context"] as const)(
    "aborts an in-flight %s request with the caller's reason",
    async (mode) => {
      const controller = new AbortController();
      const fetchMock = vi.fn(
        async (_url: string, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("Brave request lost caller cancellation"));
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
            // First-use DNS/runtime preparation can outlast a polling deadline.
            // Abort at transport entry so no unfinished request leaks into the next case.
            controller.abort(new Error("Brave request canceled in flight"));
          }),
      );
      global.fetch = fetchMock as typeof global.fetch;
      const tool = createBraveTool({ webSearch: { apiKey: "brave-test-key", mode } });
      const result = tool.execute(
        { query: `brave in-flight cancellation ${mode}` },
        { signal: controller.signal },
      );

      await expect(result).rejects.toThrow("Brave request canceled in flight");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    },
  );

  it.each(["web", "llm-context"] as const)(
    "does not cache a %s response completed after caller cancellation",
    async (mode) => {
      const controller = new AbortController();
      const reason = new Error(`Brave ${mode} canceled after response`);
      const payload =
        mode === "web" ? { web: { results: [] } } : { grounding: { generic: [] }, sources: [] };
      let firstRequest = true;
      const fetchMock = vi.fn(async () => {
        if (!firstRequest) {
          return jsonResponse(payload);
        }
        firstRequest = false;
        let emitted = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(stream) {
              if (!emitted) {
                emitted = true;
                stream.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
                return;
              }
              stream.close();
              controller.abort(reason);
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      });
      global.fetch = fetchMock as typeof global.fetch;
      const tool = createBraveTool({ webSearch: { apiKey: "brave-test-key", mode } });
      const args = { query: `brave post-response cancellation ${mode}` };

      await expect(tool.execute(args, { signal: controller.signal })).rejects.toBe(reason);
      await tool.execute(args);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    [
      { search_lang: "en-US", ui_lang: "ja" },
      { search_lang: "jp", ui_lang: "en-US" },
    ],
    [
      { search_lang: "tr-TR", ui_lang: "tr" },
      { search_lang: "tr", ui_lang: "tr-TR" },
    ],
    [
      { search_lang: "EN", ui_lang: "en-us" },
      { search_lang: "en", ui_lang: "en-US" },
    ],
    [{ search_lang: "xx" }, { error: "invalid_search_lang" }],
    [{ search_lang: "en-US" }, { error: "invalid_search_lang" }],
    [{ ui_lang: "en" }, { error: "invalid_ui_lang" }],
  ])("normalizes language parameters through the public tool: %#", async (args, expected) => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = vi.fn(async () => emptyWebSearchResponse());
    global.fetch = mockFetch as typeof global.fetch;
    const result = await createBraveTool({ webSearch: { apiKey: "brave-test-key" } }).execute({
      query: "localized search",
      ...args,
    });
    if ("error" in expected) {
      expect(result).toMatchObject(expected);
      expect(mockFetch).not.toHaveBeenCalled();
      return;
    }
    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.searchParams.get("search_lang")).toBe(expected.search_lang);
    expect(requestUrl.searchParams.get("ui_lang")).toBe(expected.ui_lang);
  });

  it.each([{ baseUrl: "https://api.search.brave.com/proxy" }, { mode: "llm-context" }])(
    "accepts supported Brave plugin config fields: %#",
    (webSearch) => {
      if (!braveManifest.configSchema) {
        throw new Error("Expected Brave manifest config schema");
      }
      const result = validateJsonSchemaValue({
        schema: braveManifest.configSchema,
        cacheKey: "test:brave-config-schema-base-url",
        value: { webSearch },
      });
      expect(result.ok).toBe(true);
    },
  );

  it("uses configured Brave baseUrl for web search requests", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return emptyWebSearchResponse();
    });
    global.fetch = mockFetch as typeof global.fetch;

    const tool = createBraveTool({
      webSearch: {
        apiKey: "brave-test-key",
        baseUrl: "https://api.search.brave.com/proxy/",
        mode: "web",
      },
    });

    await tool.execute({ query: "latest ai news" });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.origin).toBe("https://api.search.brave.com");
    expect(requestUrl.pathname).toBe("/proxy/res/v1/web/search");
  });

  it("uses configured Brave baseUrl for llm-context requests", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = installBraveLlmContextFetch();
    const tool = createBraveTool({
      webSearch: {
        apiKey: "brave-test-key",
        baseUrl: "https://api.search.brave.com/proxy",
        mode: "llm-context",
      },
    });

    await tool.execute({ query: "latest ai news" });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.pathname).toBe("/proxy/res/v1/llm/context");
  });

  it("reports malformed Brave web search JSON as a provider error", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return malformedJsonResponse();
    });
    global.fetch = mockFetch as typeof global.fetch;

    const tool = createBraveTool({ webSearch: { apiKey: "brave-test-key", mode: "web" } });

    await expect(tool.execute({ query: "latest ai news" })).rejects.toThrow(
      "Brave Search API error: malformed JSON response",
    );
  });

  it("reports malformed Brave llm-context JSON as a provider error", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return malformedJsonResponse();
    });
    global.fetch = mockFetch as typeof global.fetch;

    const tool = createBraveTool({
      webSearch: { apiKey: "brave-test-key", mode: "llm-context" },
    });

    await expect(tool.execute({ query: "latest ai news" })).rejects.toThrow(
      "Brave LLM Context API error: malformed JSON response",
    );
  });

  it("bounds Brave web error bodies without using response.text", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) =>
      createBodyOnlyErrorResponse({
        status: 429,
        body: `${"x".repeat(24 * 1024)}tail-marker`,
      }),
    );
    global.fetch = mockFetch as typeof global.fetch;

    const tool = createBraveTool({ webSearch: { apiKey: "brave-test-key", mode: "web" } });

    const error = await tool.execute({ query: "latest ai news" }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("Brave Search API error (429):");
    expect(message).not.toContain("tail-marker");
    expect(message.length).toBeLessThan(700);
  });

  it("bounds Brave llm-context error bodies without using response.text", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) =>
      createBodyOnlyErrorResponse({
        status: 429,
        body: `${"x".repeat(24 * 1024)}tail-marker`,
      }),
    );
    global.fetch = mockFetch as typeof global.fetch;

    const tool = createBraveTool({
      webSearch: { apiKey: "brave-test-key", mode: "llm-context" },
    });

    const error = await tool.execute({ query: "latest ai news" }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("Brave LLM Context API error (429):");
    expect(message).not.toContain("tail-marker");
    expect(message.length).toBeLessThan(700);
  });

  it("keeps Brave cache entries isolated by baseUrl", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return emptyWebSearchResponse();
    });
    global.fetch = mockFetch as typeof global.fetch;

    const firstTool = createBraveTool({
      webSearch: {
        apiKey: "brave-test-key",
        baseUrl: "https://api.search.brave.com/proxy-one",
        mode: "web",
      },
    });
    const secondTool = createBraveTool({
      webSearch: {
        apiKey: "brave-test-key",
        baseUrl: "https://api.search.brave.com/proxy-two",
        mode: "web",
      },
    });

    await firstTool.execute({ query: "base url cache identity" });
    await secondTool.execute({ query: "base url cache identity" });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(fetchRequestUrl(mockFetch).pathname).toBe("/proxy-one/res/v1/web/search");
    expect(fetchRequestUrl(mockFetch, 1).pathname).toBe("/proxy-two/res/v1/web/search");
  });

  it.each([
    { mode: "web", cacheTtlMinutes: 0 },
    { mode: "web", cacheTtlMinutes: 1 },
    { mode: "llm-context", cacheTtlMinutes: 0 },
    { mode: "llm-context", cacheTtlMinutes: 1 },
  ])("honors current $mode cache TTL $cacheTtlMinutes", async ({ mode, cacheTtlMinutes }) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let requestCount = 0;
    const mockFetch = vi.fn(async () => {
      const result = { url: `https://example.com/result-${++requestCount}` };
      return jsonResponse(
        mode === "web" ? { web: { results: [result] } } : { grounding: { generic: [result] } },
      );
    });
    global.fetch = mockFetch as typeof global.fetch;
    const cachedTool = createBraveTool({
      webSearch: { apiKey: "brave-test-key", mode },
      searchConfig: { cacheTtlMinutes: 15 },
    });
    const currentTool = createBraveTool({
      webSearch: { apiKey: "brave-test-key", mode },
      searchConfig: { cacheTtlMinutes },
    });
    const args = { query: `brave cache TTL ${mode} ${cacheTtlMinutes}` };

    try {
      const original = await cachedTool.execute(args);
      expect(original).toMatchObject({ results: [{ url: "https://example.com/result-1" }] });
      expect(await cachedTool.execute(args)).toEqual({ ...original, cached: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(now + 60_000);
      const fresh = await currentTool.execute(args);
      expect(fresh).toMatchObject({ results: [{ url: "https://example.com/result-2" }] });
      expect(fresh).not.toHaveProperty("cached");
      expect(mockFetch).toHaveBeenCalledTimes(2);

      if (cacheTtlMinutes === 0) {
        expect(await currentTool.execute(args)).toMatchObject({
          results: [{ url: "https://example.com/result-3" }],
        });
        expect(await cachedTool.execute(args)).toEqual({ ...original, cached: true });
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } else {
        expect(await currentTool.execute(args)).toEqual({ ...fresh, cached: true });
        expect(mockFetch).toHaveBeenCalledTimes(2);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects invalid Brave mode values in the plugin config schema", () => {
    if (!braveManifest.configSchema) {
      throw new Error("Expected Brave manifest config schema");
    }

    const result = validateJsonSchemaValue({
      schema: braveManifest.configSchema,
      cacheKey: "test:brave-config-schema",
      value: {
        webSearch: {
          mode: "invalid-mode",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toEqual([
      {
        path: "webSearch.mode",
        message: 'must be equal to one of the allowed values (allowed: "web", "llm-context")',
        text: 'webSearch.mode: must be equal to one of the allowed values (allowed: "web", "llm-context")',
        allowedValues: ["web", "llm-context"],
        allowedValuesHiddenCount: 0,
      },
    ]);
  });

  it("returns validation errors for invalid date ranges", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const tool = createBraveTool({ webSearch: { apiKey: "BSA..." } });

    const result = await tool.execute({
      query: "latest gpu news",
      date_after: "2026-03-20",
      date_before: "2026-03-01",
    });

    expect(result).toEqual({
      error: "invalid_date_range",
      message: "date_after must be before date_before.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("passes freshness to Brave llm-context endpoint", async () => {
    vi.stubEnv("BRAVE_API_KEY", "test-key");
    const mockFetch = installBraveLlmContextFetch();
    const tool = createBraveTool({
      webSearch: { apiKey: "BSA...", mode: "llm-context" },
    });

    await tool.execute({ query: "latest ai news", freshness: "week" });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.pathname).toBe("/res/v1/llm/context");
    expect(requestUrl.searchParams.get("freshness")).toBe("pw");
  });

  it("sends Brave web auth in the X-Subscription-Token header", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return emptyWebSearchResponse();
    });
    global.fetch = mockFetch as typeof global.fetch;

    const tool = createBraveTool({ webSearch: { apiKey: "brave-test-key", mode: "web" } });

    await tool.execute({ query: "latest ai news" });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.searchParams.get("apikey")).toBeNull();
    expect(requestUrl.searchParams.get("key")).toBeNull();
    expect(readHeader(fetchRequestInit(mockFetch), "X-Subscription-Token")).toBe("brave-test-key");
  });

  it("preserves Brave publication timestamps without promoting relative age or crawl time", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({
        web: {
          results: [
            {
              title: "Dated",
              url: "https://example.com/dated",
              age: "2 days ago",
              page_age: "2025-04-12T14:22:41",
            },
            {
              title: "Undated",
              url: "https://example.com/undated",
              age: "2 days ago",
              page_fetched: "2025-04-14T14:22:41",
            },
          ],
        },
      }),
    ) as typeof global.fetch;
    const tool = createBraveTool({ webSearch: { apiKey: "brave-test-key" } });

    const result = await tool.execute({ query: "publication metadata" });

    expect((result.results as Array<Record<string, unknown>>).map((row) => row.published)).toEqual([
      "2025-04-12T14:22:41",
      undefined,
    ]);
  });

  it("joins LLM-context publication dates by source URL, preserving unknown dates", async () => {
    const urls = [
      "https://example.com/timestamp",
      "https://example.com/day",
      "https://example.com/unknown",
    ] as const;
    global.fetch = vi.fn(async () =>
      jsonResponse({
        grounding: {
          generic: urls.map((url) => ({ url, title: "Source", snippets: ["text", ""] })),
        },
        sources: {
          [urls[1]]: { age: ["Monday, January 15, 2024", "2024-01-15", "380 days ago"] },
          [urls[0]]: {
            age: ["Monday, January 15, 2024", "2024-01-15", "380 days ago", "2024-01-15T13:45:02Z"],
          },
          [urls[2]]: { age: [] },
        },
      }),
    ) as typeof global.fetch;
    const tool = createBraveTool({ webSearch: { apiKey: "brave-test-key", mode: "llm-context" } });

    const result = await tool.execute({ query: "context publication metadata" });

    expect((result.results as Array<Record<string, unknown>>).map((row) => row.published)).toEqual([
      "2024-01-15T13:45:02Z",
      "2024-01-15",
      undefined,
    ]);
    expect((result.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      snippets: [expect.stringContaining("text")],
      siteName: "example.com",
      title: expect.stringContaining("Source"),
    });
  });

  it("sends Brave llm-context auth in the X-Subscription-Token header", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = installBraveLlmContextFetch();
    const tool = createBraveTool({
      webSearch: { apiKey: "brave-test-key", mode: "llm-context" },
    });

    await tool.execute({ query: "latest ai news" });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.searchParams.get("apikey")).toBeNull();
    expect(requestUrl.searchParams.get("key")).toBeNull();
    expect(readHeader(fetchRequestInit(mockFetch), "X-Subscription-Token")).toBe("brave-test-key");
  });

  it("passes bounded date ranges to Brave llm-context endpoint", async () => {
    vi.stubEnv("BRAVE_API_KEY", "test-key");
    const mockFetch = installBraveLlmContextFetch();
    const tool = createBraveTool({
      webSearch: { apiKey: "BSA...", mode: "llm-context" },
    });

    await tool.execute({
      query: "latest ai news",
      date_after: "2025-01-01",
      date_before: "2025-01-31",
    });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.pathname).toBe("/res/v1/llm/context");
    expect(requestUrl.searchParams.get("freshness")).toBe("2025-01-01to2025-01-31");
  });

  it("uses today as the end date for Brave llm-context date_after-only ranges", async () => {
    vi.stubEnv("BRAVE_API_KEY", "test-key");
    const mockFetch = installBraveLlmContextFetch();
    const tool = createBraveTool({
      webSearch: { apiKey: "BSA...", mode: "llm-context" },
    });

    await tool.execute({ query: "latest ai news", date_after: "2025-01-01" });

    const today = new Date().toISOString().slice(0, 10);
    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.pathname).toBe("/res/v1/llm/context");
    expect(requestUrl.searchParams.get("freshness")).toBe(`2025-01-01to${today}`);
  });

  it("rejects future Brave llm-context date_after-only ranges before fetch", async () => {
    vi.stubEnv("BRAVE_API_KEY", "test-key");
    const mockFetch = installBraveLlmContextFetch();
    const tool = createBraveTool({
      webSearch: { apiKey: "BSA...", mode: "llm-context" },
    });

    const result = await tool.execute({
      query: "latest ai news",
      date_after: "2999-01-01",
    });

    expect(result).toEqual({
      error: "invalid_date_range",
      message: "date_after cannot be in the future for Brave llm-context mode.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects Brave llm-context date_before-only ranges before fetch", async () => {
    vi.stubEnv("BRAVE_API_KEY", "test-key");
    const mockFetch = installBraveLlmContextFetch();
    const tool = createBraveTool({
      webSearch: { apiKey: "BSA...", mode: "llm-context" },
    });

    const result = await tool.execute({
      query: "latest ai news",
      date_before: "2025-01-31",
    });

    expect(result).toEqual({
      error: "unsupported_date_filter",
      message:
        "Brave llm-context mode requires date_after when date_before is set. Use a bounded date range or freshness.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["de", "DE"],
    [" VN ", "ALL"],
    ["", null],
  ])("normalizes country %j through the public tool", async (country, expected) => {
    vi.stubEnv("BRAVE_API_KEY", "test-key");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return emptyWebSearchResponse();
    });
    global.fetch = mockFetch as typeof global.fetch;

    const tool = createBraveTool({ webSearch: { apiKey: "BSA..." } });

    await tool.execute({ query: "localized news", country });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.searchParams.get("country")).toBe(expected);
  });

  it("emits brave.http diagnostics for requests, responses, and cache events", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return jsonResponse({
        web: {
          results: [
            {
              title: "Diagnostics",
              url: "https://example.com/diagnostics",
              description: "debug details",
            },
          ],
        },
      });
    });
    global.fetch = mockFetch as typeof global.fetch;

    const tool = createBraveTool({
      config: { diagnostics: { flags: ["brave.http"] } },
      webSearch: { apiKey: "brave-test-key", mode: "web" },
    });

    await tool.execute({ query: "unique brave diagnostics query", count: 1 });
    await tool.execute({ query: "unique brave diagnostics query", count: 1 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const messages = loggerInfoMock.mock.calls.map((call) => call[0]);
    expect(messages).toEqual([
      "brave http cache miss",
      "brave http request",
      "brave http response",
      "brave http cache write",
      "brave http cache hit",
    ]);
    const requestLog = loggerInfoMock.mock.calls.find(
      ([message]) => message === "brave http request",
    );
    expect(requestLog?.[1]).toEqual({
      mode: "web",
      query: "unique brave diagnostics query",
      params: {
        count: "1",
        q: "unique brave diagnostics query",
      },
      url: "https://api.search.brave.com/res/v1/web/search?q=unique+brave+diagnostics+query&count=1",
    });
    const responseLog = loggerInfoMock.mock.calls.find(
      ([message]) => message === "brave http response",
    );
    const responsePayload = responseLog?.[1] as
      | { durationMs?: unknown; mode?: unknown; ok?: unknown; status?: unknown }
      | undefined;
    expect(responsePayload?.mode).toBe("web");
    expect(responsePayload?.status).toBe(200);
    expect(responsePayload?.ok).toBe(true);
    expect(typeof responsePayload?.durationMs).toBe("number");
    expect(responsePayload?.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(loggerInfoMock.mock.calls)).not.toContain("brave-test-key");
    expect(JSON.stringify(loggerInfoMock.mock.calls)).not.toContain("X-Subscription-Token");
  });
});
