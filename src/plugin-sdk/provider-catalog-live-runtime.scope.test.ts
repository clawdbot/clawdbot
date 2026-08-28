import { describe, expect, it, vi } from "vitest";
import { buildOpenAICompatibleProviderFamilyCatalog } from "./provider-catalog-live-runtime.js";
import type { ProviderCatalogContext } from "./provider-catalog-shared.js";

describe("provider catalog live-runtime scope", () => {
  it("scopes shared family credentials and construction to selected entries", async () => {
    const buildPrimary = vi.fn(() => ({
      baseUrl: "not-a-url",
      api: "openai-completions" as const,
      models: [],
    }));
    const buildPlan = vi.fn(() => ({
      baseUrl: "not-a-url",
      api: "openai-completions" as const,
      models: [],
    }));
    const family = buildOpenAICompatibleProviderFamilyCatalog({
      credentialProviderId: "family",
      entries: [
        {
          id: "family",
          label: "Family",
          baseUrl: "not-a-url",
          models: [],
          buildProvider: buildPrimary,
        },
        {
          id: "family-plan",
          label: "Family Plan",
          baseUrl: "not-a-url",
          models: [],
          buildProvider: buildPlan,
        },
      ],
      staticCatalog: async () => ({ providers: {} }),
      augmentModelCatalog: vi.fn(),
    });

    const resolveProviderApiKey = vi.fn(() => ({ apiKey: "family-key" }));
    const context: ProviderCatalogContext = {
      providerIds: ["family-plan"],
      config: {},
      env: {},
      resolveProviderApiKey,
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    };
    const result = await family.catalog.run(context);

    expect(result && "providers" in result ? Object.keys(result.providers) : []).toEqual([
      "family-plan",
    ]);
    expect(buildPrimary).not.toHaveBeenCalled();
    expect(buildPlan).toHaveBeenCalledOnce();

    resolveProviderApiKey.mockClear();
    await expect(family.catalog.run({ ...context, providerIds: ["other"] })).resolves.toBeNull();
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
  });
});
