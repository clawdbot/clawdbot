import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TAVILY_BASE_URL,
  DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS,
  DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS,
  resolveTavilyApiKey,
  resolveTavilyBaseUrl,
  resolveTavilyExtractTimeoutSeconds,
  resolveTavilySearchConfig,
  resolveTavilySearchTimeoutSeconds,
} from "./config.js";

const { runTavilySearch, runTavilyExtract } = vi.hoisted(() => ({
  runTavilySearch: vi.fn(async (params: Record<string, unknown>) => params),
  runTavilyExtract: vi.fn(async (params: unknown) => ({ ok: true, params })),
}));

vi.mock("./tavily-client.js", () => ({
  runTavilySearch,
  runTavilyExtract,
}));

function fakeApi(): OpenClawPluginApi {
  return {
    config: {},
  } as OpenClawPluginApi;
}

describe("tavily tools", () => {
  let createTavilyWebSearchProvider: typeof import("./tavily-search-provider.js").createTavilyWebSearchProvider;
  let createTavilySearchTool: typeof import("./tavily-search-tool.js").createTavilySearchTool;
  let createTavilyExtractTool: typeof import("./tavily-extract-tool.js").createTavilyExtractTool;
  let tavilyClientTesting: typeof import("./tavily-client.js").__testing;

  beforeAll(async () => {
    ({ createTavilyWebSearchProvider } = await import("./tavily-search-provider.js"));
    ({ createTavilySearchTool } = await import("./tavily-search-tool.js"));
    ({ createTavilyExtractTool } = await import("./tavily-extract-tool.js"));
    ({ __testing: tavilyClientTesting } =
      await vi.importActual<typeof import("./tavily-client.js")>("./tavily-client.js"));
  });

  beforeEach(() => {
    runTavilySearch.mockReset();
    runTavilySearch.mockImplementation(async (params: Record<string, unknown>) => params);
    runTavilyExtract.mockReset();
    runTavilyExtract.mockImplementation(async (params: unknown) => ({ ok: true, params }));
    vi.unstubAllEnvs();
  });

  it("exposes the expected metadata and selection wiring", () => {
    const provider = createTavilyWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("tavily");
    expect(provider.credentialPath).toBe("plugins.entries.tavily.config.webSearch.apiKey");
    expect(applied.plugins?.entries?.tavily?.enabled).toBe(true);
  });

  it("maps generic provider args into Tavily search params", async () => {
    const provider = createTavilyWebSearchProvider();
    const tool = provider.createTool({
      config: { test: true },
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "weather sf",
      count: 7,
    });

    expect(runTavilySearch).toHaveBeenCalledWith({
      cfg: { test: true },
      query: "weather sf",
      maxResults: 7,
    });
    expect(result).toEqual({
      cfg: { test: true },
      query: "weather sf",
      maxResults: 7,
    });
  });

  it("normalizes optional parameters before invoking Tavily", async () => {
    runTavilySearch.mockImplementationOnce(async (params: Record<string, unknown>) => ({
      ok: true,
      params,
    }));
    const tool = createTavilySearchTool({
      config: { env: "test" },
    } as never);

    const result = await tool.execute("call-1", {
      query: "best docs",
      search_depth: "advanced",
      topic: "news",
      max_results: 5,
      include_answer: true,
      time_range: "week",
      include_domains: ["docs.openclaw.ai", "", "openclaw.ai"],
      exclude_domains: ["bad.example", ""],
    });

    expect(runTavilySearch).toHaveBeenCalledWith({
      cfg: { env: "test" },
      query: "best docs",
      searchDepth: "advanced",
      topic: "news",
      maxResults: 5,
      includeAnswer: true,
      timeRange: "week",
      includeDomains: ["docs.openclaw.ai", "openclaw.ai"],
      excludeDomains: ["bad.example"],
    });
    expect(result).toMatchObject({
      details: {
        ok: true,
        params: {
          cfg: { env: "test" },
          query: "best docs",
          searchDepth: "advanced",
          topic: "news",
          maxResults: 5,
          includeAnswer: true,
          timeRange: "week",
          includeDomains: ["docs.openclaw.ai", "openclaw.ai"],
          excludeDomains: ["bad.example"],
        },
      },
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
    });
  });

  it("drops empty domain arrays and forwards query-scoped chunking", async () => {
    runTavilySearch.mockImplementationOnce(async (params: Record<string, unknown>) => ({
      ok: true,
      params,
    }));
    const searchTool = createTavilySearchTool({
      config: { env: "test" },
    } as never);

    await expect(
      searchTool.execute("call-2", {
        query: "simple",
        include_domains: [""],
        exclude_domains: [],
      }),
    ).resolves.toMatchObject({
      details: {
        ok: true,
        params: {
          cfg: { env: "test" },
          query: "simple",
          includeAnswer: false,
        },
      },
    });

    const extractTool = createTavilyExtractTool(fakeApi());
    await extractTool.execute("id", {
      urls: ["https://example.com"],
      query: "pricing",
      chunks_per_source: 2,
    });

    expect(runTavilyExtract).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        urls: ["https://example.com"],
        query: "pricing",
        chunksPerSource: 2,
      }),
    );
  });

  it("rejects chunks_per_source without query", async () => {
    const tool = createTavilyExtractTool(fakeApi());

    await expect(
      tool.execute("id", {
        urls: ["https://example.com"],
        chunks_per_source: 2,
      }),
    ).rejects.toThrow("tavily_extract requires query when chunks_per_source is set.");

    expect(runTavilyExtract).not.toHaveBeenCalled();
  });

  it("reads plugin web search config and prefers it over env defaults", () => {
    vi.stubEnv("TAVILY_API_KEY", "env-key");
    vi.stubEnv("TAVILY_BASE_URL", "https://env.tavily.test");

    const cfg = {
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                apiKey: "plugin-key",
                baseUrl: "https://plugin.tavily.test",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveTavilySearchConfig(cfg)).toEqual({
      apiKey: "plugin-key",
      baseUrl: "https://plugin.tavily.test",
    });
    expect(resolveTavilyApiKey(cfg)).toBe("plugin-key");
    expect(resolveTavilyBaseUrl(cfg)).toBe("https://plugin.tavily.test");
  });

  it("falls back to environment values and defaults", () => {
    vi.stubEnv("TAVILY_API_KEY", "env-key");
    vi.stubEnv("TAVILY_BASE_URL", "https://env.tavily.test");

    expect(resolveTavilyApiKey()).toBe("env-key");
    expect(resolveTavilyBaseUrl()).toBe("https://env.tavily.test");
    expect(resolveTavilyBaseUrl({} as OpenClawConfig)).not.toBe(DEFAULT_TAVILY_BASE_URL);
    expect(resolveTavilySearchTimeoutSeconds()).toBe(DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS);
    expect(resolveTavilyExtractTimeoutSeconds()).toBe(DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS);
  });

  it("accepts positive numeric timeout overrides and floors them", () => {
    expect(resolveTavilySearchTimeoutSeconds(19.9)).toBe(19);
    expect(resolveTavilyExtractTimeoutSeconds(42.7)).toBe(42);
    expect(resolveTavilySearchTimeoutSeconds(0)).toBe(DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS);
    expect(resolveTavilyExtractTimeoutSeconds(Number.NaN)).toBe(
      DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS,
    );
  });

  it("appends endpoints to reverse-proxy base urls", () => {
    expect(tavilyClientTesting.resolveEndpoint("https://proxy.example/api/tavily", "/search")).toBe(
      "https://proxy.example/api/tavily/search",
    );
    expect(
      tavilyClientTesting.resolveEndpoint("https://proxy.example/api/tavily/", "/extract"),
    ).toBe("https://proxy.example/api/tavily/extract");
  });

  it("falls back to the default host for invalid base urls", () => {
    expect(tavilyClientTesting.resolveEndpoint("not a url", "/search")).toBe(
      "https://api.tavily.com/search",
    );
    expect(tavilyClientTesting.resolveEndpoint("", "/extract")).toBe(
      "https://api.tavily.com/extract",
    );
  });
});
