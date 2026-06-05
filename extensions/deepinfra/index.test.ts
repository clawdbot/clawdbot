// Deepinfra tests cover index plugin behavior.
import {
  createCapturedPluginRegistration,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { describe, expect, it, vi } from "vitest";
import deepinfraPlugin from "./index.js";
import {
  DEEPINFRA_MODEL_CATALOG,
  DEEPINFRA_MODELS_URL,
  resetDeepInfraModelCacheForTest,
} from "./provider-models.js";

function buildSyntheticDeepInfraEntries(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    provider: "deepinfra",
    id: `synthetic/model-${index}`,
    name: `synthetic/model-${index}`,
  }));
}

function buildDeepInfraCatalogContext(): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    agentDir: "/tmp/openclaw-agent",
    resolveProviderApiKey: () => ({ apiKey: "profile-key" }),
    resolveProviderAuth: () => ({
      apiKey: "profile-key",
      mode: "api_key",
      source: "profile",
    }),
  };
}

function makeAgentModelEntry(id = "profile/live-model") {
  return {
    id,
    object: "model",
    owned_by: "deepinfra",
    metadata: {
      description: id,
      context_length: 32768,
      max_tokens: 4096,
      pricing: { input_tokens: 1, output_tokens: 2 },
      tags: ["chat"],
    },
  };
}

async function withLiveDiscoveryTestEnv(
  mockFetch: ReturnType<typeof vi.fn>,
  runAssertions: () => Promise<void>,
) {
  const env = { ...process.env };
  delete process.env.NODE_ENV;
  delete process.env.VITEST;
  delete process.env.DEEPINFRA_API_KEY;
  vi.stubGlobal("fetch", mockFetch);

  try {
    await runAssertions();
  } finally {
    for (const key of ["NODE_ENV", "VITEST", "DEEPINFRA_API_KEY"]) {
      if (env[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = env[key];
      }
    }
    vi.unstubAllGlobals();
  }
}

describe("deepinfra augmentModelCatalog", () => {
  it("returns the discovered (static under VITEST) catalog when nothing is configured", async () => {
    resetDeepInfraModelCacheForTest();
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);

    const entries = (await provider.augmentModelCatalog?.({ entries: [] } as never)) ?? [];

    expect(entries.map((entry) => entry.id)).toEqual(
      DEEPINFRA_MODEL_CATALOG.map((model) => model.id),
    );
    for (const entry of entries) {
      expect(entry.provider).toBe("deepinfra");
    }
  });

  it("preserves configured entries and appends discovered entries that are not already configured", async () => {
    resetDeepInfraModelCacheForTest();
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);

    const entries =
      (await provider.augmentModelCatalog?.({
        entries: [],
        config: {
          models: {
            providers: {
              deepinfra: {
                models: [
                  {
                    id: "zai-org/GLM-5.1",
                    name: "GLM-5.1 custom",
                    input: ["text"],
                    reasoning: true,
                    contextWindow: 202752,
                  },
                ],
              },
            },
          },
        },
      } as never)) ?? [];

    const glmEntry = entries.find((entry) => entry.id === "zai-org/GLM-5.1");
    expect(glmEntry?.name).toBe("GLM-5.1 custom");
    expect(entries.filter((entry) => entry.id === "zai-org/GLM-5.1")).toHaveLength(1);
    expect(entries.length).toBe(DEEPINFRA_MODEL_CATALOG.length);
  });

  it("uses config-backed API keys to enable live model catalog augmentation", async () => {
    resetDeepInfraModelCacheForTest();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeAgentModelEntry("config/live-model")] }),
    });
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);

    await withLiveDiscoveryTestEnv(mockFetch, async () => {
      const entries =
        (await provider.augmentModelCatalog?.({
          entries: [],
          env: {},
          config: {
            models: {
              providers: {
                deepinfra: {
                  apiKey: { source: "env", provider: "default", id: "CUSTOM_DEEPINFRA_KEY" },
                },
              },
            },
          },
        } as never)) ?? [];

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(entries.map((entry) => entry.id)).toContain("config/live-model");
    });
  });

  it("still runs live discovery when ctx.entries includes custom DeepInfra rows", async () => {
    resetDeepInfraModelCacheForTest();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeAgentModelEntry("custom/live-model")] }),
    });
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);

    const seededDeepInfraCount = DEEPINFRA_MODEL_CATALOG.length + 5;
    await withLiveDiscoveryTestEnv(mockFetch, async () => {
      const entries =
        (await provider.augmentModelCatalog?.({
          entries: [
            ...buildSyntheticDeepInfraEntries(seededDeepInfraCount),
            { provider: "openai", id: "noise", name: "noise" },
          ],
          config: {
            models: {
              providers: {
                deepinfra: {
                  apiKey: "sk-test",
                  models: [
                    {
                      id: "zai-org/GLM-5.1",
                      name: "configured override",
                      input: ["text"],
                      reasoning: true,
                      contextWindow: 202752,
                    },
                  ],
                },
              },
            },
          },
        } as never)) ?? [];

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(entries[0]).toEqual({
        provider: "deepinfra",
        id: "zai-org/GLM-5.1",
        name: "configured override",
        input: ["text"],
        reasoning: true,
        contextWindow: 202752,
      });
      expect(entries.map((entry) => entry.id)).toContain("custom/live-model");
    });
  });

  it("still fetches when ctx.entries has exactly the static catalog length (static-fallback case)", async () => {
    resetDeepInfraModelCacheForTest();
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);

    const entries =
      (await provider.augmentModelCatalog?.({
        entries: buildSyntheticDeepInfraEntries(DEEPINFRA_MODEL_CATALOG.length),
      } as never)) ?? [];

    expect(entries.map((entry) => entry.id)).toEqual(
      DEEPINFRA_MODEL_CATALOG.map((model) => model.id),
    );
  });
});

describe("deepinfra capability registration", () => {
  it("registers all DeepInfra-backed OpenClaw provider surfaces", () => {
    const captured = createCapturedPluginRegistration();
    deepinfraPlugin.register(captured.api);

    expect(captured.providers.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.imageGenerationProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.mediaUnderstandingProviders.map((provider) => provider.id)).toEqual([
      "deepinfra",
    ]);
    expect(captured.memoryEmbeddingProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.speechProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.videoGenerationProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
  });

  it("uses profile-resolved API keys for live text catalog discovery", async () => {
    resetDeepInfraModelCacheForTest();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeAgentModelEntry()] }),
    });
    const captured = createCapturedPluginRegistration();
    deepinfraPlugin.register(captured.api);
    const provider = captured.providers[0];
    if (!provider?.catalog) {
      throw new Error("expected DeepInfra provider registration");
    }
    const catalog = provider.catalog;

    await withLiveDiscoveryTestEnv(mockFetch, async () => {
      const result = await catalog.run(buildDeepInfraCatalogContext());
      if (!result || !("provider" in result)) {
        throw new Error("expected single-provider DeepInfra catalog result");
      }

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0]?.[0]).toBe(DEEPINFRA_MODELS_URL);
      expect(result?.provider.apiKey).toBe("profile-key");
      expect(result.provider.models.map((model) => model.id)).toEqual([
        "profile/live-model",
        ...DEEPINFRA_MODEL_CATALOG.map((model) => model.id),
      ]);
    });
  });
});

describe("deepinfra isCacheTtlEligible", () => {
  it("returns true for anthropic/* proxied models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "anthropic/claude-4-sonnet",
      }),
    ).toBe(true);
  });

  // Locked to case-insensitive to stay consistent with the shared proxy cache
  // wrapper, which lowercases the modelId before the "anthropic/" prefix check.
  it("returns true regardless of modelId case", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "Anthropic/Claude-4-Sonnet",
      }),
    ).toBe(true);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "ANTHROPIC/claude-4-sonnet",
      }),
    ).toBe(true);
  });

  it("returns false for non-anthropic models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
      }),
    ).toBe(false);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "zai-org/GLM-5.1",
      }),
    ).toBe(false);
  });
});
