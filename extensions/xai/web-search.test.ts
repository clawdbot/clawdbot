import { createTestWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { withEnv, withEnvAsync, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveXaiCatalogEntry } from "./model-definitions.js";
import { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";
import { resolveFallbackXaiAuth } from "./src/tool-auth-shared.js";
import { wrapXaiWebSearchError } from "./src/web-search-shared.js";
import { __testing } from "./test-api.js";
import { createXaiWebSearchProvider } from "./web-search.js";

const {
  extractXaiWebSearchContent,
  resolveXaiInlineCitations,
  resolveXaiToolSearchConfig,
  resolveXaiWebSearchCredential,
  resolveXaiWebSearchModel,
  resolveXaiWebSearchTimeoutSeconds,
} = __testing;

function installXaiWebSearchFetch() {
  const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Grounded Grok answer" }],
            },
          ],
        }),
    } as Response),
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
});

describe("xai web search config resolution", () => {
  it("prefers configured api keys and resolves grok scoped defaults", () => {
    expect(resolveXaiWebSearchCredential({ grok: { apiKey: "xai-secret" } })).toBe("xai-secret");
    expect(resolveXaiWebSearchModel()).toBe("grok-4-1-fast");
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

  it("offers plugin-owned xSearch setup after Grok is selected", async () => {
    const provider = createXaiWebSearchProvider();
    const select = vi.fn().mockResolvedValueOnce("yes").mockResolvedValueOnce("grok-4-1-fast");
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
    expect(xSearch?.model).toBe("grok-4-1-fast");
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
    expect(resolveXaiWebSearchModel({})).toBe("grok-4-1-fast");
    expect(resolveXaiWebSearchModel(undefined)).toBe("grok-4-1-fast");
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

    await tool?.execute({ query: "OpenClaw Grok proxy test" });

    expect(firstFetchUrl(mockFetch)).toBe("https://api.x.ai/proxy/v1/responses");
  });

  it("normalizes deprecated grok 4.20 beta model ids to GA ids", () => {
    expect(
      resolveXaiWebSearchModel({
        grok: { model: "grok-4.20-experimental-beta-0304-reasoning" },
      }),
    ).toBe("grok-4.20-beta-latest-reasoning");
    expect(
      resolveXaiWebSearchModel({
        grok: { model: "grok-4.20-experimental-beta-0304-non-reasoning" },
      }),
    ).toBe("grok-4.20-beta-latest-non-reasoning");
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
    const payload = __testing.buildXaiWebSearchPayload({
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
  it("publishes Grok 4.3 as the default chat model", () => {
    expectCatalogEntry("grok-4.3", {
      id: "grok-4.3",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    });
  });

  it("publishes the newer Grok fast and code models in the bundled catalog", () => {
    expectCatalogEntry("grok-4-1-fast", {
      id: "grok-4-1-fast",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 2_000_000,
      maxTokens: 30_000,
    });
    expectCatalogEntry("grok-code-fast-1", {
      id: "grok-code-fast-1",
      reasoning: true,
      contextWindow: 256_000,
      maxTokens: 10_000,
    });
  });

  it("publishes Grok 4.20 reasoning and non-reasoning models", () => {
    expectCatalogEntry("grok-4.20-beta-latest-reasoning", {
      id: "grok-4.20-beta-latest-reasoning",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 2_000_000,
    });
    expectCatalogEntry("grok-4.20-beta-latest-non-reasoning", {
      id: "grok-4.20-beta-latest-non-reasoning",
      reasoning: false,
      contextWindow: 2_000_000,
    });
  });

  it("keeps older Grok aliases resolving with current limits", () => {
    expectCatalogEntry("grok-4-1-fast-reasoning", {
      id: "grok-4-1-fast-reasoning",
      reasoning: true,
      contextWindow: 2_000_000,
      maxTokens: 30_000,
    });
    expectCatalogEntry("grok-4.20-reasoning", {
      id: "grok-4.20-reasoning",
      reasoning: true,
      contextWindow: 2_000_000,
      maxTokens: 30_000,
    });
  });

  it("publishes the remaining Grok 3 family that Pi still carries", () => {
    expectCatalogEntry("grok-3-mini-fast", {
      id: "grok-3-mini-fast",
      reasoning: true,
      contextWindow: 131_072,
      maxTokens: 8_192,
    });
    expectCatalogEntry("grok-3-fast", {
      id: "grok-3-fast",
      reasoning: false,
      contextWindow: 131_072,
      maxTokens: 8_192,
    });
  });

  it("marks current Grok families as modern while excluding multi-agent ids", () => {
    expect(isModernXaiModel("grok-4.3")).toBe(true);
    expect(isModernXaiModel("grok-4.20-beta-latest-reasoning")).toBe(true);
    expect(isModernXaiModel("grok-code-fast-1")).toBe(true);
    expect(isModernXaiModel("grok-3-mini-fast")).toBe(true);
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
        modelId: "grok-4.20-beta-latest-reasoning",
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
    expect(grok41?.contextWindow).toBe(2_000_000);
    expect(grok41?.maxTokens).toBe(30_000);

    expect(grok43Alias?.provider).toBe("xai");
    expect(grok43Alias?.id).toBe("grok-4.3-latest");
    expect(grok43Alias?.api).toBe("openai-responses");
    expect(grok43Alias?.baseUrl).toBe("https://api.x.ai/v1");
    expect(grok43Alias?.reasoning).toBe(true);
    expect(grok43Alias?.thinkingLevelMap).toEqual({
      off: null,
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
    expect(grok420?.id).toBe("grok-4.20-beta-latest-reasoning");
    expect(grok420?.api).toBe("openai-responses");
    expect(grok420?.baseUrl).toBe("https://api.x.ai/v1");
    expect(grok420?.reasoning).toBe(true);
    expect(grok420?.input).toEqual(["text", "image"]);
    expect(grok420?.contextWindow).toBe(2_000_000);
    expect(grok420?.maxTokens).toBe(30_000);

    expect(grok3Mini?.provider).toBe("xai");
    expect(grok3Mini?.id).toBe("grok-3-mini-fast");
    expect(grok3Mini?.api).toBe("openai-responses");
    expect(grok3Mini?.baseUrl).toBe("https://api.x.ai/v1");
    expect(grok3Mini?.reasoning).toBe(true);
    expect(grok3Mini?.contextWindow).toBe(131_072);
    expect(grok3Mini?.maxTokens).toBe(8_192);
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
