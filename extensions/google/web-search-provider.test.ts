// Google tests cover web search provider plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withEnvAsync, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

type TestModelProviderConfig = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string];

function installGeminiFetch() {
  const mockFetch = vi.fn((_input?: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "Grounded answer" }] },
              groundingMetadata: {
                groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
              },
            },
          ],
        }),
      ),
    ),
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
  return Object.fromEntries(new Headers(init?.headers).entries());
}

function createGeminiToolWithHeaders(headers: Record<string, unknown>) {
  return createGeminiWebSearchProvider().createTool({
    config: {
      plugins: {
        entries: {
          google: {
            config: {
              webSearch: {
                apiKey: "AIza-plugin-test",
                headers,
              },
            },
          },
        },
      },
    },
    searchConfig: { provider: "gemini" },
  });
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
  contents?: Array<{ parts?: Array<{ text?: string }> }>;
  tools?: Array<{ google_search?: { timeRangeFilter?: unknown } }>;
} {
  const [, init] = requireFirstGeminiFetchCall(mockFetch);
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected Gemini fetch body string");
  }
  return JSON.parse(body) as {
    contents?: Array<{ parts?: Array<{ text?: string }> }>;
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

  it("stores configured credentials at the canonical plugin config path", () => {
    const provider = createGeminiWebSearchProvider();
    const config = {} as OpenClawConfig;

    provider.setConfiguredCredentialValue?.(config, "AIza-plugin-test");

    expect(provider.credentialPath).toBe("plugins.entries.google.config.webSearch.apiKey");
    expect(provider.getConfiguredCredentialValue?.(config)).toBe("AIza-plugin-test");
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

  it("sends operator headers while keeping provider-owned headers authoritative", async () => {
    const mockFetch = installGeminiFetch();
    const tool = createGeminiToolWithHeaders({
      "X-Routing-Target": "staging",
      "X-Gateway-Token": "resolved-gateway-token",
      "X-Goog-Api-Key": "operator-value",
    });

    await tool?.execute({ query: "OpenClaw operator headers" });

    expect(getFetchHeaders(mockFetch)).toMatchObject({
      "content-type": "application/json",
      "x-gateway-token": "resolved-gateway-token",
      "x-goog-api-key": "AIza-plugin-test",
      "x-routing-target": "staging",
    });
  });

  it("partitions cached Gemini results by operator headers", async () => {
    const mockFetch = installGeminiFetch();

    await createGeminiToolWithHeaders({ "X-Routing-Target": "staging" })?.execute({
      query: "OpenClaw header cache partition",
    });
    await createGeminiToolWithHeaders({ "X-Routing-Target": "production" })?.execute({
      query: "OpenClaw header cache partition",
    });

    const postCalls = mockFetch.mock.calls.filter(([, init]) => typeof init?.body === "string");
    expect(postCalls).toHaveLength(2);
  });

  it("reuses cached Gemini answers across ignored result counts while rejecting invalid counts", async () => {
    const mockFetch = installGeminiFetch();
    const tool = createGeminiToolWithHeaders({});
    const query = "unique Gemini ignored result count cache regression";

    await tool?.execute({ query, count: 1 });
    await tool?.execute({ query, count: 10 });
    await tool?.execute({ query });

    await expect(tool?.execute({ query, count: 0 })).rejects.toThrow(
      "count must be an integer from 1 to 10.",
    );
    const postCalls = mockFetch.mock.calls.filter(([, init]) => typeof init?.body === "string");
    expect(postCalls).toHaveLength(1);
  });

  it.each([0, 1])("honors the current Gemini cache TTL of %s minutes", async (cacheTtlMinutes) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    let content = "Original grounded answer";
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: content }] } }] })),
    );
    vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
    const provider = createGeminiWebSearchProvider();
    const createTool = (ttl: number) =>
      provider.createTool({
        config: {
          plugins: {
            entries: { google: { config: { webSearch: { apiKey: "AIza-plugin-test" } } } },
          },
        },
        searchConfig: { provider: "gemini", cacheTtlMinutes: ttl },
      });
    const query = `Gemini current request cache TTL ${cacheTtlMinutes}`;
    const cachedTool = createTool(15);
    await cachedTool?.execute({ query });
    await expect(cachedTool?.execute({ query })).resolves.toMatchObject({
      cached: true,
      content: expect.stringContaining("Original grounded answer"),
    });
    expect(mockFetch).toHaveBeenCalledOnce();

    now.mockReturnValue(1_060_000);
    content = "Fresh grounded answer";
    const currentTool = createTool(cacheTtlMinutes);
    const fresh = await currentTool?.execute({ query });
    expect(fresh).not.toHaveProperty("cached");
    expect(fresh).toMatchObject({ content: expect.stringContaining("Fresh grounded answer") });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    if (cacheTtlMinutes === 0) {
      await expect(currentTool?.execute({ query })).resolves.not.toHaveProperty("cached");
      expect(mockFetch).toHaveBeenCalledTimes(3);
      await expect(cachedTool?.execute({ query })).resolves.toMatchObject({
        cached: true,
        content: expect.stringContaining("Original grounded answer"),
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } else {
      await expect(currentTool?.execute({ query })).resolves.toEqual({ ...fresh, cached: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }
  });

  it("does not partition cached results by overwritten provider-owned headers", async () => {
    const mockFetch = installGeminiFetch();

    await createGeminiToolWithHeaders({ "X-Goog-Api-Key": "operator-one" })?.execute({
      query: "OpenClaw provider-owned header cache",
    });
    await createGeminiToolWithHeaders({ "x-goog-api-key": "operator-two" })?.execute({
      query: "OpenClaw provider-owned header cache",
    });

    const postCalls = mockFetch.mock.calls.filter(([, init]) => typeof init?.body === "string");
    expect(postCalls).toHaveLength(1);
    expect(getFetchHeaders(mockFetch)["x-goog-api-key"]).toBe("AIza-plugin-test");
  });

  it("normalizes case collisions before sending and partitioning the cache", async () => {
    const mockFetch = installGeminiFetch();

    await createGeminiToolWithHeaders({
      "X-Routing-Target": "stale",
      "x-routing-target": "production",
    })?.execute({ query: "OpenClaw case-colliding header cache" });
    await createGeminiToolWithHeaders({ "X-Routing-Target": "production" })?.execute({
      query: "OpenClaw case-colliding header cache",
    });

    const postCalls = mockFetch.mock.calls.filter(([, init]) => typeof init?.body === "string");
    expect(postCalls).toHaveLength(1);
    expect(getFetchHeaders(mockFetch)["x-routing-target"]).toBe("production");
  });

  it("preserves legal empty literal header values", async () => {
    const mockFetch = installGeminiFetch();
    const tool = createGeminiToolWithHeaders({ "X-Optional-Metadata": " \t " });

    await tool?.execute({ query: "OpenClaw empty operator header" });

    expect(getFetchHeaders(mockFetch)["x-optional-metadata"]).toBe("");
  });

  it("rejects malformed operator headers before sending a request", async () => {
    const mockFetch = installGeminiFetch();
    const tool = createGeminiToolWithHeaders({ "Bad Header": "value" });

    await expect(tool?.execute({ query: "OpenClaw malformed header" })).rejects.toThrow(
      'plugins.entries.google.config.webSearch.headers["Bad Header"] is not a valid HTTP header',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    "Connection",
    "Content-Length",
    "Expect",
    "Host",
    "Keep-Alive",
    "Proxy-Connection",
    "TE",
    "Trailer",
    "Transfer-Encoding",
    "Upgrade",
  ])("rejects reserved or framing operator header %s before fetch", async (name) => {
    const mockFetch = installGeminiFetch();
    const tool = createGeminiToolWithHeaders({ [name]: "configured-value" });

    await expect(tool?.execute({ query: `OpenClaw rejects ${name}` })).rejects.toThrow(
      `plugins.entries.google.config.webSearch.headers["${name}"] uses a reserved or framing HTTP header`,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("keeps unresolved explicit header SecretRefs strict", async () => {
    const mockFetch = installGeminiFetch();
    const tool = createGeminiToolWithHeaders({
      "X-Gateway-Token": {
        source: "env",
        provider: "default",
        id: "GEMINI_GATEWAY_TOKEN",
      },
    });

    await expect(
      tool?.execute({ query: "OpenClaw unresolved header SecretRef" }),
    ).rejects.toMatchObject({
      name: "UnresolvedSecretInputError",
      path: 'plugins.entries.google.config.webSearch.headers["X-Gateway-Token"]',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("accepts Gemini success JSON with empty grounding metadata", async () => {
    vi.stubGlobal(
      "fetch",
      withFetchPreconnect(
        vi.fn(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: { parts: [{ text: "Today's date is Sunday, June 7, 2026." }] },
                    groundingMetadata: {},
                  },
                ],
              }),
            ),
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

    const result = await tool?.execute({ query: "current date today" });

    expect(result).toMatchObject({
      citations: [],
      model: "gemini-2.5-flash",
      provider: "gemini",
    });
    expect(String(result?.content)).toContain("Today's date is Sunday, June 7, 2026.");
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

  it.each([
    ["empty parts", { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }, " (STOP)"],
    [
      "missing parts",
      { candidates: [{ content: { role: "model" }, finishReason: "STOP" }] },
      " (STOP)",
    ],
    ["missing content", { candidates: [{ finishReason: "STOP" }] }, " (STOP)"],
    [
      "nontext part",
      {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: "lookup", args: {} } }] },
            finishReason: "STOP",
          },
        ],
      },
      " (STOP)",
    ],
    ["empty candidates", { candidates: [] }, ""],
    ["missing candidates", {}, ""],
    ["empty prompt feedback", { promptFeedback: {} }, ""],
    ["blocked prompt", { promptFeedback: { blockReason: "SAFETY" } }, " (SAFETY)"],
    ["blocked candidate", { candidates: [{ finishReason: "SAFETY" }] }, " (SAFETY)"],
    ["absent reason", { candidates: [{ content: { parts: [] } }] }, ""],
    ["blank reason", { candidates: [{ finishReason: "  " }] }, ""],
  ])(
    "reports no final answer for %s without inventing search results",
    async (_name, body, reason) => {
      vi.stubGlobal(
        "fetch",
        withFetchPreconnect(vi.fn(() => Promise.resolve(new Response(JSON.stringify(body))))),
      );
      const tool = createGeminiToolWithHeaders({});

      await expect(tool?.execute({ query: "OpenClaw empty answer" })).rejects.toThrow(
        `Gemini search returned no final answer${reason}.`,
      );
    },
  );

  it.each([
    ["null candidates", { candidates: null }],
    ["non-array candidates", { candidates: {} }],
    ["null candidate", { candidates: [null] }],
    ["null content", { candidates: [{ content: null }] }],
    ["non-record content", { candidates: [{ content: "invalid" }] }],
    ["null part", { candidates: [{ content: { parts: [null] } }] }],
    ["non-string part text", { candidates: [{ content: { parts: [{ text: 7 }] } }] }],
    ["null parts", { candidates: [{ content: { parts: null } }] }],
    ["non-array parts", { candidates: [{ content: { parts: {} } }] }],
    ["null prompt feedback", { promptFeedback: null }],
    ["non-record prompt feedback", { promptFeedback: [] }],
    ["null block reason", { promptFeedback: { blockReason: null } }],
    ["non-string block reason", { promptFeedback: { blockReason: {} } }],
    ["null finish reason", { candidates: [{ finishReason: null }] }],
    ["non-string finish reason", { candidates: [{ finishReason: 1 }] }],
    ["non-record grounding metadata", { candidates: [{ groundingMetadata: [] }] }],
    [
      "non-array grounding chunks",
      { candidates: [{ groundingMetadata: { groundingChunks: {} } }] },
    ],
    ["non-record error", { error: "invalid" }],
  ])("keeps malformed %s distinct from an absent answer", async (_name, body) => {
    vi.stubGlobal(
      "fetch",
      withFetchPreconnect(vi.fn(() => Promise.resolve(new Response(JSON.stringify(body))))),
    );
    const tool = createGeminiToolWithHeaders({});

    await expect(tool?.execute({ query: "OpenClaw malformed answer" })).rejects.toThrow(
      "Gemini API error: malformed JSON response",
    );
  });

  it("bounds the provider reason in an empty-answer diagnostic", async () => {
    vi.stubGlobal(
      "fetch",
      withFetchPreconnect(
        vi.fn(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                candidates: [{ finishReason: "X".repeat(1_000) }],
              }),
            ),
          ),
        ),
      ),
    );
    const tool = createGeminiToolWithHeaders({});

    await expect(tool?.execute({ query: "OpenClaw bounded reason" })).rejects.toThrow(
      `Gemini search returned no final answer (${"X".repeat(119)}…).`,
    );
  });

  it.each([[[{ text: "Partial answer" }]], [[null, { text: 7 }, { text: "Partial answer" }]]])(
    "preserves text-bearing partial answers with parts %j",
    async (parts) => {
      const mockFetch = installGeminiFetch();
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts }, finishReason: "MAX_TOKENS" }],
          }),
        ),
      );
      const tool = createGeminiToolWithHeaders({});

      await expect(
        tool?.execute({ query: `OpenClaw partial answer with ${parts.length} parts` }),
      ).resolves.toMatchObject({
        content: expect.stringContaining("Partial answer"),
      });
      expect(mockFetch).toHaveBeenCalledOnce();
    },
  );

  it("does not contact Gemini for an already-cancelled search", async () => {
    const mockFetch = installGeminiFetch();
    const controller = new AbortController();
    const reason = new Error("Gemini search cancelled before billing");
    controller.abort(reason);
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
      tool?.execute({ query: "OpenClaw cancelled docs" }, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not cache a Gemini result completed after caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("Gemini search cancelled after response");
    const mockFetch = installGeminiFetch();
    mockFetch.mockImplementationOnce(async () => {
      controller.abort(reason);
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "Cancelled grounded answer" }] },
              groundingMetadata: {},
            },
          ],
        }),
      );
    });
    const tool = createGeminiWebSearchProvider().createTool({
      config: {
        plugins: {
          entries: {
            google: { config: { webSearch: { apiKey: "AIza-plugin-test" } } },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });
    const query = "OpenClaw late-cancel Gemini cache";

    await expect(tool?.execute({ query }, { signal: controller.signal })).rejects.toBe(reason);
    await tool?.execute({ query });

    const postCalls = mockFetch.mock.calls.filter(([, init]) => typeof init?.body === "string");
    expect(postCalls).toHaveLength(2);
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
      expect(getFetchHeaders(mockFetch)["x-goog-api-client"]).toMatch(/^openclaw\//u);
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
      expect(getFetchHeaders(mockFetch)["x-goog-api-client"]).toMatch(/^openclaw\//u);
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

  it("uses a soft recency hint for Gemini day freshness shortcuts instead of a 24-hour range", async () => {
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

    await tool?.execute({ query: "latest ai news timestamp precision", freshness: "pd" });

    const body = parseGeminiFetchBody(mockFetch);
    expect(body.tools?.[0]?.google_search?.timeRangeFilter).toBeUndefined();
    expect(body.contents?.[0]?.parts?.[0]?.text).toContain(
      "Prioritize web sources published in the last 24 hours.",
    );
  });

  it("preserves hard Gemini time ranges for wider freshness values", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
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
    expect(body.contents?.[0]?.parts?.[0]?.text).toBe("latest ai news timestamp precision");
    expect(body.tools?.[0]?.google_search?.timeRangeFilter).toEqual({
      startTime: "2026-04-08T12:00:00Z",
      endTime: "2026-04-15T12:00:00Z",
    });
  });

  it("partitions Gemini cache entries for soft day freshness, hard week freshness, and no freshness", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
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

    await tool?.execute({ query: "same query cache partition", freshness: "day" });
    await tool?.execute({ query: "same query cache partition", freshness: "week" });
    await tool?.execute({ query: "same query cache partition" });

    const postCalls = mockFetch.mock.calls.filter(([, init]) => typeof init?.body === "string");
    expect(postCalls).toHaveLength(3);
    const parsePostedBody = (call: (typeof postCalls)[number] | undefined) => {
      const body = call?.[1]?.body;
      if (typeof body !== "string") {
        throw new Error("Expected Gemini fetch body to be a string");
      }
      return JSON.parse(body) as {
        contents?: Array<{ parts?: Array<{ text?: string }> }>;
        tools?: Array<{ google_search?: { timeRangeFilter?: unknown } }>;
      };
    };
    const firstBody = parsePostedBody(postCalls[0]);
    const secondBody = parsePostedBody(postCalls[1]);
    const thirdBody = parsePostedBody(postCalls[2]);
    expect(firstBody.tools?.[0]?.google_search?.timeRangeFilter).toBeUndefined();
    expect(firstBody.contents?.[0]?.parts?.[0]?.text).toContain(
      "Prioritize web sources published in the last 24 hours.",
    );
    expect(secondBody.tools?.[0]?.google_search?.timeRangeFilter).toEqual({
      startTime: "2026-04-08T12:00:00Z",
      endTime: "2026-04-15T12:00:00Z",
    });
    expect(secondBody.contents?.[0]?.parts?.[0]?.text).toBe("same query cache partition");
    expect(thirdBody.tools?.[0]?.google_search?.timeRangeFilter).toBeUndefined();
    expect(thirdBody.contents?.[0]?.parts?.[0]?.text).toBe("same query cache partition");
  });

  it.each([
    {
      label: "relative freshness",
      filter: { freshness: "week" },
      equivalentFilter: { freshness: "pw" },
      distinctFilter: { freshness: "month" },
      initialTimeRange: {
        startTime: "2026-04-08T12:00:00Z",
        endTime: "2026-04-15T12:00:00Z",
      },
    },
    {
      label: "open-ended date ranges",
      filter: { date_after: "2026-04-01" },
      equivalentFilter: { date_after: "2026-04-01" },
      distinctFilter: { date_after: "2026-04-02" },
      initialTimeRange: {
        startTime: "2026-04-01T00:00:00Z",
        endTime: "2026-04-15T12:00:00Z",
      },
    },
  ])(
    "reuses Gemini $label cache entries as the clock advances without merging distinct filters",
    async ({ label, filter, equivalentFilter, distinctFilter, initialTimeRange }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-04-15T12:00:00.123Z"));
      const mockFetch = installGeminiFetch();
      const tool = createGeminiToolWithHeaders({});
      const query = `unique Gemini ${label} moving-clock cache regression`;

      await tool?.execute({ query, ...filter });
      vi.setSystemTime(new Date("2026-04-15T12:00:02.123Z"));
      const cached = await tool?.execute({ query, ...equivalentFilter });

      expect(cached).toMatchObject({ cached: true });
      expect(parseGeminiFetchBody(mockFetch).tools?.[0]?.google_search?.timeRangeFilter).toEqual(
        initialTimeRange,
      );

      await tool?.execute({ query, ...distinctFilter });
      const postCalls = mockFetch.mock.calls.filter(([, init]) => typeof init?.body === "string");
      expect(postCalls).toHaveLength(2);
    },
  );

  it("strips sub-second precision from date-range timestamps so Gemini accepts them", async () => {
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

    await tool?.execute({ query: "latest ai news", date_after: "2026-04-01" });

    const body = parseGeminiFetchBody(mockFetch);
    const filter = body.tools?.[0]?.google_search?.timeRangeFilter as
      | { startTime: string; endTime: string }
      | undefined;
    expect(filter?.startTime).not.toMatch(/\.\d+Z$/);
    expect(filter?.endTime).not.toMatch(/\.\d+Z$/);
    expect(filter).toEqual({
      startTime: "2026-04-01T00:00:00Z",
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
});
