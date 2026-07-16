import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveSearxngBaseUrl,
  resolveSearxngCategories,
  resolveSearxngLanguage,
} from "./config.js";

const { runSearxngSearch } = vi.hoisted(() => ({
  runSearxngSearch: vi.fn(async (params: Record<string, unknown>) => params),
}));

vi.mock("./searxng-client.js", () => ({
  runSearxngSearch,
}));

describe("searxng web search provider", () => {
  let createSearxngWebSearchProvider: typeof import("./searxng-search-provider.js").createSearxngWebSearchProvider;
  let plugin: typeof import("../index.js").default;

  beforeAll(async () => {
    ({ createSearxngWebSearchProvider } = await import("./searxng-search-provider.js"));
    ({ default: plugin } = await import("../index.js"));
  });

  beforeEach(() => {
    runSearxngSearch.mockReset();
    runSearxngSearch.mockImplementation(async (params: Record<string, unknown>) => params);
  });

  it("registers a setup-visible web search provider", () => {
    const webSearchProviders: unknown[] = [];

    plugin.register({
      registerWebSearchProvider(provider: unknown) {
        webSearchProviders.push(provider);
      },
    } as never);

    expect(plugin.id).toBe("searxng");
    expect(webSearchProviders).toHaveLength(1);

    const provider = webSearchProviders[0] as Record<string, unknown>;
    expect(provider.id).toBe("searxng");
    expect(provider.requiresCredential).toBe(true);
    expect(provider.envVars).toEqual(["SEARXNG_BASE_URL"]);
    expect(provider.onboardingScopes).toEqual(["text-inference"]);
  });

  it("exposes credential metadata and enables the plugin in config", () => {
    const provider = createSearxngWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("searxng");
    expect(provider.label).toBe("SearXNG Search");
    expect(provider.requiresCredential).toBe(true);
    expect(provider.credentialPath).toBe("plugins.entries.searxng.config.webSearch.baseUrl");
    expect(applied.plugins?.entries?.searxng?.enabled).toBe(true);
  });

  it("maps generic tool arguments into SearXNG search params", async () => {
    const provider = createSearxngWebSearchProvider();
    const tool = provider.createTool({
      config: { test: true },
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "openclaw docs",
      count: 4,
      categories: "general,news",
      language: "en",
    });

    expect(runSearxngSearch).toHaveBeenCalledWith({
      config: { test: true },
      query: "openclaw docs",
      count: 4,
      categories: "general,news",
      language: "en",
    });
    expect(result).toEqual({
      config: { test: true },
      query: "openclaw docs",
      count: 4,
      categories: "general,news",
      language: "en",
    });
  });

  it("reads base URL from plugin config SecretRef, then env var, stripping trailing slashes", () => {
    expect(
      resolveSearxngBaseUrl(
        {
          plugins: {
            entries: {
              searxng: {
                config: {
                  webSearch: {
                    baseUrl: {
                      source: "env",
                      provider: "default",
                      id: "SEARXNG_BASE_URL",
                    },
                  },
                },
              },
            },
          },
        } as never,
        { SEARXNG_BASE_URL: "http://localhost:8888/" },
      ),
    ).toBe("http://localhost:8888");

    expect(
      resolveSearxngBaseUrl({} as never, {
        SEARXNG_BASE_URL: "https://search.local/searxng///",
      }),
    ).toBe("https://search.local/searxng");

    expect(resolveSearxngBaseUrl({} as never, {})).toBeUndefined();
  });

  it("reads categories and language from plugin config", () => {
    const config = {
      plugins: {
        entries: {
          searxng: {
            config: {
              webSearch: {
                categories: "general,news",
                language: "de",
              },
            },
          },
        },
      },
    } as never;

    expect(resolveSearxngCategories(config)).toBe("general,news");
    expect(resolveSearxngLanguage(config)).toBe("de");
  });

  it("persists base URL to plugin config via setConfiguredCredentialValue", () => {
    const provider = createSearxngWebSearchProvider();
    const config = {} as Record<string, unknown>;

    provider.setConfiguredCredentialValue!(config, "http://search.local:9000");

    expect(
      (
        config as {
          plugins?: { entries?: { searxng?: { config?: { webSearch?: { baseUrl?: string } } } } };
        }
      ).plugins?.entries?.searxng?.config?.webSearch?.baseUrl,
    ).toBe("http://search.local:9000");
  });
});
