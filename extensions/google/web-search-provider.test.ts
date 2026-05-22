import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withEnv, withEnvAsync, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing, createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

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
  vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
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

function requireFirstGeminiFetchCall(
  mockFetch: ReturnType<typeof installGeminiFetch>,
): [RequestInfo | URL | undefined, RequestInit | undefined] {
  const [call] = mockFetch.mock.calls;
  if (!call) {
    throw new Error("expected Gemini web search fetch call");
  }
  return call as [RequestInfo | URL | undefined, RequestInit | undefined];
}

function getFetchHeaders(mockFetch: ReturnType<typeof installGeminiFetch>): Record<string, string> {
  const [, init] = requireFirstGeminiFetchCall(mockFetch);
  return (init?.headers as Record<string, string> | undefined) ?? {};
}

function getGeminiFetchUrl(mockFetch: ReturnType<typeof installGeminiFetch>): string | undefined {
  const [input] = requireFirstGeminiFetchCall(mockFetch);
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
  const [, init] = requireFirstGeminiFetchCall(mockFetch);
  const body = init?.body;
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
  vi.unstubAllGlobals();
});

describe("google web search provider", () => {
  it("points missing-key users to fetch/browser alternatives", async () => {
    await withEnvAsync({ GEMINI_API_KEY: undefined }, async () => {
      const provider = createGeminiWebSearchProvider();
      const tool = provider.createTool({ config: {}, searchConfig: {} });
      if (!tool) {
        throw new Error("Expected tool definition");
      }

      await expect(tool.execute({ query: "OpenClaw docs" })).resolves.toEqual({
        docs: "https://docs.openclaw.ai/tools/web",
        error: "missing_gemini_api_key",
        message:
          "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, configure plugins.entries.google.config.webSearch.apiKey, or reuse models.providers.google.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
      });
    });
  });

  it("falls back to GEMINI_API_KEY from the environment", () => {
    withEnv({ GEMINI_API_KEY: "AIza-env-test" }, () => {
      expect(testing.resolveGeminiApiKey()).toBe("AIza-env-test");
    });
  });

  it("prefers configured api keys over env fallbacks", () => {
    withEnv({ GEMINI_API_KEY: "AIza-env-test" }, () => {
      expect(testing.resolveGeminiApiKey({ apiKey: "AIza-configured-test" })).toBe(
        "AIza-configured-test",
      );
    });
  });

  it("uses provider api keys only after env fallbacks", () => {
    withEnv({ GEMINI_API_KEY: "AIza-env-test" }, () => {
      expect(testing.resolveGeminiApiKey({ providerApiKey: "AIza-provider-test" })).toBe(
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
    expect(testing.resolveGeminiModel()).toBe("gemini-2.5-flash");
    expect(testing.resolveGeminiModel({ model: "  gemini-2.5-pro  " })).toBe("gemini-2.5-pro");
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

  it("reports malformed Gemini API JSON with a stable provider error", async () => {
    vi.stubGlobal(
      "fetch",
      withFetchPreconnect(vi.fn(() => Promise.resolve(new Response("{ nope")))),
    );
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

    await expect(tool?.execute({ query: "OpenClaw docs" })).rejects.toThrow(
      "Gemini API error: malformed JSON response",
    );
  });

  it("rejects wrong-root Gemini success JSON with a stable provider error", async () => {
    vi.stubGlobal(
      "fetch",
      withFetchPreconnect(vi.fn(() => Promise.resolve(new Response(JSON.stringify([]))))),
    );
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

    await expect(tool?.execute({ query: "OpenClaw docs" })).rejects.toThrow(
      "Gemini API error: malformed JSON response",
    );
  });

  it("rejects Gemini success JSON without candidate text", async () => {
    vi.stubGlobal(
      "fetch",
      withFetchPreconnect(
        vi.fn(() =>
          Promise.resolve(
            new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }] })),
          ),
        ),
      ),
    );
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

    await expect(tool?.execute({ query: "OpenClaw docs" })).rejects.toThrow(
      "Gemini API error: malformed JSON response",
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

    const [, init] = requireFirstGeminiFetchCall(mockFetch);
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
    vi.useFakeTimers({ toFake: ["Date"] });
    // Use a wall-clock-realistic moment with non-zero milliseconds; the helper
    // must strip them to avoid Gemini's "Granularity of nano is not supported".
    vi.setSystemTime(new Date("2026-04-15T12:00:00.123Z"));
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

    await tool?.execute({ query: "latest ai news timestamp precision", freshness: "week" });

    const body = parseGeminiFetchBody(mockFetch);
    expect(body.tools?.[0]?.google_search?.timeRangeFilter).toEqual({
      startTime: "2026-04-08T12:00:00Z",
      endTime: "2026-04-15T12:00:00Z",
    });
  });

  it("strips sub-second precision from freshness timestamps so Gemini accepts them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // "now" with non-zero milliseconds. Without stripping, toISOString() emits
    // "2026-04-15T12:00:00.123Z", which Gemini's google_search.time_range_filter
    // rejects with "Granularity of nano is not supported".
    vi.setSystemTime(new Date("2026-04-15T12:00:00.123Z"));
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
    const filter = body.tools?.[0]?.google_search?.timeRangeFilter as
      | { startTime: string; endTime: string }
      | undefined;
    expect(filter?.startTime).not.toMatch(/\.\d+Z$/);
    expect(filter?.endTime).not.toMatch(/\.\d+Z$/);
    expect(filter).toEqual({
      startTime: "2026-04-08T12:00:00Z",
      endTime: "2026-04-15T12:00:00Z",
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
      endTime: "2026-05-01T00:00:00Z",
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
    ).resolves.toEqual({
      docs: "https://docs.openclaw.ai/tools/web",
      error: "conflicting_time_filters",
      message:
        "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("normalizes Gemini shorthand base URLs", () => {
    expect(
      testing.resolveGeminiBaseUrl({ baseUrl: "https://generativelanguage.googleapis.com" }),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
  });
});
