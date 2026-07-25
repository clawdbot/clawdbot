// Chutes tests cover models plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChutesModelDefinition,
  CHUTES_DEFAULT_MODEL_REF,
  CHUTES_MODEL_CATALOG,
  discoverChutesModels,
} from "./models.js";
import { applyChutesConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const EXPECTED_STATIC_MODEL_IDS = [
  "deepseek-ai/DeepSeek-V3.2-TEE",
  "moonshotai/Kimi-K2.5-TEE",
  "zai-org/GLM-5-TEE",
  "MiniMaxAI/MiniMax-M2.5-TEE",
  "Qwen/Qwen3.5-397B-A17B-TEE",
];

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

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
  options?: { now?: string },
): Promise<T> {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldVitest = process.env.VITEST;
  delete process.env.NODE_ENV;
  delete process.env.VITEST;
  if (options?.now) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(options.now));
  }
  vi.stubGlobal("fetch", fetchMock);

  try {
    return await run();
  } finally {
    restoreEnvVar("NODE_ENV", oldNodeEnv);
    restoreEnvVar("VITEST", oldVitest);
    vi.unstubAllGlobals();
    if (options?.now) {
      vi.useRealTimers();
    }
  }
}

function createAuthEchoFetchMock() {
  return vi.fn().mockImplementation((_url, init?: { headers?: HeadersInit }) => {
    const auth = readAuthorizationHeader(init);
    return Promise.resolve(
      jsonResponse({
        data: [{ id: auth ? `${auth}-model` : "public-model" }],
      }),
    );
  });
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

  it("buildChutesModelDefinition returns config with required fields", () => {
    const entry = expectDefined(CHUTES_MODEL_CATALOG[0], "first Chutes catalog model");
    const def = buildChutesModelDefinition(entry);
    expect(def.id).toBe(entry.id);
    expect(def.name).toBe(entry.name);
    expect(def.reasoning).toBe(entry.reasoning);
    expect(def.input).toEqual(entry.input);
    expect(def.cost).toEqual(entry.cost);
    expect(def.contextWindow).toBe(entry.contextWindow);
    expect(def.maxTokens).toBe(entry.maxTokens);
    if (!def.compat) {
      throw new Error("expected Chutes model compat");
    }
    expect(def.compat.supportsUsageInStreaming).toBe(false);
  });

  it("keeps image-capable fallback models in the runtime catalog", () => {
    const visionModelIds = ["moonshotai/Kimi-K2.5-TEE", "Qwen/Qwen3.5-397B-A17B-TEE"];
    for (const id of visionModelIds) {
      const model = CHUTES_MODEL_CATALOG.find((candidate) => candidate.id === id);
      expect(model).toBeDefined();
      if (!model) {
        throw new Error(`expected ${id}`);
      }
      expect(buildChutesModelDefinition(model).input).toContain("image");
    }
  });

  it("keeps manifest, runtime catalog, defaults, and aliases aligned", () => {
    const manifestIds = manifest.modelCatalog.providers.chutes.models.map((model) => model.id);
    const runtimeIds = CHUTES_MODEL_CATALOG.map((model) => model.id);
    expect(manifestIds).toEqual(EXPECTED_STATIC_MODEL_IDS);
    expect(runtimeIds).toEqual(EXPECTED_STATIC_MODEL_IDS);

    const cfg = applyChutesConfig({});
    expect(cfg.models?.providers?.chutes?.models.map((model) => model.id)).toEqual(
      EXPECTED_STATIC_MODEL_IDS,
    );
    expect(cfg.agents?.defaults?.model).toEqual({
      primary: CHUTES_DEFAULT_MODEL_REF,
      fallbacks: ["chutes/deepseek-ai/DeepSeek-V3.2-TEE", "chutes/moonshotai/Kimi-K2.5-TEE"],
    });
    expect(cfg.agents?.defaults?.imageModel).toEqual({
      primary: "chutes/moonshotai/Kimi-K2.5-TEE",
      fallbacks: ["chutes/Qwen/Qwen3.5-397B-A17B-TEE"],
    });
    expect(cfg.agents?.defaults?.models?.["chutes-fast"]).toBeUndefined();
    expect(cfg.agents?.defaults?.models?.["chutes-pro"]?.alias).toBe(
      "chutes/deepseek-ai/DeepSeek-V3.2-TEE",
    );
    expect(cfg.agents?.defaults?.models?.["chutes-vision"]?.alias).toBe(
      "chutes/moonshotai/Kimi-K2.5-TEE",
    );
    const configuredTargets = [
      CHUTES_DEFAULT_MODEL_REF,
      "chutes/deepseek-ai/DeepSeek-V3.2-TEE",
      "chutes/moonshotai/Kimi-K2.5-TEE",
      "chutes/Qwen/Qwen3.5-397B-A17B-TEE",
    ];
    expect(
      configuredTargets.every((modelRef) => runtimeIds.includes(modelRef.slice("chutes/".length))),
    ).toBe(true);
  });

  it("discoverChutesModels returns static catalog when accessToken is empty", async () => {
    const models = await discoverChutesModels("");
    expect(models).toHaveLength(CHUTES_MODEL_CATALOG.length);
    expect(models.map((m) => m.id)).toEqual(CHUTES_MODEL_CATALOG.map((m) => m.id));
  });

  it("discoverChutesModels returns static catalog in test env by default", async () => {
    const models = await discoverChutesModels("test-token");
    expect(models).toHaveLength(CHUTES_MODEL_CATALOG.length);
    expect(requireChutesModel(models, 0).id).toBe("deepseek-ai/DeepSeek-V3.2-TEE");
  });

  it("discoverChutesModels correctly maps API response when not in test env", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { id: "zai-org/GLM-5-TEE" },
          {
            id: "new-provider/new-model-r1",
            supported_features: ["reasoning"],
            input_modalities: ["text", "image"],
            context_length: 200000,
            max_output_length: 16384,
            pricing: { prompt: 0.1, completion: 0.2, input_cache_read: 0.05 },
          },
          { id: "new-provider/simple-model" },
        ],
      }),
    );
    await withLiveChutesDiscovery(mockFetch, async () => {
      const models = await discoverChutesModels("test-token-real-fetch");
      expect(models.length).toBeGreaterThan(0);
      if (models.length === 3) {
        const firstModel = requireChutesModel(models, 0);
        const secondModel = requireChutesModel(models, 1);
        expect(firstModel.id).toBe("zai-org/GLM-5-TEE");
        expect(secondModel.reasoning).toBe(true);
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
      }
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

  it("discoverChutesModels retries without auth on 401", async () => {
    const mockFetch = vi.fn().mockImplementation((_url, init?: { headers?: HeadersInit }) => {
      if (readAuthorizationHeader(init) === "Bearer test-token-error") {
        return Promise.resolve(new Response("", { status: 401 }));
      }
      return Promise.resolve(
        jsonResponse({
          data: [
            {
              id: "Qwen/Qwen3-32B-TEE",
              name: "Qwen/Qwen3-32B-TEE",
              supported_features: ["reasoning"],
              input_modalities: ["text"],
              context_length: 40960,
              max_output_length: 40960,
              pricing: { prompt: 0.104, completion: 0.416 },
            },
            {
              id: "unsloth/Mistral-Nemo-Instruct-2407-TEE",
              name: "unsloth/Mistral-Nemo-Instruct-2407-TEE",
              input_modalities: ["text"],
              context_length: 131072,
              max_output_length: 131072,
              pricing: { prompt: 0.0245, completion: 0.0978 },
            },
            {
              id: "zai-org/GLM-5.2-TEE",
              name: "zai-org/GLM-5.2-TEE",
              supported_features: ["reasoning"],
              input_modalities: ["text"],
              context_length: 1048576,
              max_output_length: 65535,
              pricing: { prompt: 1.4, completion: 4.4 },
            },
          ],
        }),
      );
    });
    await withLiveChutesDiscovery(mockFetch, async () => {
      const models = await discoverChutesModels("test-token-error");
      expect(models.length).toBeGreaterThan(0);
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  it("does not cache fallback static catalog for non-OK responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 503 }));

    await withLiveChutesDiscovery(mockFetch, async () => {
      const first = await discoverChutesModels("chutes-fallback-token");
      const second = await discoverChutesModels("chutes-fallback-token");
      expect(first.map((m) => m.id)).toEqual(CHUTES_MODEL_CATALOG.map((m) => m.id));
      expect(second.map((m) => m.id)).toEqual(CHUTES_MODEL_CATALOG.map((m) => m.id));
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

  it("evicts oldest token entries when cache reaches max size", async () => {
    const mockFetch = createAuthEchoFetchMock();

    await withLiveChutesDiscovery(mockFetch, async () => {
      for (let i = 0; i < 150; i += 1) {
        await discoverChutesModels(`cache-token-${i}`);
      }

      await discoverChutesModels("cache-token-0");
      expect(mockFetch).toHaveBeenCalledTimes(151);
    });
  });

  it("prunes expired token cache entries during subsequent discovery", async () => {
    const mockFetch = createAuthEchoFetchMock();

    await withLiveChutesDiscovery(
      mockFetch,
      async () => {
        await discoverChutesModels("token-a");
        vi.advanceTimersByTime(5 * 60 * 1000 + 1);
        await discoverChutesModels("token-b");
        await discoverChutesModels("token-a");
        expect(mockFetch).toHaveBeenCalledTimes(3);
      },
      { now: "2026-03-01T00:00:00.000Z" },
    );
  });

  it("does not cache 401 fallback under the failed token key", async () => {
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
      await discoverChutesModels("failed-token");
      await discoverChutesModels("failed-token");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });
});
