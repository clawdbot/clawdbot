import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { withEnv, withEnvAsync, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

type TestModelProviderConfig = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string];

function installGeminiFetch() {
  const mockFetch = vi.fn((_input?: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          candidates: [
            {
              content: { parts: [{ text: "Grounded answer" }] },
              groundingMetadata: {
                groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
              },
            },
          ],
        }),
    } as Response),
  );
  global.fetch = withFetchPreconnect(mockFetch);
  return mockFetch;
}

function createGoogleModelProviderConfig(
  overrides: Partial<TestModelProviderConfig>,
): TestModelProviderConfig {
  return {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
    models: [],
    ...overrides,
  };
}

function getFetchHeaders(mockFetch: ReturnType<typeof installGeminiFetch>): Record<string, string> {
  const init = mockFetch.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers ?? {};
}

function getGeminiFetchUrl(mockFetch: ReturnType<typeof installGeminiFetch>): string | undefined {
  const input = mockFetch.mock.calls[0]?.[0];
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input?.url;
}

function parseGeminiFetchBody(mockFetch: ReturnType<typeof installGeminiFetch>): {
  tools?: Array<{ google_search?: { timeRangeFilter?: unknown } }>;
} {
  const body = mockFetch.mock.calls[0]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected Gemini fetch body string");
  }
  return JSON.parse(body) as {
    tools?: Array<{ google_search?: { timeRangeFilter?: unknown } }>;
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("google web search provider", () => {
  it("points missing-key users to fetch/browser alternatives", async () => {
    await withEnvAsync({ GEMINI_API_KEY: undefined }, async () => {
      const provider = createGeminiWebSearchProvider();
      const tool = provider.createTool({ config: {}, searchConfig: {} });
      if (!tool) {
        throw new Error("Expected tool definition");
      }

      await expect(tool.execute({ query: "OpenClaw docs" })).resolves.toMatchObject({
        error: "missing_gemini_api_key",
        message: expect.stringContaining("use web_fetch for a specific URL or the browser tool"),
      });
    });
  });

  it("falls back to GEMINI_API_KEY from the environment", () => {
    withEnv({ GEMINI_API_KEY: "AIza-env-test" }, () => {
      expect(__testing.resolveGeminiApiKey()).toBe("AIza-env-test");
    });
  });

  it("prefers configured api keys over env fallbacks", () => {
    withEnv({ GEMINI_API_KEY: "AIza-env-test" }, () => {
      expect(__testing.resolveGeminiApiKey({ apiKey: "AIza-configured-test" })).toBe(
        "AIza-configured-test",
      );
    });
  });

  it("uses provider api keys only after env fallbacks", () => {
    withEnv({ GEMINI_API_KEY: "AIza-env-test" }, () => {
      expect(__testing.resolveGeminiApiKey({ providerApiKey: "AIza-provider-test" })).toBe(
        "AIza-env-test",
      );
    });
  });

  it("stores configured credentials at the canonical plugin config path", () => {
    const provider = createGeminiWebSearchProvider();
    const config = {} as OpenClawConfig;

    provider.setConfiguredCredentialValue?.(config, "AIza-plugin-test");

    expect(provider.credentialPath).toBe("plugins.entries.google.config.webSearch.apiKey");
    expect(provider.getConfiguredCredentialValue?.(config)).toBe("AIza-plugin-test");
  });

  it("defaults the Gemini web search model and trims explicit overrides", () => {
    expect(__testing.resolveGeminiModel()).toBe("gemini-2.5-flash");
    expect(__testing.resolveGeminiModel({ model: "  gemini-2.5-pro  " })).toBe("gemini-2.5-pro");
  });

  it("routes Gemini web search through plugin webSearch.baseUrl", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                  baseUrl: "https://generativelanguage.googleapis.com/proxy/v1beta/",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "OpenClaw docs" });

    expect(getGeminiFetchUrl(mockFetch)).toBe(
      "https://generativelanguage.googleapis.com/proxy/v1beta/models/gemini-2.5-flash:generateContent",
    );
  });

  it("passes provider execution abort signals into the Gemini fetch", async () => {
    const mockFetch = installGeminiFetch();
    const controller = new AbortController();
    controller.abort();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "OpenClaw docs" }, { signal: controller.signal });

    const init = mockFetch.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(init?.signal?.aborted).toBe(true);
  });

  it("reuses the Google model provider key when no web search key or env key is set", async () => {
    await withEnvAsync({ GEMINI_API_KEY: undefined }, async () => {
      const mockFetch = installGeminiFetch();
      const provider = createGeminiWebSearchProvider();
      const tool = provider.createTool({
        config: {
          models: {
            providers: {
              google: createGoogleModelProviderConfig({
                apiKey: "AIza-provider-test",
              }),
            },
          },
        },
        searchConfig: { provider: "gemini" },
      });

      await tool?.execute({ query: "OpenClaw provider key fallback" });

      expect(getFetchHeaders(mockFetch)["x-goog-api-key"]).toBe("AIza-provider-test");
    });
  });

  it("keeps plugin web search keys ahead of env and provider keys", async () => {
    await withEnvAsync({ GEMINI_API_KEY: "AIza-env-test" }, async () => {
      const mockFetch = installGeminiFetch();
      const provider = createGeminiWebSearchProvider();
      const tool = provider.createTool({
        config: {
          plugins: {
            entries: {
              google: {
                config: {
                  webSearch: {
                    apiKey: "AIza-plugin-test",
                  },
                },
              },
            },
          },
          models: {
            providers: {
              google: createGoogleModelProviderConfig({
                apiKey: "AIza-provider-test",
              }),
            },
          },
        },
        searchConfig: { provider: "gemini" },
      });

      await tool?.execute({ query: "OpenClaw plugin key precedence" });

      expect(getFetchHeaders(mockFetch)["x-goog-api-key"]).toBe("AIza-plugin-test");
    });
  });

  it("routes Gemini web search through provider-level google.baseUrl as a fallback", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        models: {
          providers: {
            google: createGoogleModelProviderConfig({
              apiKey: "AIza-provider-test",
              baseUrl: "https://generativelanguage.googleapis.com/provider/v1beta/",
            }),
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "OpenClaw provider baseUrl fallback" });

    expect(getGeminiFetchUrl(mockFetch)).toBe(
      "https://generativelanguage.googleapis.com/provider/v1beta/models/gemini-2.5-flash:generateContent",
    );
  });

  it("keeps plugin webSearch.baseUrl ahead of provider-level google.baseUrl", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                  baseUrl: "https://generativelanguage.googleapis.com/plugin/v1beta/",
                },
              },
            },
          },
        },
        models: {
          providers: {
            google: createGoogleModelProviderConfig({
              baseUrl: "https://generativelanguage.googleapis.com/provider/v1beta/",
            }),
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "OpenClaw plugin baseUrl precedence" });

    expect(getGeminiFetchUrl(mockFetch)).toBe(
      "https://generativelanguage.googleapis.com/plugin/v1beta/models/gemini-2.5-flash:generateContent",
    );
  });

  it("passes freshness to Gemini Google Search grounding as a time range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T12:00:00Z"));
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "latest ai news", freshness: "week" });

    const body = parseGeminiFetchBody(mockFetch);
    expect(body.tools?.[0]?.google_search?.timeRangeFilter).toEqual({
      startTime: "2026-04-08T12:00:00.000Z",
      endTime: "2026-04-15T12:00:00.000Z",
    });
  });

  it("passes date ranges to Gemini Google Search grounding", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({
      query: "OpenClaw release notes",
      date_after: "2026-04-01",
      date_before: "2026-04-30",
    });

    const body = parseGeminiFetchBody(mockFetch);
    expect(body.tools?.[0]?.google_search?.timeRangeFilter).toEqual({
      startTime: "2026-04-01T00:00:00Z",
      endTime: "2026-05-01T00:00:00.000Z",
    });
  });

  it("returns validation errors for invalid Gemini time filters before fetch", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await expect(
      tool?.execute({
        query: "OpenClaw release notes",
        freshness: "week",
        date_after: "2026-04-01",
      }),
    ).resolves.toMatchObject({
      error: "conflicting_time_filters",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("normalizes Gemini shorthand base URLs", () => {
    expect(
      __testing.resolveGeminiBaseUrl({ baseUrl: "https://generativelanguage.googleapis.com" }),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
  });
});
