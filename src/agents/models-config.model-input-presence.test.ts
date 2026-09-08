import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { planOpenClawModelsJsonSource } from "./models-config.js";
import { planOpenClawModelsJsonWithDeps } from "./models-config.plan.test-support.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";

afterEach(clearRuntimeConfigSnapshot);

type ResolveImplicitProviders = NonNullable<
  NonNullable<Parameters<typeof planOpenClawModelsJsonWithDeps>[1]>["resolveImplicitProviders"]
>;

function model(id: string, input: Array<"text" | "image"> = ["text"]) {
  return {
    id,
    name: id,
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 1024,
  };
}

describe("models config input presence", () => {
  it.each([
    {
      name: "inherits discovered input when source input was omitted",
      sourceModels: [{ id: "vision-model", name: "vision-model" }],
      expected: ["text", "image"],
    },
    {
      name: "preserves text-only input when source input was explicit",
      sourceModels: [{ id: "vision-model", name: "vision-model", input: ["text"] }],
      expected: ["text"],
    },
    {
      name: "keeps independent input when the active secrets source has no row",
      sourceModels: [],
      expected: ["text"],
    },
  ] as const)("$name in the final generated models.json", async ({ sourceModels, expected }) => {
    const configuredProvider = {
      baseUrl: "https://model-input.example/v1",
      apiKey: "MODEL_INPUT_FIXTURE_KEY",
      models: [model("vision-model")],
    };
    const cfg: OpenClawConfig = {
      models: { providers: { "model-input-fixture": configuredProvider } },
    };
    const sourceConfigForSecrets = {
      models: {
        providers: {
          "model-input-fixture": {
            baseUrl: configuredProvider.baseUrl,
            apiKey: configuredProvider.apiKey,
            models: sourceModels,
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolveImplicitProviders = vi.fn<ResolveImplicitProviders>(async () => ({
      "model-input-fixture": {
        ...configuredProvider,
        models: [model("vision-model", ["text", "image"])],
      },
    }));

    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: sourceModels.length ? sourceConfigForSecrets : cfg,
        discoveryAuthConfig: cfg,
        sourceConfigForSecrets,
        agentDir: "/tmp/openclaw-model-input-presence",
        // Model-ID policies are part of this prepared merge fixture, not ambient discovery.
        pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
        env: { MODEL_INPUT_FIXTURE_KEY: "default" },
        existingRaw: "",
        existingParsed: {},
      },
      { resolveImplicitProviders },
    );

    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error(`expected write plan, got ${plan.action}`);
    }
    const generated = JSON.parse(plan.contents) as {
      providers: Record<string, { models?: Array<{ input?: string[] }> }>;
    };
    expect(generated.providers["model-input-fixture"]?.models?.[0]?.input).toEqual(expected);
  });

  const liveCost = {
    input: 11,
    output: 22,
    cacheRead: 3,
    cacheWrite: 4,
    tieredPricing: [{ input: 33, output: 44, cacheRead: 5, cacheWrite: 6, range: [0] as [number] }],
  };
  const oldCost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
  const authoredRates = { input: 7, output: 8, cacheRead: 0.7, cacheWrite: 0.8 };
  const authoredTiers = [{ ...authoredRates, range: [0] as [number] }];
  it.each<{
    name: string;
    cost?: Partial<ModelDefinitionConfig["cost"]>;
    expected: ModelDefinitionConfig["cost"];
    missingSource?: boolean;
    independent?: boolean;
    duplicateCost?: Partial<ModelDefinitionConfig["cost"]>;
  }>([
    { name: "omitted cost", cost: undefined, expected: liveCost },
    { name: "empty cost", cost: {}, expected: liveCost },
    {
      name: "partial cost",
      cost: { input: 7 },
      expected: { ...liveCost, input: 7, tieredPricing: undefined },
    },
    { name: "full cost", cost: authoredRates, expected: authoredRates },
    {
      name: "zero cost",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      expected: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    {
      name: "authored tiers",
      cost: { tieredPricing: authoredTiers },
      expected: { ...liveCost, tieredPricing: authoredTiers },
    },
    {
      name: "empty tiers",
      cost: { tieredPricing: [] },
      expected: { ...liveCost, tieredPricing: [] },
    },
    {
      name: "independent missing source row",
      missingSource: true,
      cost: undefined,
      expected: oldCost,
    },
    { name: "independent config", independent: true, expected: oldCost },
    {
      name: "duplicate partial costs",
      cost: { input: 7 },
      duplicateCost: { input: 9, output: 8 },
      expected: { input: 7, output: 8, cacheRead: 3, cacheWrite: 4 },
    },
  ])(
    "uses authored $name through discovery and final catalog merging",
    async ({ cost, expected, missingSource, independent, duplicateCost }) => {
      const providerId = "catalog-price-fixture";
      const configuredModel = {
        ...model("priced-model", ["text", "image"]),
        cost: { ...oldCost, ...cost },
        contextWindow: 4096,
        maxTokens: 512,
        compat: { supportsTools: false },
      };
      const configuredProvider = {
        baseUrl: "https://models.example/v1",
        apiKey: "CATALOG_FIXTURE_KEY",
        models: [configuredModel],
      };
      const cfg: OpenClawConfig = { models: { providers: { [providerId]: configuredProvider } } };
      const sourceConfigForSecrets = {
        models: {
          providers: {
            " Catalog-Price-Fixture ": {
              ...configuredProvider,
              models: missingSource
                ? []
                : [
                    {
                      id: "priced-model",
                      name: "priced-model",
                      reasoning: false,
                      input: ["text", "image"],
                      contextWindow: 4096,
                      maxTokens: 512,
                      compat: configuredModel.compat,
                      ...(cost === undefined ? {} : { cost }),
                    },
                    ...(duplicateCost ? [{ ...configuredModel, cost: duplicateCost }] : []),
                  ],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const discovered = {
        ...configuredProvider,
        models: [
          { ...model("priced-model"), cost: liveCost, compat: configuredModel.compat },
          model("discovered-only"),
        ],
      };
      const plugin: ProviderPlugin = {
        id: providerId,
        pluginId: providerId,
        label: "Catalog price fixture",
        auth: [],
        staticCatalog: { run: async () => ({ provider: discovered }) },
      };
      const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture();
      const options = {
        authStore: { version: 1, profiles: {} },
        pluginMetadataSnapshot,
        providerDiscoveryEntriesOnly: true,
        providerDiscoveryProviderIds: [providerId],
        preparedStaticProviderCatalog: {
          providers: [plugin],
          entries: [{ provider: plugin, result: { provider: discovered } }],
        },
      };
      if (independent || missingSource) {
        // Missing top-level runtime state makes this an independent supplied config.
        setRuntimeConfigSnapshot({ ...cfg, gateway: { mode: "local" } }, sourceConfigForSecrets);
        await withOpenClawTestState({ label: "independent-model-cost" }, async (state) => {
          const plan = await planOpenClawModelsJsonSource(cfg, state.agentDir(), {
            ...options,
            env: state.env,
          });
          expect(JSON.parse(plan.modelsJsonContents!).providers[providerId].models).toEqual([
            { ...configuredModel, cost: expected },
          ]);
        });
        return;
      }
      setRuntimeConfigSnapshot(cfg, sourceConfigForSecrets);
      const cloned = structuredClone(
        createPreparedModelCatalogWorkerInput({
          agentFacts: {
            input: { config: cfg, agentDir: "/tmp/openclaw-model-cost-presence" },
            env: {},
            authStore: options.authStore,
            credentials: {},
            providerIds: [providerId],
            configuredModelRefs: [],
            configuredRuntimeModels: [],
            runtimeCapabilityModels: [],
            configuredGeneratedCatalogPluginIds: [],
            templateAuthStorage: {} as never,
          },
          pluginMetadataSnapshot,
        }),
      );
      // Workers retain the captured pair after losing the parent's process-local snapshot.
      clearRuntimeConfigSnapshot();
      const plan = await planOpenClawModelsJsonWithDeps({
        ...options,
        cfg: cloned.sourceConfigForSecrets,
        discoveryAuthConfig: cloned.input.config,
        sourceConfigForSecrets: cloned.sourceConfigForSecrets,
        agentDir: cloned.input.agentDir,
        env: {},
        existingRaw: "",
        existingParsed: {},
      });
      expect(plan.action).toBe("write");
      if (plan.action !== "write") {
        throw new Error(`expected write plan, got ${plan.action}`);
      }
      const generated = JSON.parse(plan.contents);
      expect(generated.providers[providerId].models).toEqual([
        { ...configuredModel, cost: expected },
      ]);
    },
  );
});
