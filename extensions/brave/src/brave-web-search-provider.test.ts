import fs from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/config-schema";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { __testing } from "../test-api.js";
import { createBraveWebSearchProvider as createBraveWebSearchContractProvider } from "../web-search-contract-api.js";
import { createBraveWebSearchProvider } from "./brave-web-search-provider.js";

const loggerInfoMock = vi.hoisted(() => vi.fn());

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
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.resetModules();
});

function installBraveLlmContextFetch() {
  const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
    return {
      ok: true,
      json: async () => ({
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
      }),
    } as Response;
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
  const call = mockFetch.mock.calls.at(index);
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
    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({ config: {}, searchConfig: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({ query: "OpenClaw docs" });

    expect(result).toEqual({
      error: "missing_brave_api_key",
      message:
        "web_search (brave) needs a Brave Search API key. Run `openclaw configure --section web` to store it, or set BRAVE_API_KEY in the Gateway environment. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("normalizes brave language parameters and swaps reversed ui/search inputs", () => {
    expect(
      __testing.normalizeBraveLanguageParams({
        search_lang: "en-US",
        ui_lang: "ja",
      }),
    ).toEqual({
      search_lang: "jp",
      ui_lang: "en-US",
    });
    expect(__testing.normalizeBraveLanguageParams({ search_lang: "tr-TR", ui_lang: "tr" })).toEqual(
      {
        search_lang: "tr",
        ui_lang: "tr-TR",
      },
    );
    expect(__testing.normalizeBraveLanguageParams({ search_lang: "EN", ui_lang: "en-us" })).toEqual(
      {
        search_lang: "en",
        ui_lang: "en-US",
      },
    );
  });

  it("flags invalid brave language fields", () => {
    expect(
      __testing.normalizeBraveLanguageParams({
        search_lang: "xx",
      }),
    ).toEqual({ invalidField: "search_lang" });
    expect(__testing.normalizeBraveLanguageParams({ search_lang: "en-US" })).toEqual({
      invalidField: "search_lang",
    });
    expect(__testing.normalizeBraveLanguageParams({ ui_lang: "en" })).toEqual({
      invalidField: "ui_lang",
    });
  });

  it("normalizes Brave country codes and falls back unsupported values to ALL", () => {
    expect(__testing.normalizeBraveCountry("de")).toBe("DE");
    expect(__testing.normalizeBraveCountry(" VN ")).toBe("ALL");
    expect(__testing.normalizeBraveCountry("")).toBeUndefined();
  });

  it("defaults brave mode to web unless llm-context is explicitly selected", () => {
    expect(__testing.resolveBraveMode()).toBe("web");
    expect(__testing.resolveBraveMode({ mode: "llm-context" })).toBe("llm-context");
  });

  it("accepts llm-context in the Brave plugin config schema", () => {
    if (!braveManifest.configSchema) {
      throw new Error("Expected Brave manifest config schema");
    }

    const result = validateJsonSchemaValue({
      schema: braveManifest.configSchema,
      cacheKey: "test:brave-config-schema",
      value: {
        webSearch: {
          mode: "llm-context",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts baseUrl in the Brave plugin config schema", () => {
    if (!braveManifest.configSchema) {
      throw new Error("Expected Brave manifest config schema");
    }

    const result = validateJsonSchemaValue({
      schema: braveManifest.configSchema,
      cacheKey: "test:brave-config-schema-base-url",
      value: {
        webSearch: {
          baseUrl: "https://api.search.brave.com/proxy",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("uses configured Brave baseUrl for web search requests", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      } as Response;
    });
    global.fetch = mockFetch as typeof global.fetch;

    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "brave-test-key",
        brave: {
          baseUrl: "https://api.search.brave.com/proxy/",
          mode: "web",
        },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({ query: "latest ai news" });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.origin).toBe("https://api.search.brave.com");
    expect(requestUrl.pathname).toBe("/proxy/res/v1/web/search");
  });

  it("uses configured Brave baseUrl for llm-context requests", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = installBraveLlmContextFetch();
    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "brave-test-key",
        brave: {
          baseUrl: "https://api.search.brave.com/proxy",
          mode: "llm-context",
        },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({ query: "latest ai news" });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.pathname).toBe("/proxy/res/v1/llm/context");
  });

  it("keeps Brave cache entries isolated by baseUrl", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      } as Response;
    });
    global.fetch = mockFetch as typeof global.fetch;

    const provider = createBraveWebSearchProvider();
    const firstTool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "brave-test-key",
        brave: {
          baseUrl: "https://api.search.brave.com/proxy-one",
          mode: "web",
        },
      },
    });
    const secondTool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "brave-test-key",
        brave: {
          baseUrl: "https://api.search.brave.com/proxy-two",
          mode: "web",
        },
      },
    });
    if (!firstTool || !secondTool) {
      throw new Error("Expected tool definitions");
    }

    await firstTool.execute({ query: "base url cache identity" });
    await secondTool.execute({ query: "base url cache identity" });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(fetchRequestUrl(mockFetch).pathname).toBe("/proxy-one/res/v1/web/search");
    expect(fetchRequestUrl(mockFetch, 1).pathname).toBe("/proxy-two/res/v1/web/search");
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

  it("maps llm-context results into wrapped source entries", () => {
    expect(
      __testing.mapBraveLlmContextResults({
        grounding: {
          generic: [
            {
              url: "https://example.com/post",
              title: "Example",
              snippets: ["a", "", "b"],
            },
          ],
        },
      }),
    ).toEqual([
      {
        url: "https://example.com/post",
        title: "Example",
        snippets: ["a", "b"],
        siteName: "example.com",
      },
    ]);
  });

  it("returns validation errors for invalid date ranges", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "BSA...",
        brave: { apiKey: "BSA..." },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

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
    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "BSA...",
        brave: { mode: "llm-context" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({ query: "latest ai news", freshness: "week" });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.pathname).toBe("/res/v1/llm/context");
    expect(requestUrl.searchParams.get("freshness")).toBe("pw");
  });

  it("sends Brave web auth in the X-Subscription-Token header", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      } as Response;
    });
    global.fetch = mockFetch as typeof global.fetch;

    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "brave-test-key",
        brave: { mode: "web" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({ query: "latest ai news" });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.searchParams.get("apikey")).toBeNull();
    expect(requestUrl.searchParams.get("key")).toBeNull();
    expect(readHeader(fetchRequestInit(mockFetch), "X-Subscription-Token")).toBe("brave-test-key");
  });

  it("sends Brave llm-context auth in the X-Subscription-Token header", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = installBraveLlmContextFetch();
    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "brave-test-key",
        brave: { mode: "llm-context" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({ query: "latest ai news" });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.searchParams.get("apikey")).toBeNull();
    expect(requestUrl.searchParams.get("key")).toBeNull();
    expect(readHeader(fetchRequestInit(mockFetch), "X-Subscription-Token")).toBe("brave-test-key");
  });

  it("passes bounded date ranges to Brave llm-context endpoint", async () => {
    vi.stubEnv("BRAVE_API_KEY", "test-key");
    const mockFetch = installBraveLlmContextFetch();
    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "BSA...",
        brave: { mode: "llm-context" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

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
    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "BSA...",
        brave: { mode: "llm-context" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({ query: "latest ai news", date_after: "2025-01-01" });

    const today = new Date().toISOString().slice(0, 10);
    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.pathname).toBe("/res/v1/llm/context");
    expect(requestUrl.searchParams.get("freshness")).toBe(`2025-01-01to${today}`);
  });

  it("rejects future Brave llm-context date_after-only ranges before fetch", async () => {
    vi.stubEnv("BRAVE_API_KEY", "test-key");
    const mockFetch = installBraveLlmContextFetch();
    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "BSA...",
        brave: { mode: "llm-context" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

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
    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "BSA...",
        brave: { mode: "llm-context" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

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

  it("falls back unsupported country values before calling Brave", async () => {
    vi.stubEnv("BRAVE_API_KEY", "test-key");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      } as Response;
    });
    global.fetch = mockFetch as typeof global.fetch;

    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "BSA...",
        brave: { apiKey: "BSA..." },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({
      query: "latest Vietnam news",
      country: "VN",
    });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.searchParams.get("country")).toBe("ALL");
  });

  it("emits brave.http diagnostics for requests, responses, and cache events", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          web: {
            results: [
              {
                title: "Diagnostics",
                url: "https://example.com/diagnostics",
                description: "debug details",
              },
            ],
          },
        }),
      } as Response;
    });
    global.fetch = mockFetch as typeof global.fetch;

    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: { diagnostics: { flags: ["brave.http"] } },
      searchConfig: {
        apiKey: "brave-test-key",
        brave: { mode: "web" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

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
