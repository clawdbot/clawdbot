import fs from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/config-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
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

    expect(result).toMatchObject({
      error: "missing_brave_api_key",
      message: expect.stringContaining("use web_fetch for a specific URL or the browser tool"),
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

    const requestUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
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

    const requestUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
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
    expect(new URL(String(mockFetch.mock.calls[0]?.[0])).pathname).toBe(
      "/proxy-one/res/v1/web/search",
    );
    expect(new URL(String(mockFetch.mock.calls[1]?.[0])).pathname).toBe(
      "/proxy-two/res/v1/web/search",
    );
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
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "webSearch.mode",
        allowedValues: ["web", "llm-context"],
      }),
    );
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

    expect(result).toMatchObject({
      error: "invalid_date_range",
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

    const requestUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
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

    const requestUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.get("apikey")).toBeNull();
    expect(requestUrl.searchParams.get("key")).toBeNull();
    expect(readHeader(mockFetch.mock.calls[0]?.[1], "X-Subscription-Token")).toBe("brave-test-key");
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

    const requestUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.get("apikey")).toBeNull();
    expect(requestUrl.searchParams.get("key")).toBeNull();
    expect(readHeader(mockFetch.mock.calls[0]?.[1], "X-Subscription-Token")).toBe("brave-test-key");
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

    const requestUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
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
    const requestUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
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

    expect(result).toMatchObject({
      error: "invalid_date_range",
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

    expect(result).toMatchObject({
      error: "unsupported_date_filter",
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

    const requestUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
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
    expect(messages).toEqual(
      expect.arrayContaining([
        "brave http cache miss",
        "brave http request",
        "brave http response",
        "brave http cache write",
        "brave http cache hit",
      ]),
    );
    expect(loggerInfoMock.mock.calls).toEqual(
      expect.arrayContaining([
        [
          "brave http request",
          expect.objectContaining({
            mode: "web",
            query: "unique brave diagnostics query",
            params: expect.objectContaining({ q: "unique brave diagnostics query", count: "1" }),
            url: expect.stringContaining("api.search.brave.com/res/v1/web/search"),
          }),
        ],
        [
          "brave http response",
          expect.objectContaining({
            mode: "web",
            status: 200,
            ok: true,
            durationMs: expect.any(Number),
          }),
        ],
      ]),
    );
    expect(JSON.stringify(loggerInfoMock.mock.calls)).not.toContain("brave-test-key");
    expect(JSON.stringify(loggerInfoMock.mock.calls)).not.toContain("X-Subscription-Token");
  });
});
