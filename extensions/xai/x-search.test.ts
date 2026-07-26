// Xai tests cover x search plugin behavior.
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createXSearchTool } from "./x-search.js";

const XAI_DOCUMENTED_HANDLE_LIMIT = 20;

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function installXSearchFetch(payload?: Record<string, unknown>) {
  const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
    Promise.resolve(
      jsonResponse(
        payload ?? {
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Found X posts",
                  annotations: [{ type: "url_citation", url: "https://x.com/openclaw/status/1" }],
                },
              ],
            },
          ],
          citations: ["https://x.com/openclaw/status/1"],
        },
      ),
    ),
  );
  global.fetch = withFetchPreconnect(mockFetch);
  return mockFetch;
}

function firstFetchCall(mockFetch: ReturnType<typeof installXSearchFetch>) {
  const [call] = mockFetch.mock.calls;
  if (!call) {
    throw new Error("expected x_search fetch call");
  }
  return call;
}

function firstFetchUrl(mockFetch: ReturnType<typeof installXSearchFetch>) {
  const [url] = firstFetchCall(mockFetch);
  return String(url);
}

function firstFetchInit(mockFetch: ReturnType<typeof installXSearchFetch>): RequestInit {
  const [, init] = firstFetchCall(mockFetch);
  if (!init || typeof init !== "object" || Array.isArray(init)) {
    throw new Error("expected x_search fetch init");
  }
  return init as RequestInit;
}

function firstAuthorizationHeader(mockFetch: ReturnType<typeof installXSearchFetch>) {
  const headers = firstFetchInit(mockFetch).headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("expected x_search request headers");
  }
  return (headers as Record<string, string>).Authorization;
}

function parseFirstRequestBody(mockFetch: ReturnType<typeof installXSearchFetch>) {
  const requestBody = firstFetchInit(mockFetch).body;
  return JSON.parse(typeof requestBody === "string" ? requestBody : "{}") as Record<
    string,
    unknown
  >;
}

function createConfiguredXSearchTool() {
  const tool = createXSearchTool({
    config: {
      plugins: {
        entries: {
          xai: {
            config: {
              webSearch: {
                apiKey: "xai-config-test", // pragma: allowlist secret
              },
            },
          },
        },
      },
    },
  });
  if (!tool) {
    throw new Error("expected x_search tool to be configured");
  }
  return tool;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("xai x_search tool", () => {
  it("describes query as the required instruction for the Grok X-search agent", () => {
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    const parameters = tool?.parameters as
      | { properties?: { query?: { description?: string } } }
      | undefined;
    const queryDescription = parameters?.properties?.query?.description;

    expect(queryDescription).toContain("Natural-language instruction");
    expect(queryDescription).toContain("Grok X-search agent");
    expect(queryDescription).toContain("meaningful and non-empty");
    expect(queryDescription).not.toContain("allowed_x_handles");
  });

  it("publishes xAI handle-filter constraints in the tool schema", () => {
    const tool = createConfiguredXSearchTool();
    const parameters = tool.parameters as {
      properties?: Record<string, { description?: string; maxItems?: number }>;
    };

    for (const [key, counterpart] of [
      ["allowed_x_handles", "excluded_x_handles"],
      ["excluded_x_handles", "allowed_x_handles"],
    ] as const) {
      expect(parameters.properties?.[key]?.maxItems).toBe(XAI_DOCUMENTED_HANDLE_LIMIT);
      expect(parameters.properties?.[key]?.description).toContain(counterpart);
    }
  });

  it("enables x_search when runtime config carries the shared xAI key", () => {
    const tool = createXSearchTool({
      config: {},
      runtimeConfig: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "x-search-runtime-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    expect(tool?.name).toBe("x_search");
  });

  it("enables x_search from an xAI auth profile and uses it for requests", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {},
      auth: {
        hasAuthForProvider: (providerId) => providerId === "xai",
        resolveApiKeyForProvider: async (providerId) =>
          providerId === "xai" ? "xai-profile-key" : undefined, // pragma: allowlist secret
      },
    });

    expect(tool?.name).toBe("x_search");
    await tool?.execute?.("x-search:auth-profile", {
      query: "auth profile search",
    });

    expect(firstAuthorizationHeader(mockFetch)).toBe("Bearer xai-profile-key");
  });

  it("enables x_search when the xAI plugin web search key is configured", () => {
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    expect(tool?.name).toBe("x_search");
  });

  it("uses the xAI Responses x_search tool with structured filters", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-config-test", // pragma: allowlist secret
                },
                xSearch: { maxTurns: 2 },
              },
            },
          },
        },
      },
    });

    const result = await tool?.execute?.("x-search:1", {
      query: "dinner recipes",
      allowed_x_handles: ["openclaw"],
      from_date: "2026-03-01",
      to_date: "2026-03-20",
      enable_image_understanding: true,
    });

    expect(mockFetch).toHaveBeenCalled();
    expect(firstFetchUrl(mockFetch)).toContain("api.x.ai/v1/responses");
    const body = parseFirstRequestBody(mockFetch);
    expect(body.model).toBe("grok-4.3");
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.max_turns).toBe(2);
    expect(body.tools).toEqual([
      {
        type: "x_search",
        allowed_x_handles: ["openclaw"],
        from_date: "2026-03-01",
        to_date: "2026-03-20",
        enable_image_understanding: true,
      },
    ]);
    expect((result?.details as { citations?: string[] } | undefined)?.citations).toEqual([
      "https://x.com/openclaw/status/1",
    ]);
  });

  it("rejects combined allow and exclude handle filters before calling xAI", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createConfiguredXSearchTool();

    await expect(
      tool.execute("x-search:combined-handle-filters", {
        query: "dinner recipes",
        allowed_x_handles: ["openclaw"],
        excluded_x_handles: ["spam"],
      }),
    ).rejects.toThrow("allowed_x_handles and excluded_x_handles cannot be used together");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(["allowed_x_handles", "excluded_x_handles"] as const)(
    "accepts the xAI limit for %s",
    async (key) => {
      const mockFetch = installXSearchFetch();
      const tool = createConfiguredXSearchTool();
      const handles = Array.from(
        { length: XAI_DOCUMENTED_HANDLE_LIMIT },
        (_, index) => `${key}-${index}`,
      );

      await tool.execute(`x-search:${key}:limit`, {
        query: `${key} boundary`,
        [key]: handles,
      });

      expect(parseFirstRequestBody(mockFetch).tools).toEqual([
        { type: "x_search", [key]: handles },
      ]);
    },
  );

  it.each(["allowed_x_handles", "excluded_x_handles"] as const)(
    "rejects %s above the xAI limit before calling xAI",
    async (key) => {
      const mockFetch = installXSearchFetch();
      const tool = createConfiguredXSearchTool();
      const handles = Array.from(
        { length: XAI_DOCUMENTED_HANDLE_LIMIT + 1 },
        (_, index) => `${key}-${index}`,
      );

      await expect(
        tool.execute(`x-search:${key}:over-limit`, {
          query: `${key} over limit`,
          [key]: handles,
        }),
      ).rejects.toThrow(`${key} cannot contain more than ${XAI_DOCUMENTED_HANDLE_LIMIT} handles`);
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it("routes x_search through plugin-owned xSearch.baseUrl", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-config-test", // pragma: allowlist secret
                },
                xSearch: {
                  enabled: true,
                  baseUrl: "https://api.x.ai/xai-search/v1/",
                },
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:plugin-base-url", {
      query: "base url route",
    });

    expect(firstFetchUrl(mockFetch)).toBe("https://api.x.ai/xai-search/v1/responses");
  });

  it("shares plugin webSearch.baseUrl with x_search when xSearch.baseUrl is unset", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                  baseUrl: "https://api.x.ai/shared/v1/",
                },
                xSearch: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:web-search-base-url", {
      query: "shared base url route",
    });

    expect(firstFetchUrl(mockFetch)).toBe("https://api.x.ai/shared/v1/responses");
  });

  it("reuses the xAI plugin web search key for x_search requests", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:plugin-key", {
      query: "latest post from huntharo",
    });

    expect(firstAuthorizationHeader(mockFetch)).toBe("Bearer xai-plugin-key");
  });

  it("reports malformed x_search JSON as a provider error", async () => {
    const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve(
        new Response("{ nope", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    global.fetch = withFetchPreconnect(mockFetch);
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                },
                xSearch: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
    });

    await expect(
      tool?.execute?.("x-search:malformed-json", {
        query: "malformed x_search response probe",
      }),
    ).rejects.toThrow("xAI X search failed: malformed JSON response");
  });

  it("rejects x_search success JSON without answer text", async () => {
    const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve(jsonResponse({ output: [] })),
    );
    global.fetch = withFetchPreconnect(mockFetch);
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                },
                xSearch: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
    });

    await expect(
      tool?.execute?.("x-search:missing-text", {
        query: "malformed x_search missing text probe",
      }),
    ).rejects.toThrow("xAI X search failed: malformed JSON response");
  });

  it("prefers the active runtime config for shared xAI keys", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "X_SEARCH_KEY_REF" },
                },
              },
            },
          },
        },
      },
      runtimeConfig: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "x-search-runtime-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:runtime-key", {
      query: "runtime key search",
    });

    expect(firstAuthorizationHeader(mockFetch)).toBe("Bearer x-search-runtime-key");
  });

  it("rejects invalid date ordering before calling xAI", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-config-test", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    await expect(
      tool?.execute?.("x-search:bad-dates", {
        query: "dinner recipes",
        from_date: "2026-03-20",
        to_date: "2026-03-01",
      }),
    ).rejects.toThrow(/from_date must be on or before to_date/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
