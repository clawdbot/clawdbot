// Chutes tests cover models plugin behavior.
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChutesProvider, CHUTES_DEFAULT_MODEL_ID } from "./api.js";
import { CHUTES_MODEL_CATALOG, discoverChutesModels } from "./models.js";
import {
  applyChutesConfig,
  applyChutesProviderConfig,
  CHUTES_DEFAULT_MODEL_REF,
} from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const EXPECTED_STATIC_MODEL_IDS = [
  "deepseek-ai/DeepSeek-V3.2-TEE",
  "moonshotai/Kimi-K2.6-TEE",
  "moonshotai/Kimi-K2.5-TEE",
  "zai-org/GLM-5.2-TEE",
  "MiniMaxAI/MiniMax-M2.5-TEE",
  "Qwen/Qwen3.6-27B-TEE",
  "Qwen/Qwen3.5-397B-A17B-TEE",
];

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

async function withLiveChutesDiscovery<T>(
  fetchMock: ReturnType<typeof vi.fn>,
  run: () => Promise<T>,
): Promise<T> {
  vi.stubGlobal("fetch", fetchMock);

  try {
    return await run();
  } finally {
    vi.unstubAllGlobals();
  }
}

function readAuthorizationHeader(init?: { headers?: HeadersInit }): string {
  const headers = init?.headers;
  if (headers instanceof Headers) {
    return headers.get("Authorization") ?? "";
  }
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === "authorization")?.[1] ?? "";
  }
  return headers?.Authorization ?? headers?.authorization ?? "";
}

function requireChutesModel(
  models: Awaited<ReturnType<typeof discoverChutesModels>>,
  index: number,
): Awaited<ReturnType<typeof discoverChutesModels>>[number] {
  const model = models[index];
  if (!model) {
    throw new Error(`expected Chutes model at index ${index}`);
  }
  return model;
}

describe("chutes-models", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("keeps image-capable fallback models in the runtime catalog", () => {
    const visionModelIds = ["moonshotai/Kimi-K2.6-TEE", "Qwen/Qwen3.6-27B-TEE"];
    for (const id of visionModelIds) {
      const model = CHUTES_MODEL_CATALOG.find((candidate) => candidate.id === id);
      expect(model).toBeDefined();
      if (!model) {
        throw new Error(`expected ${id}`);
      }
      expect(model.input).toContain("image");
    }
  });

  it.each(["default", "merge", "replace"] as const)(
    "keeps catalog ownership, defaults, and aliases aligned in %s mode",
    (mode) => {
      const manifestIds = manifest.modelCatalog.providers.chutes.models.map((model) => model.id);
      const runtimeIds = CHUTES_MODEL_CATALOG.map((model) => model.id);
      expect(manifestIds).toEqual(EXPECTED_STATIC_MODEL_IDS);
      expect(runtimeIds).toEqual(EXPECTED_STATIC_MODEL_IDS);
      expect(
        CHUTES_MODEL_CATALOG.every((model) => model.compat?.supportsUsageInStreaming === false),
      ).toBe(true);
      expect(CHUTES_DEFAULT_MODEL_ID).toBe(manifest.modelCatalog.providers.chutes.defaultModel);
      expect(manifest.modelCatalog.providers.chutes.defaultModel).toBe("zai-org/GLM-5.2-TEE");
      expect(
        manifest.modelCatalog.providers.chutes.models
          .filter((model) => "status" in model && model.status === "deprecated")
          .map((model) => ({ id: model.id, replacedBy: model.replacedBy })),
      ).toEqual([
        {
          id: "moonshotai/Kimi-K2.5-TEE",
          replacedBy: "moonshotai/Kimi-K2.6-TEE",
        },
        {
          id: "Qwen/Qwen3.5-397B-A17B-TEE",
          replacedBy: "Qwen/Qwen3.6-27B-TEE",
        },
      ]);

      const miniMax = manifest.modelCatalog.providers.chutes.models.find(
        (model) => model.id === "MiniMaxAI/MiniMax-M2.5-TEE",
      );
      expect(miniMax).toBeDefined();
      expect(miniMax).not.toHaveProperty("status");
      expect(miniMax).not.toHaveProperty("replacedBy");

      const cfg = applyChutesConfig(mode === "default" ? {} : { models: { mode } });
      expect(cfg.models?.mode).toBe(mode === "replace" ? "replace" : "merge");
      expect(cfg.models?.providers?.chutes?.models.map((model) => model.id)).toEqual(
        mode === "replace" ? EXPECTED_STATIC_MODEL_IDS : [],
      );
      if (mode === "replace") {
        expect(cfg.models?.providers?.chutes?.models).toEqual(CHUTES_MODEL_CATALOG);
      }
      expect(cfg.agents?.defaults?.model).toEqual({
        primary: CHUTES_DEFAULT_MODEL_REF,
        fallbacks: ["chutes/deepseek-ai/DeepSeek-V3.2-TEE", "chutes/moonshotai/Kimi-K2.6-TEE"],
      });
      expect(cfg.agents?.defaults?.imageModel).toEqual({
        primary: "chutes/moonshotai/Kimi-K2.6-TEE",
        fallbacks: ["chutes/Qwen/Qwen3.6-27B-TEE"],
      });
      expect(cfg.agents?.defaults?.models?.["chutes-fast"]).toBeUndefined();
      expect(cfg.agents?.defaults?.models?.["chutes-pro"]?.alias).toBe(
        "chutes/deepseek-ai/DeepSeek-V3.2-TEE",
      );
      expect(cfg.agents?.defaults?.models?.["chutes-vision"]?.alias).toBe(
        "chutes/moonshotai/Kimi-K2.6-TEE",
      );
      expect(Object.keys(cfg.agents?.defaults?.models ?? {}).toSorted()).toEqual(
        [
          ...EXPECTED_STATIC_MODEL_IDS.map((id) => `chutes/${id}`),
          "chutes-pro",
          "chutes-vision",
        ].toSorted(),
      );
      const catalogBackedTargets = [
        CHUTES_DEFAULT_MODEL_REF,
        "chutes/deepseek-ai/DeepSeek-V3.2-TEE",
        "chutes/moonshotai/Kimi-K2.6-TEE",
        "chutes/Qwen/Qwen3.6-27B-TEE",
      ];
      expect(
        catalogBackedTargets.every((modelRef) =>
          runtimeIds.includes(modelRef.slice("chutes/".length)),
        ),
      ).toBe(true);
    },
  );

  it.each([
    { label: "zero", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { label: "custom", cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 } },
  ])(
    "preserves authored $label prices, aliases, and selections without adding merge-mode pins",
    ({ cost }) => {
      const config = applyChutesProviderConfig({});
      const [seed] = CHUTES_MODEL_CATALOG;
      if (!seed) {
        throw new Error("expected a Chutes seed model");
      }
      const model = { ...structuredClone(seed), id: "fixture-provider/authored-model", cost };
      config.models!.providers!.chutes!.models = [model];
      config.models!.providers!.chutes!.apiKey = "fixture-key";
      config.agents!.defaults!.model = {
        primary: "chutes/fixture-provider/authored-model",
        fallbacks: ["fixture-provider/fallback"],
      };
      config.agents!.defaults!.imageModel = {
        primary: "fixture-provider/image-model",
        fallbacks: ["fixture-provider/image-fallback"],
      };
      config.agents!.defaults!.models!["chutes/fixture-provider/authored-model"] = {
        alias: "My authored model",
      };
      config.agents!.defaults!.models!["chutes-pro"] = { alias: "My pro alias" };

      const reapplied = applyChutesProviderConfig(config);

      expect(reapplied.models?.providers?.chutes?.models).toEqual([model]);
      expect(reapplied.models?.providers?.chutes?.apiKey).toBe("fixture-key");
      expect(reapplied.agents?.defaults).toEqual(config.agents?.defaults);
    },
  );

  it("preserves native per-million prices and exact zero rates during discovery", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: "fixture-provider/zero-input",
            pricing: { prompt: 0, completion: 0.2, input_cache_read: 0 },
          },
          {
            id: "new-provider/new-model-r1",
            supported_features: ["reasoning"],
            input_modalities: ["text", "image"],
            context_length: 200000,
            max_output_length: 16384,
            pricing: { prompt: 0.1, completion: 0.2, input_cache_read: 0.05 },
          },
          {
            id: "fixture-provider/free-model",
            pricing: { prompt: 0, completion: 0, input_cache_read: 0 },
          },
        ],
      }),
    );
    await withLiveChutesDiscovery(mockFetch, async () => {
      const models = await discoverChutesModels("test-token-real-fetch");
      expect(models).toHaveLength(3);
      const firstModel = requireChutesModel(models, 0);
      const secondModel = requireChutesModel(models, 1);
      expect(firstModel).toMatchObject({
        id: "fixture-provider/zero-input",
        cost: { input: 0, output: 0.2, cacheRead: 0, cacheWrite: 0 },
      });
      expect(requireChutesModel(models, 2).cost).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      expect(secondModel).toMatchObject({
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200000,
        maxTokens: 16384,
      });
      expect(secondModel.cost).toEqual({
        input: 0.1,
        output: 0.2,
        cacheRead: 0.05,
        cacheWrite: 0,
      });
      if (!secondModel.compat) {
        throw new Error("expected Chutes API model compat");
      }
      expect(secondModel.compat.supportsUsageInStreaming).toBe(false);
    });
  });

  it.each([
    { label: "absent pricing", pricing: undefined },
    { label: "missing prompt", pricing: { completion: 0.2 } },
    { label: "missing completion", pricing: { prompt: 0.1 } },
    { label: "negative prompt", pricing: { prompt: -0.1, completion: 0.2 } },
    { label: "null completion", pricing: { prompt: 0.1, completion: null } },
    { label: "string prompt", pricing: { prompt: "0.1", completion: 0.2 } },
    {
      label: "invalid cache rate",
      pricing: { prompt: 0.1, completion: 0.2, input_cache_read: -0.05 },
    },
  ])("keeps an unknown runtime price, not partial paid rates, for $label", async ({ pricing }) => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [{ id: "fixture-provider/unpriced-model", pricing }],
      }),
    );

    await withLiveChutesDiscovery(mockFetch, async () => {
      const models = await discoverChutesModels("fixture-pricing-token");
      expect(models).toHaveLength(1);
      expect(requireChutesModel(models, 0)).toMatchObject({
        id: "fixture-provider/unpriced-model",
        // Runtime requires a complete cost; this existing placeholder is not proof of free billing.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsUsageInStreaming: false },
      });
    });
  });

  it("selects Chutes context limits in provider precedence order", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: "provider/context-primary",
            context_length: 131072,
            max_model_len: 262144,
          },
          { id: "provider/serving-fallback", max_model_len: 131072 },
          {
            id: "provider/invalid-primary",
            context_length: -1,
            max_model_len: 131072,
          },
          {
            id: "provider/default-control",
            context_length: 0,
            max_model_len: 0,
          },
        ],
      }),
    );

    await withLiveChutesDiscovery(mockFetch, async () => {
      const models = await discoverChutesModels("context-limit-precedence");
      expect(models.map(({ id, contextWindow }) => ({ id, contextWindow }))).toEqual([
        { id: "provider/context-primary", contextWindow: 131072 },
        { id: "provider/serving-fallback", contextWindow: 131072 },
        { id: "provider/invalid-primary", contextWindow: 131072 },
        { id: "provider/default-control", contextWindow: 128000 },
      ]);
    });
  });

  it("falls back from malformed live token metadata", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: "provider/bad-window",
            context_length: -1,
            max_output_length: 16384.5,
          },
          {
            id: "provider/bad-max-output",
            context_length: Number.POSITIVE_INFINITY,
            max_output_length: 0,
          },
        ],
      }),
    );

    await withLiveChutesDiscovery(mockFetch, async () => {
      const models = await discoverChutesModels("malformed-token-metadata");

      expect(requireChutesModel(models, 0)).toMatchObject({
        id: "provider/bad-window",
        contextWindow: 128000,
        maxTokens: 4096,
      });
      expect(requireChutesModel(models, 1)).toMatchObject({
        id: "provider/bad-max-output",
        contextWindow: 128000,
        maxTokens: 4096,
      });
    });
  });

  it("propagates uncached discovery failures", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 503 }));

    await withLiveChutesDiscovery(mockFetch, async () => {
      await expect(
        discoverChutesModels("chutes-fallback-token", { discoveryMode: "strict" }),
      ).rejects.toMatchObject({
        status: 503,
      });
      await expect(buildChutesProvider("chutes-fallback-token")).resolves.toMatchObject({
        models: CHUTES_MODEL_CATALOG,
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  it("scopes discovery cache by access token", async () => {
    const mockFetch = vi.fn().mockImplementation((_url, init?: { headers?: HeadersInit }) => {
      const auth = readAuthorizationHeader(init);
      if (auth === "Bearer chutes-token-a") {
        return Promise.resolve(
          jsonResponse({
            data: [{ id: "private/model-a" }],
          }),
        );
      }
      if (auth === "Bearer chutes-token-b") {
        return Promise.resolve(
          jsonResponse({
            data: [{ id: "private/model-b" }],
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          data: [{ id: "public/model" }],
        }),
      );
    });
    await withLiveChutesDiscovery(mockFetch, async () => {
      const modelsA = await discoverChutesModels("chutes-token-a");
      const modelsB = await discoverChutesModels("chutes-token-b");
      const modelsASecond = await discoverChutesModels("chutes-token-a");
      expect(requireChutesModel(modelsA, 0).id).toBe("private/model-a");
      expect(requireChutesModel(modelsB, 0).id).toBe("private/model-b");
      expect(requireChutesModel(modelsASecond, 0).id).toBe("private/model-a");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  it("does not replace rejected account discovery with an anonymous catalog", async () => {
    const mockFetch = vi.fn().mockImplementation((_url, init?: { headers?: HeadersInit }) => {
      if (readAuthorizationHeader(init) === "Bearer failed-token") {
        return Promise.resolve(new Response("", { status: 401 }));
      }
      return Promise.resolve(
        jsonResponse({
          data: [{ id: "public/model" }],
        }),
      );
    });
    await withLiveChutesDiscovery(mockFetch, async () => {
      await expect(
        discoverChutesModels("failed-token", { discoveryMode: "strict" }),
      ).rejects.toMatchObject({ status: 401 });
      await expect(buildChutesProvider("failed-token")).resolves.toMatchObject({
        models: [{ id: "public/model" }],
      });
      expect(mockFetch.mock.calls.map(([, init]) => readAuthorizationHeader(init))).toEqual([
        "Bearer failed-token",
        "Bearer failed-token",
        "",
      ]);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });
});
