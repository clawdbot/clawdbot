import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASETEN_DEFAULT_MODEL_REF,
  BASETEN_MODEL_CATALOG,
  buildStaticBasetenModels,
  discoverBasetenModels,
  projectBasetenLiveModels,
  resolveBasetenDynamicModel,
} from "./models.js";

const TEST_VALUE = "fixture";

describe("Baseten model catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("ships every current Baseten Model API with Inkling as the default", () => {
    const models = buildStaticBasetenModels();

    expect(BASETEN_DEFAULT_MODEL_REF).toBe("baseten/thinkingmachines/inkling");
    expect(models).toHaveLength(12);
    expect(models.map((model) => model.id)).toEqual(BASETEN_MODEL_CATALOG.map((model) => model.id));
    expect(models.find((model) => model.id === "thinkingmachines/inkling")).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_048_000,
      maxTokens: 32_000,
      cost: { input: 1, output: 4.05, cacheRead: 0.17, cacheWrite: 0 },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsUsageInStreaming: true,
        supportsStrictMode: true,
        supportsTools: true,
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
        maxTokensField: "max_tokens",
      },
    });
  });

  it("projects authenticated live rows while retaining curated capability metadata", () => {
    const models = projectBasetenLiveModels([
      {
        id: "thinkingmachines/inkling",
        object: "model",
        name: "Inkling live",
        context_length: 1_048_576,
        max_completion_tokens: 32_768,
        pricing: {
          prompt: "0.0000011",
          completion: "0.0000042",
          input_cache_read: "0.00000018",
        },
        supported_features: ["vision", "reasoning", "reasoning_effort"],
      },
      {
        id: "future/model",
        object: "model",
        context_length: 64_000,
        max_completion_tokens: 4_000,
        pricing: { prompt: 0.0000002, completion: 0.0000008, input_cache_read: 0.00000004 },
        supported_features: ["vision", "reasoning_effort"],
      },
      { id: "future/model", object: "model" },
      { id: "ignored", object: "not-a-model" },
    ]);

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "thinkingmachines/inkling",
      name: "Inkling live",
      contextWindow: 1_048_576,
      maxTokens: 32_768,
      cost: { input: 1.1, output: 4.2, cacheRead: 0.18, cacheWrite: 0 },
      compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    });
    expect(models[1]).toMatchObject({
      id: "future/model",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 64_000,
      maxTokens: 4_000,
      cost: { input: 0.2, output: 0.8, cacheRead: 0.04, cacheWrite: 0 },
      compat: {
        supportsReasoningEffort: true,
        supportsTools: true,
        supportsStrictMode: true,
      },
    });
  });

  it("uses live capability metadata when present and curated metadata when absent", () => {
    const liveCapabilities = projectBasetenLiveModels([
      {
        id: "thinkingmachines/inkling",
        object: "model",
        supported_features: [],
      },
    ])[0];
    const curatedCapabilities = projectBasetenLiveModels([
      {
        id: "thinkingmachines/inkling",
        object: "model",
      },
    ])[0];

    expect(liveCapabilities).toMatchObject({ reasoning: false, input: ["text"] });
    expect(liveCapabilities?.compat?.supportsReasoningEffort).toBeUndefined();
    expect(liveCapabilities?.compat?.supportedReasoningEfforts).toBeUndefined();
    expect(liveCapabilities?.compat?.reasoningEffortMap).toBeUndefined();
    expect(curatedCapabilities).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      compat: { supportsReasoningEffort: true },
    });
  });

  it("keeps discovery offline without resolved auth", async () => {
    await expect(discoverBasetenModels()).resolves.toHaveLength(12);
  });

  it("authenticates live discovery and does not cache unusable rows", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi
      .fn()
      .mockImplementationOnce(async () => ({
        response: Response.json({ data: [{ object: "not-a-model" }] }),
        finalUrl: "https://inference.baseten.co/v1/models",
        release,
      }))
      .mockImplementationOnce(async () => ({
        response: Response.json({
          data: [
            {
              id: "thinkingmachines/inkling",
              object: "model",
              context_length: 1_048_576,
              max_completion_tokens: 32_768,
              supported_features: ["vision", "reasoning", "reasoning_effort"],
            },
          ],
        }),
        finalUrl: "https://inference.baseten.co/v1/models",
        release,
      }));

    await expect(
      discoverBasetenModels({
        discoveryApiKey: TEST_VALUE,
        forceLive: true,
        fetchGuard,
      }),
    ).resolves.toHaveLength(12);
    await expect(
      discoverBasetenModels({
        discoveryApiKey: TEST_VALUE,
        forceLive: true,
        fetchGuard,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "thinkingmachines/inkling",
        contextWindow: 1_048_576,
        maxTokens: 32_768,
      }),
    ]);

    expect(fetchGuard).toHaveBeenCalledTimes(2);
    const headers = vi.mocked(fetchGuard).mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    if (!(headers instanceof Headers)) {
      throw new Error("expected fetch headers");
    }
    expect(headers.get("Authorization")).toBe(`Bearer ${TEST_VALUE}`);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("resolves future model ids without shadowing bundled rows", () => {
    expect(resolveBasetenDynamicModel("thinkingmachines/inkling")).toBeUndefined();
    expect(resolveBasetenDynamicModel("future/model")).toMatchObject({
      id: "future/model",
      provider: "baseten",
      api: "openai-completions",
      baseUrl: "https://inference.baseten.co/v1",
      compat: { supportsTools: true, maxTokensField: "max_tokens" },
    });
  });
});
