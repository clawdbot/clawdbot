import { describe, expect, it, vi } from "vitest";
import {
  buildLiveModelProviderCatalog,
  buildOpenAICompatibleProviderFamilyCatalog,
  LiveModelCatalogHttpError,
} from "./provider-catalog-live-runtime.js";
import type { ModelDefinitionConfig } from "./provider-model-shared.js";

function buildModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

describe("live provider catalog outcomes", () => {
  it("reports unavailable while retaining static rows", async () => {
    const result = await buildLiveModelProviderCatalog({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://provider.example.test/v1",
      },
      models: [buildModel("model-a")],
      fetchGuard: vi.fn(async () => {
        throw new Error("network unavailable");
      }),
    });

    expect(result.provider.models.map((model) => model.id)).toEqual(["model-a"]);
    expect(result.outcomes).toEqual([{ provider: "provider", status: "unavailable" }]);
  });

  it("reports the selected profile on auth rejection", async () => {
    const result = await buildLiveModelProviderCatalog({
      providerId: "provider",
      profileId: "provider:profile-a",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://provider.example.test/v1",
      },
      models: [buildModel("model-a")],
      fetchGuard: vi.fn(async () => {
        throw new LiveModelCatalogHttpError("provider", 401);
      }),
    });

    expect(result.outcomes).toEqual([
      { provider: "provider", profileId: "provider:profile-a", status: "auth-rejected" },
    ]);
  });

  it("publishes static family rows as ready without a credential", async () => {
    const providers = {
      alpha: { baseUrl: "https://alpha.example.test", models: [buildModel("alpha-model")] },
      beta: { baseUrl: "https://beta.example.test", models: [buildModel("beta-model")] },
    };
    const family = buildOpenAICompatibleProviderFamilyCatalog({
      credentialProviderId: "family",
      entries: Object.entries(providers).map(([id, provider]) => ({
        id,
        label: id,
        baseUrl: provider.baseUrl,
        models: provider.models,
        buildProvider: () => provider,
      })),
      staticCatalog: async () => ({ providers }),
      augmentModelCatalog: vi.fn(async () => []),
    });

    await expect(
      family.catalog.run({
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      } as never),
    ).resolves.toEqual({
      providers,
      outcomes: [
        { provider: "alpha", status: "ready" },
        { provider: "beta", status: "ready" },
      ],
    });
  });

  it("runs live discovery only for the selected family provider", async () => {
    const buildAlpha = vi.fn(() => ({
      baseUrl: "http://127.0.0.1:1",
      models: [buildModel("alpha-model")],
    }));
    const buildBeta = vi.fn(() => ({
      baseUrl: "http://127.0.0.1:1",
      models: [buildModel("beta-model")],
    }));
    const family = buildOpenAICompatibleProviderFamilyCatalog({
      credentialProviderId: "family",
      entries: [
        {
          id: "alpha",
          label: "alpha",
          baseUrl: "http://127.0.0.1:1",
          models: [],
          buildProvider: buildAlpha,
        },
        {
          id: "beta",
          label: "beta",
          baseUrl: "http://127.0.0.1:1",
          models: [],
          buildProvider: buildBeta,
        },
      ],
      staticCatalog: async () => ({ providers: {} }),
      augmentModelCatalog: vi.fn(async () => []),
    });

    const result = await family.catalog.run({
      providerIds: ["beta"],
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
    } as never);

    expect(buildAlpha).not.toHaveBeenCalled();
    expect(buildBeta).toHaveBeenCalledOnce();
    expect(result && "providers" in result ? Object.keys(result.providers) : []).toEqual(["beta"]);
  });
});
