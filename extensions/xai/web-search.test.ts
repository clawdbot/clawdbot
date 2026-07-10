// Xai tests cover web search plugin behavior.
import { createTestWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { withEnv, withEnvAsync, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildXaiCatalogModels, resolveXaiCatalogEntry } from "./model-definitions.js";
import { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";
import { resolveFallbackXaiAuth } from "./src/tool-auth-shared.js";
import { wrapXaiWebSearchError } from "./src/web-search-shared.js";
import { testing } from "./test-api.js";
import { createXaiWebSearchProvider as createXaiWebSearchContractProvider } from "./web-search-contract-api.js";
import { createXaiWebSearchProvider } from "./web-search.js";

const providerAuthRuntimeMocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
}));

const providerAuthMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  listUsableProviderAuthProfileIds: vi.fn(() => ({ agentDir: "", profileIds: [] as string[] })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>();
  return {
    ...original,
    ensureAuthProfileStore: providerAuthMocks.ensureAuthProfileStore,
    listUsableProviderAuthProfileIds: providerAuthMocks.listUsableProviderAuthProfileIds,
  };
});

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>();
  return {
    ...original,
    resolveApiKeyForProvider: providerAuthRuntimeMocks.resolveApiKeyForProvider,
  };
});

vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>();
  return {
    ...original,
    postTrustedWebToolsJson: async (
      params: {
        url: string;
        apiKey: string;
        body: Record<string, unknown>;
        extraHeaders?: Record<string, string>;
      },
      parseResponse: (response: Response) => Promise<unknown>,
    ) => {
      const response = await globalThis.fetch(params.url, {
        method: "POST",
        headers: {
          ...params.extraHeaders,
          Accept: "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params.body),
      });
      if (!response.ok) {
        const detail =
          typeof response.text === "function"
            ? await response.text()
            : response.statusText || String(response.status);
        throw new Error(`xAI API error (${response.status}): ${detail || response.statusText}`);
      }
      return await parseResponse(response);
    },
  };
});

const {
  extractXaiWebSearchContent,
  resolveXaiInlineCitations,
  resolveXaiToolSearchConfig,
  resolveXaiWebSearchCredential,
  resolveXaiWebSearchModel,
  resolveXaiWebSearchTimeoutSeconds,
} = testing;

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

function installXaiWebSearchFetch() {
  const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
    Promise.resolve(
      jsonResponse({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Grounded Grok answer" }],
          },
        ],
      }),
    ),
  );
  global.fetch = withFetchPreconnect(mockFetch);
  return mockFetch;
}

function firstFetchUrl(mockFetch: ReturnType<typeof installXaiWebSearchFetch>) {
  const [call] = mockFetch.mock.calls;
  if (!call) {
    throw new Error("expected xai web search fetch call");
  }
  const [url] = call;
  return String(url);
}

function firstFetchBody(mockFetch: ReturnType<typeof installXaiWebSearchFetch>) {
  const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
}

function fetchCallHeader(
  mockFetch: { mock: { calls: unknown[][] } },
  index: number,
  name: string,
): string | undefined {
  const init = mockFetch.mock.calls[index]?.[1] as RequestInit | undefined;
  const headers = init?.headers;
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const lowerName = name.toLowerCase();
    return headers.find(([key]) => key.toLowerCase() === lowerName)?.[1];
  }
  return (headers as Record<string, string | undefined>)[name];
}

function expectCatalogEntry(
  modelId: string,
  expected: {
    id?: string;
    reasoning?: boolean;
    input?: string[];
    contextWindow?: number;
    maxTokens?: number;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  },
) {
  const entry = resolveXaiCatalogEntry(modelId);
  expect(entry?.id).toBe(expected.id ?? modelId);
  if ("reasoning" in expected) {
    expect(entry?.reasoning).toBe(expected.reasoning);
  }
  if (expected.input) {
    expect(entry?.input).toEqual(expected.input);
  }
  if (expected.contextWindow !== undefined) {
    expect(entry?.contextWindow).toBe(expected.contextWindow);
  }
  if (expected.maxTokens !== undefined) {
    expect(entry?.maxTokens).toBe(expected.maxTokens);
  }
  if (expected.cost) {
    expect(entry?.cost).toEqual(expected.cost);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  providerAuthMocks.ensureAuthProfileStore.mockReset();
  providerAuthMocks.listUsableProviderAuthProfileIds.mockReset();
  providerAuthMocks.listUsableProviderAuthProfileIds.mockReturnValue({
    agentDir: "",
    profileIds: [],
  });
  providerAuthRuntimeMocks.resolveApiKeyForProvider.mockReset();
});

describe("xai web search config resolution", () => {
  it("advertises xAI auth profiles in runtime and setup contracts", () => {
    expect(createXaiWebSearchProvider().authProviderId).toBe("xai");
    expect(createXaiWebSearchContractProvider().authProviderId).toBe("xai");
  });

  it("prefers configured api keys and resolves grok scoped defaults", () => {
    expect(resolveXaiWebSearchCredential({ grok: { apiKey: "xai-secret" } })).toBe("xai-secret");
    expect(resolveXaiWebSearchModel()).toBe("grok-4.3");
    expect(resolveXaiInlineCitations()).toBe(false);
  });

  it("uses config apiKey when provided", () => {
    expect(resolveXaiWebSearchCredential({ grok: { apiKey: "xai-test-key" } })).toBe(
      "xai-test-key",
    );
  });

  it("returns undefined when no apiKey is available", () => {
    withEnv({ XAI_API_KEY: undefined }, () => {
      expect(resolveXaiWebSearchCredential({})).toBeUndefined();
    });
  });

  it("resolves env SecretRefs without requiring a runtime snapshot", () => {
    withEnv({ XAI_WEB_SEARCH_KEY: "xai-env-ref-key" }, () => {
      expect(
        resolveXaiWebSearchCredential({
          grok: {
            apiKey: {
              source: "env",
              provider: "default",
              id: "XAI_WEB_SEARCH_KEY",
            },
          },
        }),
      ).toBe("xai-env-ref-key");
    });
  });

  it("merges canonical plugin config into the tool search config", () => {
    const searchConfig = resolveXaiToolSearchConfig({
      config: {
        plugins: {
          entries: {
            xai: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: "plugin-key",
                  inlineCitations: true,
                  model: "grok-4-fast-reasoning",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "grok" },
    });

    expect(resolveXaiWebSearchCredential(searchConfig)).toBe("plugin-key");
    expect(resolveXaiInlineCitations(searchConfig)).toBe(true);
    expect(resolveXaiWebSearchModel(searchConfig)).toBe("grok-4-fast");
  });

  it("treats unresolved non-env SecretRefs as missing credentials instead of using env fallback", async () => {
    await withEnvAsync({ XAI_API_KEY: "ambient-xai-test-key" }, async () => {
      const provider = createXaiWebSearchProvider();
      const maybeTool = provider.createTool({
        config: {
          plugins: {
            entries: {
              xai: {
                enabled: true,
                config: {
                  webSearch: {
                    apiKey: {
                      source: "file",
                      provider: "vault",
                      id: "/providers/xai/web-search",
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (!maybeTool) {
        throw new Error("expected xai web search tool");
      }

      const result = await maybeTool.execute({ query: "OpenClaw" });
      expect(result.error).toBe("missing_xai_api_key");
      expect(result.message).toContain("use web_fetch for a specific URL or the browser tool");
    });
  });

  it("uses xAI OAuth auth before API-key fallback for web search", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "oauth-web-search-token",
      source: "profile:xai:default",
      mode: "oauth",
      profileId: "xai:default",
    });
    const mockFetch = installXaiWebSearchFetch();
    const provider = createXaiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        agents: {
          list: [{ id: "main", default: true, agentDir: "/tmp/openclaw-xai-main-agent" }],
        },
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "configured-xai-key",
                },
              },
            },
          },
        },
      },
    });
    if (!tool) {
      throw new Error("Expected xAI web search tool");
    }

    await tool.execute({ query: "OpenClaw Grok OAuth web search" });

    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
        agentDir: "/tmp/openclaw-xai-main-agent",
      }),
    );
    expect(fetchCallHeader(mockFetch, 0, "Authorization")).toBe("Bearer oauth-web-search-token");
  });

  it("uses the active agentDir for xAI OAuth web search auth", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "active-agent-oauth-token",
      source: "profile:xai:active",
      mode: "oauth",
      profileId: "xai:active",
    });
    const mockFetch = installXaiWebSearchFetch();
    const provider = createXaiWebSearchProvider();
    const tool = provider.createTool({
      agentDir: "/tmp/openclaw-xai-active-agent",
      config: {
        agents: {
          list: [
            { id: "main", default: true, agentDir: "/tmp/openclaw-xai-main-agent" },
            { id: "side", agentDir: "/tmp/openclaw-xai-active-agent" },
          ],
        },
      },
    });
    if (!tool) {
      throw new Error("Expected xAI web search tool");
    }

    await tool.execute({ query: "OpenClaw Grok active agent OAuth web search" });

    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
        agentDir: "/tmp/openclaw-xai-active-agent",
      }),
    );
    expect(fetchCallHeader(mockFetch, 0, "Authorization")).toBe("Bearer active-agent-oauth-token");
  });

  it("refreshes xAI OAuth auth and retries web search after a 401", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider
      .mockResolvedValueOnce({
        apiKey: "expired-oauth-token",
        source: "profile:xai:default",
        mode: "oauth",
        profileId: "xai:default",
      })
      .mockResolvedValueOnce({
        apiKey: "fresh-oauth-token",
        source: "profile:xai:default",
        mode: "oauth",
        profileId: "xai:default",
      });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(textResponse("expired", { status: 401, statusText: "Unauthorized" }))
      .mockResolvedValueOnce(
        jsonResponse({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Fresh OAuth Grok answer" }],
            },
          ],
        }),
      );
    global.fetch = withFetchPreconnect(mockFetch);
    const provider = createXaiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        agents: {
          list: [{ id: "main", default: true, agentDir: "/tmp/openclaw-xai-main-agent" }],
        },
        tools: {
          web: {
            search: {
              provider: "grok",
            },
          },
        },
      },
    });
    if (!tool) {
      throw new Error("Expected xAI web search tool");
    }

    const result = await tool.execute({ query: "OpenClaw Grok OAuth refresh test" });

    expect(result.content).toContain("Fresh OAuth Grok answer");
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: "xai",
        agentDir: "/tmp/openclaw-xai-main-agent",
        profileId: "xai:default",
        lockedProfile: true,
        forceRefresh: true,
      }),
    );
    expect(fetchCallHeader(mockFetch, 0, "Authorization")).toBe("Bearer expired-oauth-token");
    expect(fetchCallHeader(mockFetch, 1, "Authorization")).toBe("Bearer fresh-oauth-token");
  });

  it("falls back to xAI API-key auth when OAuth refresh cannot recover", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider
      .mockResolvedValueOnce({
        apiKey: "expired-oauth-token",
        source: "profile:xai:default",
        mode: "oauth",
        profileId: "xai:default",
      })
      .mockResolvedValueOnce({
        apiKey: "expired-oauth-token",
        source: "profile:xai:default",
        mode: "oauth",
        profileId: "xai:default",
      })
      .mockResolvedValueOnce({
        apiKey: "xai-env-fallback-key",
        source: "XAI_API_KEY",
        mode: "api-key",
      });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(textResponse("revoked", { status: 401, statusText: "Unauthorized" }))
      .mockResolvedValueOnce(
        jsonResponse({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "API key fallback Grok answer" }],
            },
          ],
        }),
      );
    global.fetch = withFetchPreconnect(mockFetch);
    const provider = createXaiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        agents: {
          list: [{ id: "main", default: true, agentDir: "/tmp/openclaw-xai-main-agent" }],
        },
        tools: {
          web: {
            search: {
              provider: "grok",
            },
          },
        },
      },
    });
    if (!tool) {
      throw new Error("Expected xAI web search tool");
    }

    const result = await tool.execute({ query: "OpenClaw Grok API fallback test" });

    expect(result.content).toContain("API key fallback Grok answer");
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        provider: "xai",
        agentDir: "/tmp/openclaw-xai-main-agent",
        credentialPrecedence: "env-first",
      }),
    );
    expect(fetchCallHeader(mockFetch, 1, "Authorization")).toBe("Bearer xai-env-fallback-key");
  });

  it("falls back to an xAI API-key auth profile when stale OAuth remains first", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider
      .mockResolvedValueOnce({
        apiKey: "expired-oauth-token",
        source: "profile:xai:default",
        mode: "oauth",
        profileId: "xai:default",
      })
      .mockResolvedValueOnce({
        apiKey: "expired-oauth-token",
        source: "profile:xai:default",
        mode: "oauth",
        profileId: "xai:default",
      })
      .mockResolvedValueOnce({
        apiKey: "expired-oauth-token",
        source: "profile:xai:default",
        mode: "oauth",
        profileId: "xai:default",
      })
      .mockResolvedValueOnce({
        apiKey: "xai-profile-api-key",
        source: "profile:xai:key",
        mode: "api-key",
        profileId: "xai:key",
      });
    providerAuthMocks.listUsableProviderAuthProfileIds.mockReturnValue({
      agentDir: "/tmp/openclaw-xai-main-agent",
      profileIds: ["xai:default", "xai:key"],
    });
    providerAuthMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      active: "xai:default",
      profiles: {
        "xai:default": {
          provider: "xai",
          type: "oauth",
          access: "expired-oauth-token",
          refresh: "refresh-oauth-token",
          expires: Date.now() + 3_600_000,
        },
        "xai:key": {
          provider: "xai",
          type: "api_key",
          keyRef: { source: "env", id: "XAI_API_KEY" },
        },
      },
    });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(textResponse("revoked", { status: 401, statusText: "Unauthorized" }))
      .mockResolvedValueOnce(
        jsonResponse({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Profile API key Grok answer" }],
            },
          ],
        }),
      );
    global.fetch = withFetchPreconnect(mockFetch);
    const provider = createXaiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        agents: {
          list: [{ id: "main", default: true, agentDir: "/tmp/openclaw-xai-main-agent" }],
        },
        tools: {
          web: {
            search: {
              provider: "grok",
            },
          },
        },
      },
    });
    if (!tool) {
      throw new Error("Expected xAI web search tool");
    }

    const result = await tool.execute({ query: "OpenClaw Grok profile fallback test" });

    expect(result.content).toContain("Profile API key Grok answer");
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        provider: "xai",
        agentDir: "/tmp/openclaw-xai-main-agent",
        profileId: "xai:key",
        lockedProfile: true,
      }),
    );
    expect(fetchCallHeader(mockFetch, 1, "Authorization")).toBe("Bearer xai-profile-api-key");
  });

  it("falls back to env auth after a stale xAI API-key auth profile returns unauthorized", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider
      .mockResolvedValueOnce({
        apiKey: "stale-profile-key",
        source: "profile:xai:default",
        mode: "api-key",
        profileId: "xai:default",
      })
      .mockResolvedValueOnce({
        apiKey: "xai-env-fallback-key",
        source: "XAI_API_KEY",
        mode: "api-key",
      });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        textResponse("stale api key", { status: 401, statusText: "Unauthorized" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Env fallback Grok answer" }],
            },
          ],
        }),
      );
    global.fetch = withFetchPreconnect(mockFetch);
    const provider = createXaiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        agents: {
          list: [{ id: "main", default: true, agentDir: "/tmp/openclaw-xai-main-agent" }],
        },
        tools: {
          web: {
            search: {
              provider: "grok",
            },
          },
        },
      },
    });
    if (!tool) {
      throw new Error("Expected xAI web search tool");
    }

    const result = await tool.execute({ query: "OpenClaw Grok API-key fallback test" });

    expect(result.content).toContain("Env fallback Grok answer");
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: "xai",
        agentDir: "/tmp/openclaw-xai-main-agent",
        credentialPrecedence: "env-first",
      }),
    );
    expect(fetchCallHeader(mockFetch, 0, "Authorization")).toBe("Bearer stale-profile-key");
    expect(fetchCallHeader(mockFetch, 1, "Authorization")).toBe("Bearer xai-env-fallback-key");
  });

  it("offers plugin-owned xSearch setup after Grok is selected", async () => {
    const provider = createXaiWebSearchProvider();
    const select = vi.fn().mockResolvedValueOnce("yes").mockResolvedValueOnce("grok-4.3");
    const prompter = createTestWizardPrompter({
      select: select as never,
    });

    const next = await provider.runSetup?.({
      config: {
        plugins: {
          entries: {
            xai: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: "xai-test-key",
                },
              },
            },
          },
        },
        tools: {
          web: {
            search: {
              provider: "grok",
              enabled: true,
            },
          },
        },
      },
      runtime: createNonExitingRuntime(),
      prompter,
    });

    const xSearch = next?.plugins?.entries?.xai?.config?.xSearch as
      | { enabled?: boolean; model?: string }
      | undefined;
    expect(xSearch?.enabled).toBe(true);
    expect(xSearch?.model).toBe("grok-4.3");
  });

  it("keeps explicit xSearch disablement untouched during provider-owned setup", async () => {
    const provider = createXaiWebSearchProvider();
    const config = {
      plugins: {
        entries: {
          xai: {
            config: {
              xSearch: {
                enabled: false,
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            provider: "grok",
            enabled: true,
          },
        },
      },
    };
    const prompter = createTestWizardPrompter();

    const next = await provider.runSetup?.({
      config,
      runtime: createNonExitingRuntime(),
      prompter,
    });

    expect(next).toEqual(config);
    expect(prompter.note).not.toHaveBeenCalled();
  });

  it("reuses the plugin web search api key for provider auth fallback", () => {
    expect(
      resolveFallbackXaiAuth({
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-provider-fallback", // pragma: allowlist secret
                },
              },
            },
          },
        },
      } as never),
    ).toEqual({
      apiKey: "xai-provider-fallback",
      source: "plugins.entries.xai.config.webSearch.apiKey",
    });
  });

  it("reuses the legacy grok web search api key for provider auth fallback", () => {
    expect(
      resolveFallbackXaiAuth({
        tools: {
          web: {
            search: {
              grok: {
                apiKey: "xai-legacy-fallback", // pragma: allowlist secret
              },
            },
          },
        },
      } as never),
    ).toEqual({
      apiKey: "xai-legacy-fallback",
      source: "tools.web.search.grok.apiKey",
    });
  });

  it("returns a managed marker for SecretRef-backed plugin auth fallback", () => {
    expect(
      resolveFallbackXaiAuth({
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: { source: "file", provider: "vault", id: "/xai/api-key" },
                },
              },
            },
          },
        },
      } as never),
    ).toEqual({
      apiKey: NON_ENV_SECRETREF_MARKER,
      source: "plugins.entries.xai.config.webSearch.apiKey",
    });
  });

  it("uses default model when not specified", () => {
    expect(resolveXaiWebSearchModel({})).toBe("grok-4.3");
    expect(resolveXaiWebSearchModel(undefined)).toBe("grok-4.3");
  });

  it("uses a Grok-specific 60s default timeout while preserving overrides", () => {
    expect(resolveXaiWebSearchTimeoutSeconds({})).toBe(60);
    expect(resolveXaiWebSearchTimeoutSeconds(undefined)).toBe(60);
    expect(resolveXaiWebSearchTimeoutSeconds({ timeoutSeconds: 15 })).toBe(15);
  });

  it("uses config model when provided", () => {
    expect(resolveXaiWebSearchModel({ grok: { model: "grok-4-fast-reasoning" } })).toBe(
      "grok-4-fast",
    );
  });

  it("routes Grok web search through plugin webSearch.baseUrl", async () => {
    const mockFetch = installXaiWebSearchFetch();
    const provider = createXaiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-config-test",
                  baseUrl: "https://api.x.ai/proxy/v1/",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "grok" },
    });
    if (!tool) {
      throw new Error("Expected xAI web search tool");
    }

    await tool.execute({ query: "OpenClaw Grok proxy test" });

    expect(firstFetchUrl(mockFetch)).toBe("https://api.x.ai/proxy/v1/responses");
    expect(firstFetchBody(mockFetch)).toMatchObject({
      model: "grok-4.3",
      store: false,
      reasoning: { effort: "low" },
      tools: [{ type: "web_search" }],
    });
  });

  it("reports malformed xAI web search JSON as a provider error", async () => {
    const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve(
        new Response("{ nope", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    global.fetch = withFetchPreconnect(mockFetch);
    const provider = createXaiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-test-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await expect(tool.execute({ query: "OpenClaw" })).rejects.toThrow(
      "xAI web search failed: malformed JSON response",
    );
  });

  it("rejects xAI web search success JSON without answer text", async () => {
    const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve(jsonResponse({ output: [] })),
    );
    global.fetch = withFetchPreconnect(mockFetch);
    const provider = createXaiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-test-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await expect(tool.execute({ query: "OpenClaw" })).rejects.toThrow(
      "xAI web search failed: malformed JSON response",
    );
  });

  it("preserves provider-owned Grok 4.20 aliases", () => {
    expect(
      resolveXaiWebSearchModel({
        grok: { model: "grok-4.20-experimental-beta-0304-reasoning" },
      }),
    ).toBe("grok-4.20-experimental-beta-0304-reasoning");
    expect(
      resolveXaiWebSearchModel({
        grok: { model: "grok-4.20-experimental-beta-0304-non-reasoning" },
      }),
    ).toBe("grok-4.20-experimental-beta-0304-non-reasoning");
  });

  it("defaults inlineCitations to false", () => {
    expect(resolveXaiInlineCitations({})).toBe(false);
    expect(resolveXaiInlineCitations(undefined)).toBe(false);
  });

  it("respects inlineCitations config", () => {
    expect(resolveXaiInlineCitations({ grok: { inlineCitations: true } })).toBe(true);
    expect(resolveXaiInlineCitations({ grok: { inlineCitations: false } })).toBe(false);
  });

  it("builds wrapped payloads with optional inline citations", () => {
    const payload = testing.buildXaiWebSearchPayload({
      query: "q",
      provider: "grok",
      model: "grok-4-fast",
      tookMs: 12,
      content: "body",
      citations: ["https://a.test"],
    });
    expect(payload.query).toBe("q");
    expect(payload.provider).toBe("grok");
    expect(payload.model).toBe("grok-4-fast");
    expect(payload.tookMs).toBe(12);
    expect(payload.citations).toEqual(["https://a.test"]);
    const externalContent = payload.externalContent as { wrapped?: boolean } | undefined;
    expect(externalContent?.wrapped).toBe(true);
  });

  it("converts internal xAI timeout aborts into structured tool errors", () => {
    const abort = new DOMException("This operation was aborted", "AbortError");

    expect(() => wrapXaiWebSearchError(abort, 60)).toThrow("xAI web search timed out after 60s");

    try {
      wrapXaiWebSearchError(abort, 60);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("Error");
      expect((error as Error).cause).toBe(abort);
    }
  });
});

describe("xai web search response parsing", () => {
  it("extracts content from Responses API message blocks", () => {
    const result = extractXaiWebSearchContent({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "hello from output" }],
        },
      ],
    });
    expect(result.text).toBe("hello from output");
    expect(result.annotationCitations).toStrictEqual([]);
  });

  it("extracts url_citation annotations from content blocks", () => {
    const result = extractXaiWebSearchContent({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "hello with citations",
              annotations: [
                { type: "url_citation", url: "https://example.com/a" },
                { type: "url_citation", url: "https://example.com/b" },
                { type: "url_citation", url: "https://example.com/a" },
              ],
            },
          ],
        },
      ],
    });
    expect(result.text).toBe("hello with citations");
    expect(result.annotationCitations).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("falls back to deprecated output_text", () => {
    const result = extractXaiWebSearchContent({ output_text: "hello from output_text" });
    expect(result.text).toBe("hello from output_text");
    expect(result.annotationCitations).toStrictEqual([]);
  });

  it("returns undefined text when no content found", () => {
    const result = extractXaiWebSearchContent({});
    expect(result.text).toBeUndefined();
    expect(result.annotationCitations).toStrictEqual([]);
  });

  it("extracts output_text blocks directly in output array", () => {
    const result = extractXaiWebSearchContent({
      output: [
        { type: "web_search_call" },
        {
          type: "output_text",
          text: "direct output text",
          annotations: [{ type: "url_citation", url: "https://example.com/direct" }],
        },
      ],
    });
    expect(result.text).toBe("direct output text");
    expect(result.annotationCitations).toEqual(["https://example.com/direct"]);
  });
});

describe("xai provider models", () => {
  it("publishes only current selectable chat models newest first", () => {
    expect(buildXaiCatalogModels().map((model) => model.id)).toEqual([
      "grok-4.5",
      "grok-build-0.1",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
    ]);
  });

  it("publishes Grok 4.5 with its current metadata", () => {
    expectCatalogEntry("grok-4.5", {
      id: "grok-4.5",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 500_000,
      maxTokens: 64_000,
      cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    });
  });

  it("resolves the Grok Build latest alias to Grok 4.5", () => {
    expectCatalogEntry("grok-build-latest", {
      id: "grok-4.5",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 500_000,
      maxTokens: 64_000,
      cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    });
  });

  it("keeps Grok 4.3 selectable with current bundled metadata", () => {
    const expected = {
      id: "grok-4.3",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    };
    expectCatalogEntry("grok-4.3", expected);
    expectCatalogEntry("grok-4.3-latest", expected);
    expectCatalogEntry("grok-latest", { ...expected, id: "grok-latest" });
    expectCatalogEntry("grok-4-latest", {
      ...expected,
      id: "grok-4-latest",
      input: ["text"],
    });
  });

  it("keeps retired Grok fast slugs resolving for compatibility", () => {
    expectCatalogEntry("grok-4-1-fast", {
      id: "grok-4-1-fast",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    });
  });

  it("resolves Grok Build and its official code aliases", () => {
    const expected = {
      id: "grok-build-0.1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 256_000,
      cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
    };
    expectCatalogEntry("grok-build-0.1", expected);
    expectCatalogEntry("grok-code-fast-1", expected);
    expectCatalogEntry("grok-code-fast", expected);
    expectCatalogEntry("grok-code-fast-1-0825", expected);
  });

  it("publishes Grok 4.20 reasoning and non-reasoning models", () => {
    expectCatalogEntry("grok-4.20-0309-reasoning", {
      id: "grok-4.20-0309-reasoning",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
    });
    expectCatalogEntry("grok-4.20-0309-non-reasoning", {
      id: "grok-4.20-0309-non-reasoning",
      reasoning: false,
      contextWindow: 1_000_000,
    });
  });

  it("keeps older Grok aliases resolving with current limits", () => {
    expectCatalogEntry("grok-4-1-fast-reasoning", {
      id: "grok-4-1-fast",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    });
    expectCatalogEntry("grok-4.20-reasoning", {
      id: "grok-4.20-reasoning",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 30_000,
    });
  });

  it("publishes the remaining Grok 3 family in the OpenClaw catalog", () => {
    expectCatalogEntry("grok-3-mini-fast", {
      id: "grok-3-mini-fast",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    });
    expectCatalogEntry("grok-3-fast", {
      id: "grok-3-fast",
      reasoning: false,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    });
    expectCatalogEntry("grok-3", {
      id: "grok-3",
      reasoning: false,
      input: ["text"],
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    });
  });

  it("marks current Grok families as modern while excluding multi-agent ids", () => {
    expect(isModernXaiModel("grok-4.5")).toBe(true);
    expect(isModernXaiModel("grok-4.3")).toBe(true);
    expect(isModernXaiModel("grok-build-0.1")).toBe(true);
    expect(isModernXaiModel("grok-4.20-0309-reasoning")).toBe(true);
    expect(isModernXaiModel("grok-build-latest")).toBe(true);
    expect(isModernXaiModel("grok-code-fast-1")).toBe(true);
    expect(isModernXaiModel("grok-3-mini-fast")).toBe(false);
    expect(isModernXaiModel("grok-4.20-multi-agent-experimental-beta-0304")).toBe(false);
  });

  it("builds forward-compatible runtime models for newer Grok ids", () => {
    const grok41 = resolveXaiForwardCompatModel({
      providerId: "xai",
      ctx: {
        provider: "xai",
        modelId: "grok-4-1-fast",
        modelRegistry: { find: () => null } as never,
        providerConfig: {
          api: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
        },
      },
    });
    const grok420 = resolveXaiForwardCompatModel({
      providerId: "xai",
      ctx: {
        provider: "xai",
        modelId: "grok-4.20-0309-reasoning",
        modelRegistry: { find: () => null } as never,
        providerConfig: {
          api: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
        },
      },
    });
    const grok43Alias = resolveXaiForwardCompatModel({
      providerId: "xai",
      ctx: {
        provider: "xai",
        modelId: "grok-4.3-latest",
        modelRegistry: { find: () => null } as never,
        providerConfig: {
          api: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
        },
      },
    });
    const grok45Alias = resolveXaiForwardCompatModel({
      providerId: "xai",
      ctx: {
        provider: "xai",
        modelId: "grok-4.5-latest",
        modelRegistry: { find: () => null } as never,
        providerConfig: {
          api: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
        },
      },
    });
    const grok3Mini = resolveXaiForwardCompatModel({
      providerId: "xai",
      ctx: {
        provider: "xai",
        modelId: "grok-3-mini-fast",
        modelRegistry: { find: () => null } as never,
        providerConfig: {
          api: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
        },
      },
    });

    expect(grok41?.provider).toBe("xai");
    expect(grok41?.id).toBe("grok-4-1-fast");
    expect(grok41?.api).toBe("openai-responses");
    expect(grok41?.baseUrl).toBe("https://api.x.ai/v1");
    expect(grok41?.reasoning).toBe(true);
    expect(grok41?.contextWindow).toBe(1_000_000);
    expect(grok41?.maxTokens).toBe(64_000);

    expect(grok45Alias?.provider).toBe("xai");
    expect(grok45Alias?.id).toBe("grok-4.5");
    expect(grok45Alias?.api).toBe("openai-responses");
    expect(grok45Alias?.baseUrl).toBe("https://api.x.ai/v1");
    expect(grok45Alias?.reasoning).toBe(true);
    expect(grok45Alias?.thinkingLevelMap).toEqual({
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
    });
    expect(grok45Alias?.input).toEqual(["text", "image"]);
    expect(grok45Alias?.contextWindow).toBe(500_000);
    expect(grok45Alias?.maxTokens).toBe(64_000);

    expect(grok43Alias?.provider).toBe("xai");
    expect(grok43Alias?.id).toBe("grok-4.3");
    expect(grok43Alias?.api).toBe("openai-responses");
    expect(grok43Alias?.baseUrl).toBe("https://api.x.ai/v1");
    expect(grok43Alias?.reasoning).toBe(true);
    expect(grok43Alias?.thinkingLevelMap).toEqual({
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
    });
    expect(grok43Alias?.input).toEqual(["text", "image"]);
    expect(grok43Alias?.contextWindow).toBe(1_000_000);
    expect(grok43Alias?.maxTokens).toBe(64_000);

    expect(grok420?.provider).toBe("xai");
    expect(grok420?.id).toBe("grok-4.20-0309-reasoning");
    expect(grok420?.api).toBe("openai-responses");
    expect(grok420?.baseUrl).toBe("https://api.x.ai/v1");
    expect(grok420?.reasoning).toBe(true);
    expect(grok420?.input).toEqual(["text", "image"]);
    expect(grok420?.contextWindow).toBe(1_000_000);
    expect(grok420?.maxTokens).toBe(30_000);

    expect(grok3Mini?.provider).toBe("xai");
    expect(grok3Mini?.id).toBe("grok-3-mini-fast");
    expect(grok3Mini?.api).toBe("openai-responses");
    expect(grok3Mini?.baseUrl).toBe("https://api.x.ai/v1");
    expect(grok3Mini?.reasoning).toBe(true);
    expect(grok3Mini?.contextWindow).toBe(1_000_000);
    expect(grok3Mini?.maxTokens).toBe(64_000);
  });

  it("refuses the unsupported multi-agent endpoint ids", () => {
    const model = resolveXaiForwardCompatModel({
      providerId: "xai",
      ctx: {
        provider: "xai",
        modelId: "grok-4.20-multi-agent-experimental-beta-0304",
        modelRegistry: { find: () => null } as never,
        providerConfig: {
          api: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
        },
      },
    });

    expect(model).toBeUndefined();
  });
});
