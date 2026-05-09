import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChutesModelDefinition,
  CHUTES_MODEL_CATALOG,
  clearChutesModelCacheForTests,
  discoverChutesModels,
} from "./models.js";

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
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
  return vi.fn().mockImplementation((_url, init?: { headers?: Record<string, string> }) => {
    const auth = init?.headers?.Authorization ?? "";
    return Promise.resolve({
      ok: true,
      json: async () => ({
        data: [{ id: auth ? `${auth}-model` : "public-model" }],
      }),
    });
  });
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
    clearChutesModelCacheForTests();
  });

  it("buildChutesModelDefinition returns config with required fields", () => {
    const entry = CHUTES_MODEL_CATALOG[0];
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

  it("discoverChutesModels returns static catalog when accessToken is empty", async () => {
    const models = await discoverChutesModels("");
    expect(models).toHaveLength(CHUTES_MODEL_CATALOG.length);
    expect(models.map((m) => m.id)).toEqual(CHUTES_MODEL_CATALOG.map((m) => m.id));
  });

  it("discoverChutesModels returns static catalog in test env by default", async () => {
    const models = await discoverChutesModels("test-token");
    expect(models).toHaveLength(CHUTES_MODEL_CATALOG.length);
    expect(requireChutesModel(models, 0).id).toBe("Qwen/Qwen3-32B");
  });

  it("discoverChutesModels correctly maps API response when not in test env", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "zai-org/GLM-4.7-TEE" },
          {
            id: "new-provider/new-model-r1",
            supported_features: ["reasoning"],
            input_modalities: ["text", "image"],
            context_length: 200000,
            max_output_length: 16384,
            pricing: { prompt: 0.1, completion: 0.2 },
          },
          { id: "new-provider/simple-model" },
        ],
      }),
    });
    await withLiveChutesDiscovery(mockFetch, async () => {
      const models = await discoverChutesModels("test-token-real-fetch");
      expect(models.length).toBeGreaterThan(0);
      if (models.length === 3) {
        const firstModel = requireChutesModel(models, 0);
        const secondModel = requireChutesModel(models, 1);
        expect(firstModel.id).toBe("zai-org/GLM-4.7-TEE");
        expect(secondModel.reasoning).toBe(true);
        if (!secondModel.compat) {
          throw new Error("expected Chutes API model compat");
        }
        expect(secondModel.compat.supportsUsageInStreaming).toBe(false);
      }
    });
  });

  it("discoverChutesModels retries without auth on 401", async () => {
    const mockFetch = vi.fn().mockImplementation((url, init) => {
      if (init?.headers?.Authorization === "Bearer test-token-error") {
        return Promise.resolve({
          ok: false,
          status: 401,
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "Qwen/Qwen3-32B",
              name: "Qwen/Qwen3-32B",
              supported_features: ["reasoning"],
              input_modalities: ["text"],
              context_length: 40960,
              max_output_length: 40960,
              pricing: { prompt: 0.08, completion: 0.24 },
            },
            {
              id: "unsloth/Mistral-Nemo-Instruct-2407",
              name: "unsloth/Mistral-Nemo-Instruct-2407",
              input_modalities: ["text"],
              context_length: 131072,
              max_output_length: 131072,
              pricing: { prompt: 0.02, completion: 0.04 },
            },
            {
              id: "deepseek-ai/DeepSeek-V3-0324-TEE",
              name: "deepseek-ai/DeepSeek-V3-0324-TEE",
              supported_features: ["reasoning"],
              input_modalities: ["text"],
              context_length: 131072,
              max_output_length: 65536,
              pricing: { prompt: 0.28, completion: 0.42 },
            },
          ],
        }),
      });
    });
    await withLiveChutesDiscovery(mockFetch, async () => {
      const models = await discoverChutesModels("test-token-error");
      expect(models.length).toBeGreaterThan(0);
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  it("caches fallback static catalog for non-OK responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    await withLiveChutesDiscovery(mockFetch, async () => {
      const first = await discoverChutesModels("chutes-fallback-token");
      const second = await discoverChutesModels("chutes-fallback-token");
      expect(first.map((m) => m.id)).toEqual(CHUTES_MODEL_CATALOG.map((m) => m.id));
      expect(second.map((m) => m.id)).toEqual(CHUTES_MODEL_CATALOG.map((m) => m.id));
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  it("scopes discovery cache by access token", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation((_url, init?: { headers?: Record<string, string> }) => {
        const auth = init?.headers?.Authorization;
        if (auth === "Bearer chutes-token-a") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              data: [{ id: "private/model-a" }],
            }),
          });
        }
        if (auth === "Bearer chutes-token-b") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              data: [{ id: "private/model-b" }],
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: [{ id: "public/model" }],
          }),
        });
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
    const mockFetch = vi
      .fn()
      .mockImplementation((_url, init?: { headers?: Record<string, string> }) => {
        if (init?.headers?.Authorization === "Bearer failed-token") {
          return Promise.resolve({
            ok: false,
            status: 401,
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: [{ id: "public/model" }],
          }),
        });
      });
    await withLiveChutesDiscovery(mockFetch, async () => {
      await discoverChutesModels("failed-token");
      await discoverChutesModels("failed-token");
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });
});
