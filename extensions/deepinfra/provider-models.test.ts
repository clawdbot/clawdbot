import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEEPINFRA_DEFAULT_MODEL_REF,
  DEEPINFRA_MODELS_URL,
  discoverDeepInfraModels,
  resetDeepInfraModelCacheForTest,
} from "./provider-models.js";

beforeEach(() => {
  resetDeepInfraModelCacheForTest();
});

function makeModelEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "openai/gpt-oss-120b",
    object: "model",
    owned_by: "deepinfra",
    metadata: {
      context_length: 131072,
      max_tokens: 65536,
      pricing: {
        input_tokens: 3,
        output_tokens: 15,
        cache_read_tokens: 0.3,
      },
      tags: ["vision", "reasoning_effort", "prompt_cache", "reasoning"],
    },
    ...overrides,
  };
}

async function withFetchPathTest(
  mockFetch: ReturnType<typeof vi.fn>,
  runAssertions: () => Promise<void>,
) {
  const origNodeEnv = process.env.NODE_ENV;
  const origVitest = process.env.VITEST;
  delete process.env.NODE_ENV;
  delete process.env.VITEST;
  vi.stubGlobal("fetch", mockFetch);

  try {
    await runAssertions();
  } finally {
    if (origNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = origNodeEnv;
    }
    if (origVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = origVitest;
    }
    vi.unstubAllGlobals();
  }
}

describe("discoverDeepInfraModels", () => {
  it("returns static catalog in test environment", async () => {
    const models = await discoverDeepInfraModels();
    expect(DEEPINFRA_DEFAULT_MODEL_REF).toBe("deepinfra/deepseek-ai/DeepSeek-V3.2");
    expect(models.some((m) => m.id === "deepseek-ai/DeepSeek-V3.2")).toBe(true);
    expect(models.every((m) => m.compat?.supportsUsageInStreaming)).toBe(true);
  });

  it("fetches DeepInfra's curated LLM catalog and parses model metadata", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeModelEntry()] }),
    });

    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      expect(mockFetch).toHaveBeenCalledWith(
        DEEPINFRA_MODELS_URL,
        expect.objectContaining({
          headers: { Accept: "application/json" },
        }),
      );
      expect(models).toEqual([
        expect.objectContaining({
          id: "openai/gpt-oss-120b",
          name: "openai/gpt-oss-120b",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 131072,
          maxTokens: 65536,
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
          compat: expect.objectContaining({ supportsUsageInStreaming: true }),
        }),
      ]);
    });
  });

  it("skips non-LLM rows without metadata and deduplicates ids", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { id: "BAAI/bge-m3", object: "model", metadata: null },
            makeModelEntry(),
            makeModelEntry(),
          ],
        }),
    });

    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      expect(models.map((m) => m.id)).toEqual(["openai/gpt-oss-120b"]);
    });
  });

  it("uses fallback defaults for sparse metadata", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            makeModelEntry({
              id: "some/model",
              metadata: { tags: [], pricing: {} },
            }),
          ],
        }),
    });

    await withFetchPathTest(mockFetch, async () => {
      const [model] = await discoverDeepInfraModels();
      expect(model).toMatchObject({
        id: "some/model",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    });
  });

  it("falls back to the static catalog on network errors", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));

    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      expect(models.some((m) => m.id === "deepseek-ai/DeepSeek-V3.2")).toBe(true);
    });
  });

  it("caches successful discovery responses only", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [makeModelEntry({ id: "first/model" })] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [makeModelEntry({ id: "second/model" })] }),
      });

    await withFetchPathTest(mockFetch, async () => {
      expect((await discoverDeepInfraModels()).map((m) => m.id)).toEqual(["first/model"]);
      expect((await discoverDeepInfraModels()).map((m) => m.id)).toEqual(["first/model"]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
