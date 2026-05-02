import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelKey } from "../agents/model-selection.js";
import type { normalizeProviderModelIdWithRuntime } from "../agents/provider-model-normalization.runtime.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";

const normalizeProviderModelIdWithRuntimeMock = vi.hoisted(() =>
  vi.fn<typeof normalizeProviderModelIdWithRuntime>(({ context }) => context.modelId),
);
const pluginManifestRegistryMocks = vi.hoisted(() => ({
  manifestRegistry: undefined as PluginManifestRegistry | undefined,
  loadPluginManifestRegistryForInstalledIndex: vi.fn(),
  listOpenClawPluginManifestMetadata: vi.fn(),
}));

vi.mock("../agents/provider-model-normalization.runtime.js", () => {
  return { normalizeProviderModelIdWithRuntime: normalizeProviderModelIdWithRuntimeMock };
});

vi.mock("../plugins/manifest-registry-installed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/manifest-registry-installed.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForInstalledIndex: (
      params: Parameters<typeof actual.loadPluginManifestRegistryForInstalledIndex>[0],
    ) => {
      pluginManifestRegistryMocks.loadPluginManifestRegistryForInstalledIndex(params);
      return (
        pluginManifestRegistryMocks.manifestRegistry ??
        actual.loadPluginManifestRegistryForInstalledIndex(params)
      );
    },
  };
});

vi.mock("../plugins/manifest-metadata-scan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/manifest-metadata-scan.js")>();
  return {
    ...actual,
    listOpenClawPluginManifestMetadata: (
      params?: Parameters<typeof actual.listOpenClawPluginManifestMetadata>[0],
    ) => {
      pluginManifestRegistryMocks.listOpenClawPluginManifestMetadata(params);
      return actual.listOpenClawPluginManifestMetadata(params);
    },
  };
});

import {
  __resetGatewayModelPricingCacheForTest,
  collectConfiguredModelPricingRefs,
  getCachedGatewayModelPricing,
  refreshGatewayModelPricingCache,
  startGatewayModelPricingRefresh,
} from "./model-pricing-cache.js";

describe("model-pricing-cache", () => {
  beforeEach(() => {
    __resetGatewayModelPricingCacheForTest();
    pluginManifestRegistryMocks.manifestRegistry = undefined;
    pluginManifestRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockClear();
    pluginManifestRegistryMocks.listOpenClawPluginManifestMetadata.mockClear();
    normalizeProviderModelIdWithRuntimeMock.mockClear();
  });

  afterEach(() => {
    __resetGatewayModelPricingCacheForTest();
    loggingState.rawConsole = null;
    resetLogger();
  });

  it("collects configured model refs across defaults, aliases, overrides, and media tools", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "gpt", fallbacks: ["anthropic/claude-sonnet-4-6"] },
          imageModel: { primary: "google/gemini-3-pro" },
          compaction: { model: "opus" },
          heartbeat: { model: "xai/grok-4" },
          models: {
            "openai/gpt-5.4": { alias: "gpt" },
            "anthropic/claude-opus-4-6": { alias: "opus" },
          },
        },
        list: [
          {
            id: "router",
            model: { primary: "openrouter/anthropic/claude-opus-4-6" },
            subagents: { model: { primary: "openrouter/auto" } },
            heartbeat: { model: "anthropic/claude-opus-4-6" },
          },
        ],
      },
      channels: {
        modelByChannel: {
          slack: {
            C123: "gpt",
          },
        },
      },
      hooks: {
        gmail: { model: "anthropic/claude-opus-4-6" },
        mappings: [{ model: "zai/glm-5" }],
      },
      tools: {
        subagents: { model: { primary: "anthropic/claude-haiku-4-5" } },
        media: {
          models: [{ provider: "google", model: "gemini-2.5-pro" }],
          image: {
            models: [{ provider: "xai", model: "grok-4" }],
          },
        },
      },
      messages: {
        tts: {
          summaryModel: "openai/gpt-5.4",
        },
      },
    } as unknown as OpenClawConfig;

    const refs = collectConfiguredModelPricingRefs(config).map((ref) =>
      modelKey(ref.provider, ref.model),
    );

    expect(refs).toEqual(
      expect.arrayContaining([
        "openai/gpt-5.4",
        "anthropic/claude-sonnet-4-6",
        "google/gemini-3-pro-preview",
        "anthropic/claude-opus-4-6",
        "xai/grok-4",
        "openrouter/anthropic/claude-opus-4-6",
        "openrouter/auto",
        "zai/glm-5",
        "anthropic/claude-haiku-4-5",
        "google/gemini-2.5-pro",
      ]),
    );
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("collects manifest-owned web search plugin model refs without a hardcoded plugin list", () => {
    const refs = collectConfiguredModelPricingRefs({
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                model: "tavily/search-preview",
              },
            },
          },
        },
      },
    } as OpenClawConfig).map((ref) => modelKey(ref.provider, ref.model));

    expect(refs).toContain("tavily/search-preview");
  });

  it("uses one installed manifest pass for pricing policies and configured web-search refs", async () => {
    pluginManifestRegistryMocks.manifestRegistry = {
      diagnostics: [],
      plugins: [
        createManifestRecord({
          id: "search-plugin",
          contracts: { webSearchProviders: ["search-plugin"] },
        }),
      ],
    };
    const config = {
      plugins: {
        entries: {
          "search-plugin": {
            config: {
              webSearch: {
                model: "local-search/search-model",
              },
            },
          },
        },
      },
      models: {
        providers: {
          "local-search": {
            baseUrl: "http://127.0.0.1:43210/v1",
            api: "openai-completions",
            models: [{ id: "search-model" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const fetchImpl = vi.fn<typeof fetch>();

    await refreshGatewayModelPricingCache({ config, fetchImpl });

    expect(
      pluginManifestRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
    ).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses a provided metadata registry view without rebuilding manifest metadata", async () => {
    const manifestRegistry = {
      diagnostics: [],
      plugins: [
        createManifestRecord({
          id: "search-plugin",
          contracts: { webSearchProviders: ["search-plugin"] },
        }),
      ],
    };
    const config = {
      plugins: {
        entries: {
          "search-plugin": {
            config: {
              webSearch: {
                model: "local-search/search-model",
              },
            },
          },
        },
      },
      models: {
        providers: {
          "local-search": {
            baseUrl: "http://127.0.0.1:43210/v1",
            api: "openai-completions",
            models: [
              {
                id: "search-model",
                cost: { input: 0.2, output: 0.4 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const fetchImpl = vi.fn<typeof fetch>();

    await refreshGatewayModelPricingCache({
      config,
      fetchImpl,
      pluginMetadataSnapshot: {
        index: {
          plugins: [
            {
              pluginId: "search-plugin",
              origin: "global",
              enabled: true,
              enabledByDefault: true,
            },
          ],
        } as never,
        manifestRegistry,
      },
    });

    expect(
      pluginManifestRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
    ).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      getCachedGatewayModelPricing({ provider: "local-search", model: "search-model" }),
    ).toEqual({
      input: 0.2,
      output: 0.4,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("does not load plugin manifests for pricing when plugins are globally disabled", async () => {
    const config = {
      plugins: {
        enabled: false,
        entries: {
          "search-plugin": {
            config: {
              webSearch: {
                model: "local-search/search-model",
              },
            },
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "custom/gpt-local" },
        },
      },
      models: {
        providers: {
          custom: {
            baseUrl: "https://models.example/v1",
            api: "openai-completions",
            models: [
              {
                id: "gpt-local",
                cost: { input: 0.12, output: 0.48 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const fetchImpl = vi.fn<typeof fetch>();

    await refreshGatewayModelPricingCache({ config, fetchImpl });

    expect(
      pluginManifestRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
    ).not.toHaveBeenCalled();
    expect(pluginManifestRegistryMocks.listOpenClawPluginManifestMetadata).not.toHaveBeenCalled();
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getCachedGatewayModelPricing({ provider: "custom", model: "gpt-local" })).toEqual({
      input: 0.12,
      output: 0.48,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("skips remote pricing catalogs for local-only model providers", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "ollama/llama3.2:latest" },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [{ id: "llama3.2:latest" }],
          },
          "my-local-gpu": {
            baseUrl: "http://192.168.1.25:8000/v1",
            api: "openai-completions",
            models: [{ id: "qwen2.5-coder:7b" }],
          },
        },
      },
      tools: {
        subagents: { model: { primary: "my-local-gpu/qwen2.5-coder:7b" } },
      },
    } as unknown as OpenClawConfig;
    const fetchImpl = vi.fn<typeof fetch>();

    await refreshGatewayModelPricingCache({ config, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      getCachedGatewayModelPricing({ provider: "ollama", model: "llama3.2:latest" }),
    ).toBeUndefined();
  });

  it("seeds pricing from explicit configured model cost without external catalog fetches", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "custom/gpt-local" },
        },
      },
      models: {
        providers: {
          custom: {
            baseUrl: "https://models.example/v1",
            api: "openai-completions",
            models: [
              {
                id: "gpt-local",
                name: "GPT Local",
                reasoning: false,
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 8192,
                cost: { input: 0.12, output: 0.48, cacheRead: 0.01, cacheWrite: 0.02 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const fetchImpl = vi.fn<typeof fetch>();

    await refreshGatewayModelPricingCache({ config, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getCachedGatewayModelPricing({ provider: "custom", model: "gpt-local" })).toEqual({
      input: 0.12,
      output: 0.48,
      cacheRead: 0.01,
      cacheWrite: 0.02,
    });
  });

  it("loads openrouter pricing and maps provider aliases, wrappers, and anthropic dotted ids", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
        list: [
          {
            id: "router",
            model: { primary: "openrouter/anthropic/claude-sonnet-4-6" },
          },
        ],
      },
      tools: {
        subagents: { model: { primary: "zai/glm-openrouter-test" } },
      },
    } as unknown as OpenClawConfig;

    const fetchImpl = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("openrouter.ai")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "anthropic/claude-opus-4.6",
                pricing: {
                  prompt: "0.000005",
                  completion: "0.000025",
                  input_cache_read: "0.0000005",
                  input_cache_write: "0.00000625",
                },
              },
              {
                id: "anthropic/claude-sonnet-4.6",
                pricing: {
                  prompt: "0.000003",
                  completion: "0.000015",
                  input_cache_read: "0.0000003",
                },
              },
              {
                id: "z-ai/glm-openrouter-test",
                pricing: {
                  prompt: "0.000001",
                  completion: "0.000004",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      // LiteLLM — return empty object (no tiered pricing for these models)
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await refreshGatewayModelPricingCache({ config, fetchImpl });

    expect(
      getCachedGatewayModelPricing({ provider: "anthropic", model: "claude-opus-4-6" }),
    ).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
    expect(
      getCachedGatewayModelPricing({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4-6",
      }),
    ).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 0,
    });
    expect(getCachedGatewayModelPricing({ provider: "zai", model: "glm-openrouter-test" })).toEqual(
      {
        input: 1,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
      },
    );
  });

  it("does not recurse forever for native openrouter auto refs", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openrouter/auto" },
        },
      },
    } as unknown as OpenClawConfig;

    const fetchImpl = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("openrouter.ai")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "openrouter/auto",
                pricing: {
                  prompt: "0.000001",
                  completion: "0.000002",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(refreshGatewayModelPricingCache({ config, fetchImpl })).resolves.toBeUndefined();
    expect(
      getCachedGatewayModelPricing({ provider: "openrouter", model: "openrouter/auto" }),
    ).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("loads tiered pricing from LiteLLM and merges with OpenRouter flat pricing", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "volcengine/doubao-seed-2-0-pro" },
        },
      },
    } as unknown as OpenClawConfig;

    const fetchImpl = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("openrouter.ai")) {
        // OpenRouter does not have this model
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // LiteLLM catalog
      return new Response(
        JSON.stringify({
          "volcengine/doubao-seed-2-0-pro": {
            input_cost_per_token: 4.6e-7,
            output_cost_per_token: 2.3e-6,
            cache_creation_input_token_cost: 9.2e-7,
            litellm_provider: "volcengine",
            tiered_pricing: [
              {
                input_cost_per_token: 4.6e-7,
                output_cost_per_token: 2.3e-6,
                cache_creation_input_token_cost: 9.2e-8,
                range: [0, 32000],
              },
              {
                input_cost_per_token: 7e-7,
                output_cost_per_token: 3.5e-6,
                cache_creation_input_token_cost: 1.4e-7,
                range: [32000, 128000],
              },
              {
                input_cost_per_token: 1.4e-6,
                output_cost_per_token: 7e-6,
                cache_creation_input_token_cost: 2.8e-7,
                range: [128000, 256000],
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    await refreshGatewayModelPricingCache({ config, fetchImpl });

    const pricing = getCachedGatewayModelPricing({
      provider: "volcengine",
      model: "doubao-seed-2-0-pro",
    });

    expect(pricing).toBeDefined();
    expect(pricing!.input).toBeCloseTo(0.46);
    expect(pricing!.output).toBeCloseTo(2.3);
    expect(pricing!.cacheWrite).toBeCloseTo(0.92);
    expect(pricing!.tieredPricing).toHaveLength(3);
    expect(pricing!.tieredPricing![0]).toEqual({
      input: expect.closeTo(0.46),
      output: expect.closeTo(2.3),
      cacheRead: 0,
      cacheWrite: expect.closeTo(0.092),
      range: [0, 32000],
    });
    expect(pricing!.tieredPricing![2].cacheWrite).toBeCloseTo(0.28);
    expect(pricing!.tieredPricing![2].range).toEqual([128000, 256000]);
  });

  it("normalizes LiteLLM open-ended range [start] to [start, Infinity]", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "volcengine/doubao-open" },
        },
      },
    } as unknown as OpenClawConfig;

    const fetchImpl = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("openrouter.ai")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          "volcengine/doubao-open": {
            input_cost_per_token: 4.6e-7,
            output_cost_per_token: 2.3e-6,
            litellm_provider: "volcengine",
            tiered_pricing: [
              {
                input_cost_per_token: 4.6e-7,
                output_cost_per_token: 2.3e-6,
                range: [0, 32000],
              },
              {
                input_cost_per_token: 7e-7,
                output_cost_per_token: 3.5e-6,
                cache_creation_input_token_cost: 1.4e-7,
                range: [32000],
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    await refreshGatewayModelPricingCache({ config, fetchImpl });

    const pricing = getCachedGatewayModelPricing({
      provider: "volcengine",
      model: "doubao-open",
    });

    expect(pricing).toBeDefined();
    expect(pricing!.tieredPricing).toHaveLength(2);
    expect(pricing!.tieredPricing![0].range).toEqual([0, 32000]);
    expect(pricing!.tieredPricing![1].range).toEqual([32000, Infinity]);
    expect(pricing!.tieredPricing![1].cacheWrite).toBeCloseTo(0.14);
  });

  it("merges OpenRouter flat pricing with LiteLLM tiered pricing", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "dashscope/qwen-plus" },
        },
      },
    } as unknown as OpenClawConfig;

    const fetchImpl = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("openrouter.ai")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "dashscope/qwen-plus",
                pricing: {
                  prompt: "0.0000004",
                  completion: "0.0000024",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          "dashscope/qwen-plus": {
            input_cost_per_token: 4e-7,
            output_cost_per_token: 2.4e-6,
            litellm_provider: "dashscope",
            tiered_pricing: [
              {
                input_cost_per_token: 4e-7,
                output_cost_per_token: 2.4e-6,
                cache_creation_input_token_cost: 8e-8,
                range: [0, 256000],
              },
              {
                input_cost_per_token: 5e-7,
                output_cost_per_token: 3e-6,
                cache_creation_input_token_cost: 1e-7,
                range: [256000, 1000000],
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    await refreshGatewayModelPricingCache({ config, fetchImpl });

    const pricing = getCachedGatewayModelPricing({
      provider: "dashscope",
      model: "qwen-plus",
    });

    expect(pricing).toBeDefined();
    // OpenRouter base flat pricing is used
    expect(pricing!.input).toBeCloseTo(0.4);
    expect(pricing!.output).toBeCloseTo(2.4);
    // LiteLLM tiered pricing is merged in
    expect(pricing!.tieredPricing).toHaveLength(2);
    expect(pricing!.tieredPricing![1].range).toEqual([256000, 1000000]);
    expect(pricing!.tieredPricing![1].cacheWrite).toBeCloseTo(0.1);
  });

  it("falls back gracefully when LiteLLM fetch fails", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    } as unknown as OpenClawConfig;

    const fetchImpl = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("openrouter.ai")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "anthropic/claude-opus-4.6",
                pricing: {
                  prompt: "0.000005",
                  completion: "0.000025",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      // LiteLLM fails
      return new Response("Internal Server Error", { status: 500 });
    });

    await refreshGatewayModelPricingCache({ config, fetchImpl });

    // OpenRouter pricing still works
    expect(
      getCachedGatewayModelPricing({ provider: "anthropic", model: "claude-opus-4-6" }),
    ).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("defers bootstrap refresh work until after the starter returns", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    } as unknown as OpenClawConfig;
    const fetchImpl = withFetchPreconnect(
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("openrouter.ai")) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const stop = startGatewayModelPricingRefresh({ config, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.dynamicImportSettled();
    expect(fetchImpl).toHaveBeenCalled();
    stop();
  });

  it("aborts in-flight bootstrap pricing fetches after stop", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    } as unknown as OpenClawConfig;
    const abortedUrls: string[] = [];
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchImpl = withFetchPreconnect(
      vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const signal = init?.signal;
            expect(signal).toBeDefined();
            signal?.addEventListener(
              "abort",
              () => {
                abortedUrls.push(url);
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      ),
    );

    try {
      const stop = startGatewayModelPricingRefresh({ config, fetchImpl });

      await vi.dynamicImportSettled();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      stop();
      await vi.waitFor(() => expect(abortedUrls).toHaveLength(2));
      await vi.dynamicImportSettled();

      expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 24 * 60 * 60_000)).toBe(false);
      expect(
        getCachedGatewayModelPricing({ provider: "anthropic", model: "claude-opus-4-6" }),
      ).toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("does not bootstrap remote pricing when pricing is disabled", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openrouter/moonshotai/kimi-k2.5" },
        },
      },
      models: { pricing: { enabled: false } },
    } as unknown as OpenClawConfig;
    const fetchImpl = withFetchPreconnect(vi.fn());

    const stop = startGatewayModelPricingRefresh({ config, fetchImpl });

    await vi.dynamicImportSettled();
    expect(fetchImpl).not.toHaveBeenCalled();
    stop();
  });

  it("does not refresh remote pricing when pricing is disabled", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openrouter/moonshotai/kimi-k2.5" },
        },
      },
      models: { pricing: { enabled: false } },
    } as unknown as OpenClawConfig;
    const fetchImpl = withFetchPreconnect(vi.fn());

    await refreshGatewayModelPricingCache({ config, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("logs configured timeout seconds when pricing fetches time out", async () => {
    const warnings: string[] = [];
    loggingState.rawConsole = {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn((message: string) => warnings.push(message)),
      error: vi.fn(),
    };
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });

    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    } as unknown as OpenClawConfig;
    const timeoutError = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    const fetchImpl = withFetchPreconnect(async () => {
      throw timeoutError;
    });

    await refreshGatewayModelPricingCache({ config, fetchImpl });

    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "OpenRouter pricing fetch failed (timeout 60s): TimeoutError: The operation was aborted due to timeout",
        ),
        expect.stringContaining(
          "LiteLLM pricing fetch failed (timeout 60s): TimeoutError: The operation was aborted due to timeout",
        ),
      ]),
    );
  });

  it("treats oversized LiteLLM catalog responses as source failures", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "kimi/kimi-k2.6" },
        },
      },
    } as unknown as OpenClawConfig;

    const fetchImpl = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("openrouter.ai")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "moonshotai/kimi-k2.6",
                pricing: {
                  prompt: "0.00000095",
                  completion: "0.000004",
                  input_cache_read: "0.00000016",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response("{}", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "6000000",
        },
      });
    });

    await refreshGatewayModelPricingCache({ config, fetchImpl });

    expect(getCachedGatewayModelPricing({ provider: "kimi", model: "kimi-k2.6" })).toEqual({
      input: 0.95,
      output: 4,
      cacheRead: 0.16,
      cacheWrite: 0,
    });
  });
});

function createManifestRecord(overrides: Partial<PluginManifestRecord>): PluginManifestRecord {
  return {
    id: "plugin",
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "global",
    rootDir: "/tmp/plugin",
    source: "/tmp/plugin/index.js",
    manifestPath: "/tmp/plugin/openclaw.plugin.json",
    ...overrides,
  };
}
