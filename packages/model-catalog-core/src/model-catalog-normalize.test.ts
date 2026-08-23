// Model Catalog Core tests cover model catalog normalize behavior.
import { describe, expect, it } from "vitest";
import { normalizeModelCatalog, normalizeModelCatalogProviderRows } from "./index.js";
import { buildModelCatalogMergeKey, buildModelCatalogRef } from "./model-catalog-refs.js";

describe("model catalog normalization", () => {
  it("normalizes catalog ownership, aliases, suppressions, and row fields", () => {
    const catalog = normalizeModelCatalog(
      {
        providers: {
          OpenAI: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            headers: {
              "x-provider": "openai",
            },
            defaultModel: " gpt-5.4 ",
            defaultUtilityModel: " gpt-5.6-luna ",
            models: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                api: "openai-completions",
                baseUrl: "https://proxy.example/v1",
                headers: {
                  "x-model": "gpt-5.4",
                },
                input: ["text", "image", "document", "audio"],
                reasoning: true,
                contextWindow: 256000,
                contextWindows: [
                  { id: "1m", label: " 1M ", contextWindow: 1_000_000 },
                  { id: "invalid", label: "Invalid", contextWindow: 0 },
                  { id: "200k", label: " 200K ", contextWindow: 200_000 },
                ],
                contextWindowDefault: " 1m ",
                contextTokens: 200000,
                maxTokens: 128000,
                thinkingLevelMap: {
                  off: null,
                  minimal: " low ",
                  max: "max",
                  adaptive: "high",
                },
                cost: {
                  input: 1.25,
                  output: 10,
                  cacheRead: 0.125,
                  tieredPricing: [
                    {
                      input: 1.25,
                      output: 10,
                      cacheRead: 0.125,
                      cacheWrite: 1.25,
                      range: [0, 256000],
                    },
                    {
                      input: 1,
                      output: 2,
                      range: [0, 1000],
                    },
                  ],
                },
                compat: {
                  supportsTools: true,
                  codeMode: " preferred ",
                  openRouterRouting: {
                    only: [" anthropic ", "", 1],
                    allow_fallbacks: false,
                    require_parameters: "no",
                  },
                  vercelGatewayRouting: {
                    order: [" anthropic ", "", 1],
                    only: "openai",
                  },
                  zaiToolStream: true,
                  cacheControlFormat: "anthropic",
                  sendSessionAffinityHeaders: true,
                  sendSessionIdHeader: false,
                  supportsEagerToolInputStreaming: false,
                  supportsLongCacheRetention: true,
                  supportsJsonSchemaResponseFormat: true,
                  requiresReasoningContentOnAssistantMessages: true,
                  supportsStore: "yes",
                  thinkingFormat: "together",
                  unknownFlag: true,
                },
                status: "preview",
                statusReason: "rolling out",
                replaces: [" gpt-5.3 ", ""],
                replacedBy: "gpt-5.5",
                tags: [" default ", ""],
              },
              {
                id: "",
              },
            ],
          },
          anthropic: {
            models: [{ id: "claude-sonnet-4.6" }],
          },
        },
        aliases: {
          "Azure-OpenAI-Responses": {
            provider: "OpenAI",
            api: "azure-openai-responses",
          },
          "anthropic-alias": {
            provider: "anthropic",
          },
        },
        suppressions: [
          {
            provider: "Azure-OpenAI-Responses",
            model: "gpt-5.3-codex-spark",
            reason: "not available",
            when: {
              baseUrlHosts: ["CODING-INTL.DASHSCOPE.ALIYUNCS.COM"],
              providerConfigApiIn: ["Qwen", "ModelStudio"],
            },
          },
        ],
        discovery: {
          OpenAI: "static",
          anthropic: "static",
          bad: "unknown",
        },
        runtimeAugment: true,
      },
      { ownedProviders: new Set(["OpenAI"]) },
    );

    expect(catalog).toEqual({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          headers: {
            "x-provider": "openai",
          },
          defaultModel: "gpt-5.4",
          defaultUtilityModel: "gpt-5.6-luna",
          models: [
            {
              id: "gpt-5.4",
              name: "GPT-5.4",
              api: "openai-completions",
              baseUrl: "https://proxy.example/v1",
              headers: {
                "x-model": "gpt-5.4",
              },
              input: ["text", "image", "document"],
              reasoning: true,
              contextWindow: 256000,
              contextWindows: [
                { id: "200k", label: "200K", contextWindow: 200_000 },
                { id: "1m", label: "1M", contextWindow: 1_000_000 },
              ],
              contextWindowDefault: "1m",
              contextTokens: 200000,
              maxTokens: 128000,
              thinkingLevelMap: { off: null, minimal: "low", max: "max" },
              cost: {
                input: 1.25,
                output: 10,
                cacheRead: 0.125,
                tieredPricing: [
                  {
                    input: 1.25,
                    output: 10,
                    cacheRead: 0.125,
                    cacheWrite: 1.25,
                    range: [0, 256000],
                  },
                ],
              },
              compat: {
                supportsTools: true,
                codeMode: "preferred",
                openRouterRouting: { only: ["anthropic"], allow_fallbacks: false },
                vercelGatewayRouting: { order: ["anthropic"] },
                zaiToolStream: true,
                cacheControlFormat: "anthropic",
                sendSessionAffinityHeaders: true,
                sendSessionIdHeader: false,
                supportsEagerToolInputStreaming: false,
                supportsLongCacheRetention: true,
                supportsJsonSchemaResponseFormat: true,
                requiresReasoningContentOnAssistantMessages: true,
                thinkingFormat: "together",
              },
              status: "preview",
              statusReason: "rolling out",
              replaces: ["gpt-5.3"],
              replacedBy: "gpt-5.5",
              tags: ["default"],
            },
          ],
        },
      },
      aliases: {
        "azure-openai-responses": {
          provider: "openai",
          api: "azure-openai-responses",
        },
      },
      suppressions: [
        {
          provider: "azure-openai-responses",
          model: "gpt-5.3-codex-spark",
          reason: "not available",
          when: {
            baseUrlHosts: ["coding-intl.dashscope.aliyuncs.com"],
            providerConfigApiIn: ["qwen", "modelstudio"],
          },
        },
      ],
      discovery: {
        openai: "static",
      },
      runtimeAugment: true,
    });
  });

  it("builds normalized rows with provider defaults and stable refs", () => {
    const rows = normalizeModelCatalogProviderRows({
      provider: "OpenAI",
      providerCatalog: {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
        headers: {
          "x-provider": "openai",
        },
        models: [
          {
            id: "GPT-5.4",
            headers: {
              "x-model": "gpt-5.4",
            },
            input: ["image"],
          },
        ],
      },
      source: "manifest",
    });

    expect(rows).toEqual([
      {
        provider: "openai",
        id: "GPT-5.4",
        ref: "openai/GPT-5.4",
        mergeKey: "openai::gpt-5.4",
        name: "GPT-5.4",
        source: "manifest",
        input: ["image"],
        reasoning: false,
        status: "available",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        headers: {
          "x-provider": "openai",
          "x-model": "gpt-5.4",
        },
      },
    ]);
    expect(buildModelCatalogRef("OpenAI", "GPT-5.4")).toBe("openai/GPT-5.4");
    expect(buildModelCatalogMergeKey("OpenAI", "GPT-5.4")).toBe("openai::gpt-5.4");
  });

  it("normalizes complete provider routing, pricing, reasoning, and image limits", () => {
    const tier = { input: 0, output: 2, cacheRead: 0, cacheWrite: 1, range: [128] };
    const catalog = normalizeModelCatalog(
      {
        providers: {
          OpenAI: {
            models: [
              {
                id: " gpt-5.4 ",
                headers: Object.fromEntries([
                  ["x-safe", " value "],
                  ["__proto__", "polluted"],
                  ["constructor", "polluted"],
                  ["prototype", "polluted"],
                ]),
                cost: {
                  input: 0,
                  output: 2,
                  cacheWrite: 1,
                  tieredPricing: [tier, { ...tier, range: [-1] }, { input: 1, range: [0, 2] }],
                },
                mediaInput: {
                  image: {
                    maxBytes: 4096,
                    maxPixels: 1024,
                    maxSidePx: 64,
                    preferredSidePx: 32,
                    tokenMode: "tile",
                  },
                },
                compat: {
                  supportsPromptCacheKey: true,
                  toolSchemaProfile: " strict ",
                  toolCallArgumentsEncoding: " json ",
                  visibleReasoningDetailTypes: [" summary ", ""],
                  supportedReasoningEfforts: [" low ", " high "],
                  unsupportedToolSchemaKeywords: [" pattern ", ""],
                  reasoningEffortMap: { " low ": " minimal ", empty: "  " },
                  maxTokensField: "max_completion_tokens",
                  thinkingFormat: "openrouter",
                  openRouterRouting: {
                    allow_fallbacks: false,
                    require_parameters: true,
                    data_collection: "deny",
                    zdr: true,
                    enforce_distillable_text: true,
                    order: [" openai ", ""],
                    only: [" anthropic "],
                    ignore: [" bad "],
                    quantizations: [" fp8 "],
                    sort: { by: " throughput ", partition: null },
                    max_price: { prompt: " 0.5 ", completion: 2, image: 0, audio: 3, request: 4 },
                    preferred_min_throughput: { p50: 10, p75: 20, p90: 30, p99: 40 },
                    preferred_max_latency: 1,
                  },
                  vercelGatewayRouting: { only: [" openai "], order: [" anthropic "] },
                },
              },
            ],
          },
        },
      },
      { ownedProviders: new Set([" OpenAI "]) },
    );

    expect(catalog?.providers?.openai?.models).toEqual([
      {
        id: "gpt-5.4",
        headers: { "x-safe": "value" },
        cost: { input: 0, output: 2, cacheWrite: 1, tieredPricing: [tier] },
        mediaInput: {
          image: {
            maxBytes: 4096,
            maxPixels: 1024,
            maxSidePx: 64,
            preferredSidePx: 32,
            tokenMode: "tile",
          },
        },
        compat: {
          supportsPromptCacheKey: true,
          toolSchemaProfile: "strict",
          toolCallArgumentsEncoding: "json",
          visibleReasoningDetailTypes: ["summary"],
          supportedReasoningEfforts: ["low", "high"],
          unsupportedToolSchemaKeywords: ["pattern"],
          reasoningEffortMap: { low: "minimal" },
          maxTokensField: "max_completion_tokens",
          thinkingFormat: "openrouter",
          openRouterRouting: {
            allow_fallbacks: false,
            require_parameters: true,
            data_collection: "deny",
            zdr: true,
            enforce_distillable_text: true,
            order: ["openai"],
            only: ["anthropic"],
            ignore: ["bad"],
            quantizations: ["fp8"],
            sort: { by: "throughput", partition: null },
            max_price: { prompt: "0.5", completion: 2, image: 0, audio: 3, request: 4 },
            preferred_min_throughput: { p50: 10, p75: 20, p90: 30, p99: 40 },
            preferred_max_latency: 1,
          },
          vercelGatewayRouting: { only: ["openai"], order: ["anthropic"] },
        },
      },
    ]);
  });

  it.each([
    { name: "non-record catalog", value: null },
    { name: "unowned provider", value: { providers: { anthropic: { models: [{ id: "x" }] } } } },
    { name: "missing model id", value: { providers: { openai: { models: [{ id: "  " }] } } } },
    { name: "unowned alias", value: { aliases: { alias: { provider: "anthropic" } } } },
    { name: "invalid suppression", value: { suppressions: [{ provider: "openai" }] } },
    { name: "unknown discovery", value: { discovery: { openai: "unknown" } } },
  ])("rejects a $name instead of publishing an empty catalog", ({ value }) => {
    expect(normalizeModelCatalog(value, { ownedProviders: new Set(["openai"]) })).toBeUndefined();
  });

  it("sorts provider rows and drops invalid models while preserving model overrides", () => {
    expect(
      normalizeModelCatalogProviderRows({
        provider: " OpenAI ",
        providerCatalog: {
          headers: { "x-provider": " default ", "x-override": " old " },
          models: [
            { id: "z-model", headers: { "x-override": " new " } },
            { id: "  " },
            { id: "a-model", mediaInput: { image: { tokenMode: "detail", maxBytes: 1 } } },
          ],
        },
        source: "runtime-refresh",
      }),
    ).toMatchObject([
      {
        id: "a-model",
        provider: "openai",
        input: ["text"],
        reasoning: false,
        status: "available",
        mediaInput: { image: { tokenMode: "detail", maxBytes: 1 } },
      },
      { id: "z-model", headers: { "x-provider": "default", "x-override": "new" } },
    ]);
  });

  it("bounds selectable context windows and keeps the default inside the cap", () => {
    const contextWindows = Array.from({ length: 20 }, (_, index) => ({
      id: `window-${index}`,
      label: `Window ${index}`,
      contextWindow: 20 - index,
    }));
    const [row] = normalizeModelCatalogProviderRows({
      provider: "example",
      providerCatalog: {
        models: [{ id: "model", contextWindows, contextWindowDefault: "window-3" }],
      },
      source: "manifest",
    });

    expect(row?.contextWindows).toHaveLength(16);
    expect(row?.contextWindows?.map((option) => option.contextWindow)).toEqual([
      5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(row?.contextWindowDefault).toBe("window-3");
  });

  it.each([
    { name: "an omitted default", contextWindowDefault: undefined },
    { name: "an undeclared default", contextWindowDefault: "missing" },
    { name: "a default dropped by the option cap", contextWindowDefault: "window-19" },
  ])("drops the selection tuple with $name", ({ contextWindowDefault }) => {
    const contextWindows = Array.from({ length: 20 }, (_, index) => ({
      id: `window-${index}`,
      label: `Window ${index}`,
      contextWindow: 20 - index,
    }));
    const [row] = normalizeModelCatalogProviderRows({
      provider: "example",
      providerCatalog: {
        models: [
          {
            id: "model",
            contextWindows,
            ...(contextWindowDefault ? { contextWindowDefault } : {}),
          },
        ],
      },
      source: "manifest",
    });

    // Options without a selectable default would render no picker control, so
    // the normalized row must drop the whole tuple, not just the default.
    expect(row?.contextWindows).toBeUndefined();
    expect(row?.contextWindowDefault).toBeUndefined();
  });
});
