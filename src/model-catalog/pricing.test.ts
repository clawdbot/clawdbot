import fs from "node:fs/promises";
import path from "node:path";
import * as staticNormalization from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as runtimeNormalization from "../agents/provider-model-normalization.runtime.js";
import { resolveResponseUsageLine } from "../auto-reply/reply/agent-runner-usage-line.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as manifestNormalization from "../plugins/manifest-model-id-normalization.js";
import { normalizeManifestModelPricing } from "../plugins/manifest-model-provider-normalizers.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { buildStatusMessageParts } from "../status/status-message.js";
import {
  estimateAggregateUsageCost,
  resetUsageFormatCachesForTest,
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "../utils/usage-format.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "./remote-overlay.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readStoredCatalog = vi.fn();

beforeEach(() => {
  clearRuntimeConfigSnapshot();
  resetUsageFormatCachesForTest();
  readStoredCatalog.mockReset().mockReturnValue({
    source_url: "https://catalog.openclaw.ai/models/v1/catalog.json",
    bundle_json: JSON.stringify({
      schemaVersion: 1,
      generatedAt: 200,
      minVersion: "2026.7.0",
      sourceCommit: "pricing-test",
      providers: {
        openai: {
          models: [
            { id: "gpt-catalog", cost: { input: 1, output: 2 } },
            { id: "pricing-model", cost: { input: 1, output: 2 } },
            { id: "openai/pricing-model", cost: { input: 3, output: 6 } },
            {
              id: "gpt-authored",
              cost: {
                input: 2,
                output: 8,
                cacheRead: 0.5,
                cacheWrite: 1,
                tieredPricing: [
                  { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 1, range: [0, 201] },
                  { input: 4, output: 16, cacheRead: 1, cacheWrite: 2, range: [201] },
                ],
              },
            },
            {
              id: "gpt-zero-tier",
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                tieredPricing: [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, range: [0] }],
              },
            },
          ],
        },
      },
      pricing: {
        "openai/pricing-model": { input: 91, output: 92 },
        "openai/openai/pricing-model": { input: 93, output: 94 },
        "openai/pricing-hosted": { input: 4, output: 8 },
        "openai/openai/pricing-hosted": { input: 5, output: 10 },
        "openai/gpt-external": { input: 2.5, output: 10, cacheRead: 1.25 },
        "openai/gpt-zero-hosted": {
          input: 0,
          output: 0,
          tieredPricing: [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, range: [0] }],
        },
        "openai/gpt-zero-tier": { input: 4, output: 8 },
        "openrouter/openai/gpt-catalog": { input: 1, output: 2 },
        "z-ai/forbidden": { input: 9, output: 18 },
      },
    }),
  });
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: () => 100,
    readStoredCatalog,
  });
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetUsageFormatCachesForTest();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setRemoteModelCatalogOverlaySourcesForTest();
});

function configFor(baseUrl: string): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl,
          models: [{ id: "gpt-external", name: "External GPT" }],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("hosted model pricing", () => {
  it("keeps normalized indexes scoped to their policy while observing configured price changes", async () => {
    const model = {
      id: "alias",
      name: "Alias",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 8192,
    };
    const providers = { fixture: { baseUrl: "https://fixture.invalid", models: [model] } };
    const firstConfig: OpenClawConfig = { models: { providers } };
    const secondConfig: OpenClawConfig = { models: { providers } };
    const enumeratePolicies = vi.fn(Reflect.ownKeys);
    const snapshotFor = (canonicalModel: string) =>
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture",
            providers: ["fixture"],
            modelIdNormalization: {
              providers: new Proxy(
                { fixture: { aliases: { alias: canonicalModel } } },
                { ownKeys: (target) => enumeratePolicies(target) },
              ),
            },
          },
        ],
      });
    const metadataSpy = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockReturnValueOnce(snapshotFor("first"))
      .mockReturnValueOnce(snapshotFor("second"));
    enumeratePolicies.mockClear();
    const agentDir = tempDirs.make("openclaw-policy-pricing-");
    const lookup = () =>
      [firstConfig, secondConfig].flatMap((config) =>
        ["first", "second"].map(
          (modelId) =>
            resolveModelCostConfig({ config, agentDir, provider: "fixture", model: modelId })
              ?.input,
        ),
      );
    expect(lookup()).toEqual([3, undefined, undefined, 3]);
    expect(lookup()).toEqual([3, undefined, undefined, 3]);

    model.cost.input = 9;
    expect(lookup()).toEqual([9, undefined, undefined, 9]);
    model.cost = { input: 11, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(lookup()).toEqual([11, undefined, undefined, 11]);
    model.id = "unaliased";
    expect(lookup()).toEqual([undefined, undefined, undefined, undefined]);
    providers.fixture.models.push({ ...model, id: "alias" });
    expect(lookup()).toEqual([11, undefined, undefined, 11]);

    const fileModel = { ...model, id: "alias", cost: { ...model.cost, input: 17 } };
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: { fixture: { ...providers.fixture, models: [fileModel] } } }),
    );
    expect(lookup()).toEqual([17, undefined, undefined, 17]);
    expect(metadataSpy).toHaveBeenCalledTimes(2);
    expect(enumeratePolicies).not.toHaveBeenCalled();
  });

  it.each(["config", "models.json"] as const)(
    "reuses normalized pricing indexes for repeated fallbacks from %s",
    async (source) => {
      const agentDir = tempDirs.make("openclaw-repeated-pricing-");
      const providers = {
        custom: {
          baseUrl: "https://pricing.example/v1",
          models: Array.from({ length: 500 }, (_, index) => ({
            id: `model-${index}`,
            name: `Model ${index}`,
            reasoning: false,
            input: ["text" as const],
            cost: { input: index + 1, output: 0, cacheRead: 0, cacheWrite: 0 },
            maxTokens: 8192,
          })),
        },
      };
      const config: OpenClawConfig = {
        models: {
          providers: {
            openai: { baseUrl: "https://api.openai.com/v1", models: [] },
            ...(source === "config" ? providers : {}),
          },
        },
      };
      if (source === "models.json") {
        await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers }));
      }
      const lookup = () =>
        ["gpt-external", "unknown-model"].map(
          (model) => resolveModelCostConfig({ config, agentDir, provider: "openai", model })?.input,
        );
      let prices = lookup();
      const normalizeKey = vi.spyOn(
        staticNormalization,
        "normalizeStaticProviderModelIdWithPolicies",
      );
      for (let repeat = 0; repeat < 20; repeat += 1) {
        prices = lookup();
      }
      expect(prices).toEqual([2.5, undefined]);
      expect(normalizeKey.mock.calls.length).toBeLessThanOrEqual(100);
    },
  );

  it("resolves catalog and hosted prices without activating provider runtime", () => {
    const runtimeSpy = vi.spyOn(runtimeNormalization, "normalizeProviderModelIdWithRuntime");
    const config = configFor("https://api.openai.com/v1");
    const agentDir = tempDirs.make("openclaw-static-pricing-");
    expect(
      ["gpt-catalog", "gpt-external"].map(
        (model) => resolveModelCostConfig({ config, agentDir, provider: "openai", model })?.input,
      ),
    ).toEqual([1, 2.5]);
    expect(runtimeSpy).not.toHaveBeenCalled();
  });

  it.each(["config", "models.json"] as const)(
    "keeps exact pricing namespaces distinct in %s",
    async (source) => {
      const agentDir = tempDirs.make("openclaw-exact-pricing-");
      const config: OpenClawConfig = {
        models: {
          providers: {
            custom: {
              baseUrl: "https://custom.example/v1",
              models: ["model", "custom/model"].map((id, index) => ({
                id,
                name: id,
                reasoning: false,
                input: ["text" as const],
                cost: { input: index + 1, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 8192,
              })),
            },
          },
        },
      };
      if (source === "models.json") {
        await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify(config.models));
      }

      expect(
        ["model", "custom/model"].map(
          (model) =>
            resolveModelCostConfig({
              config: source === "config" ? config : undefined,
              agentDir,
              provider: "custom",
              model,
              allowPluginNormalization: false,
            })?.input,
        ),
      ).toEqual([1, 2]);
    },
  );

  it.each([
    { provider: "openrouter", model: "openrouter/auto", shortModel: "auto" },
    { provider: "nvidia", model: "nvidia/nemotron", shortModel: "nemotron" },
  ])("retains static pricing aliases for $provider", ({ provider, model, shortModel }) => {
    const agentDir = tempDirs.make("openclaw-static-pricing-alias-");
    const config: OpenClawConfig = {
      models: {
        providers: {
          [provider]: {
            baseUrl: "https://pricing.example/v1",
            models: [
              {
                id: model,
                name: model,
                reasoning: false,
                input: ["text"],
                cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    };

    expect(
      [model, shortModel].map(
        (modelId) =>
          resolveModelCostConfig({
            config,
            agentDir,
            provider,
            model: modelId,
            allowPluginNormalization: false,
          })?.input,
      ),
    ).toEqual([3, 3]);
  });

  it.each([
    { source: "catalog", model: "pricing-model", expected: [1, 3] },
    { source: "hosted", model: "pricing-hosted", expected: [4, 5] },
  ])("keeps exact pricing namespaces distinct in $source", ({ model, expected }) => {
    const config = configFor("https://api.openai.com/v1");
    const agentDir = tempDirs.make("openclaw-catalog-namespaces-");
    expect(
      [model, `openai/${model}`].map(
        (modelId) =>
          resolveModelCostConfig({ config, agentDir, provider: "openai", model: modelId })?.input,
      ),
    ).toEqual(expected);
  });

  it("checks the exact model endpoint before applying hosted pricing", () => {
    const config = configFor("https://api.openai.com/v1");
    const models = expectDefined(config.models?.providers?.openai?.models, "endpoint models");
    const entry = expectDefined(models[0], "metadata-only endpoint model");
    entry.id = "pricing-hosted";
    models.push({ ...entry, id: "openai/pricing-hosted", baseUrl: "http://127.0.0.1:8080/v1" });

    const agentDir = tempDirs.make("openclaw-exact-endpoint-pricing-");
    expect(
      ["pricing-hosted", "openai/pricing-hosted"].map(
        (model) => resolveModelCostConfig({ config, agentDir, provider: "openai", model })?.input,
      ),
    ).toEqual([4, undefined]);
  });

  it.each([
    { name: "native owner", policy: { venice: { provider: "venice" } }, known: true },
    { name: "other native source", policy: { openCode: { provider: "upstream" } }, known: true },
    { name: "missing policy", policy: undefined, known: false },
    {
      name: "external disabled",
      policy: { external: false, venice: { provider: "venice" } },
      known: false,
    },
    { name: "source disabled", policy: { venice: false }, known: false },
    {
      name: "non-authoritative source",
      policy: { openRouter: { provider: "venice" } },
      known: false,
    },
    {
      name: "unowned policy",
      policy: { venice: { provider: "venice" } },
      unowned: true,
      known: false,
    },
    {
      name: "disabled plugin",
      policy: { venice: { provider: "venice" } },
      disabled: true,
      known: false,
    },
    {
      name: "private endpoint",
      policy: { venice: { provider: "venice" } },
      private: true,
      known: false,
    },
    {
      name: "normalized hosted alias",
      policy: { venice: { provider: "venice" } },
      alias: true,
      known: false,
    },
    { name: "policy-free hosted alias", policy: undefined, alias: true, known: false },
    {
      name: "foreign owner key",
      policy: { venice: { provider: "venice" } },
      foreign: true,
      known: false,
    },
  ])("requires exact authoritative hosted zero evidence: $name", (scenario) => {
    const agentDir = tempDirs.make("openclaw-native-zero-policy-");
    vi.stubEnv("OPENCLAW_STATE_DIR", agentDir);
    const config: OpenClawConfig = {
      plugins: { allow: ["venice"], entries: { venice: { enabled: !scenario.disabled } } },
      ...(scenario.private
        ? {
            models: { providers: { venice: { baseUrl: "http://127.0.0.1:8080/v1", models: [] } } },
          }
        : {}),
    };
    const snapshot = pluginMetadata.resolvePluginMetadataSnapshot({ config, env: process.env });
    const plugins = [...snapshot.manifestRegistry.plugins];
    const ownerIndex = plugins.findIndex((plugin) => plugin.id === "venice");
    plugins[ownerIndex] = {
      ...expectDefined(plugins[ownerIndex], "Venice manifest owner"),
      modelPricing: normalizeManifestModelPricing(
        { providers: { venice: scenario.policy } },
        { ownedProviders: new Set(scenario.unowned ? [] : ["venice"]) },
      ),
    };
    vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshot").mockReturnValue({
      ...snapshot,
      manifestRegistry: { ...snapshot.manifestRegistry, plugins },
    });
    readStoredCatalog.mockReturnValue({
      source_url: "https://catalog.openclaw.ai/models/v1/catalog.json",
      bundle_json: JSON.stringify({
        schemaVersion: 1,
        generatedAt: 200,
        sourceCommit: "native-zero-policy",
        providers: { venice: { models: [{ id: "zero-fixture", cost: { input: 0, output: 0 } }] } },
        pricing: {
          [`${scenario.foreign ? "opencode" : scenario.alias ? "Venice" : "venice"}/zero-fixture`]:
            { input: 0, output: 0 },
        },
      }),
    });
    const cost = resolveModelCostConfig({
      config,
      agentDir,
      provider: "venice",
      model: "zero-fixture",
    });
    expect(cost).toEqual(
      scenario.known ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined,
    );
  });

  const catalogRates = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 1 };
  const catalogTiers = [
    { ...catalogRates, range: [0, 201] },
    { input: 4, output: 16, cacheRead: 1, cacheWrite: 2, range: [201, Infinity] },
  ];
  const preparedRates = { input: 11, output: 13, cacheRead: 17, cacheWrite: 19 };
  const preparedTiers = [{ ...preparedRates, range: [0, Infinity] }];

  it.each(
    [
      {
        name: "sizing-only",
        cost: undefined,
        expected: { ...catalogRates, tieredPricing: catalogTiers },
        preparedExpected: { ...preparedRates, tieredPricing: preparedTiers },
        total: undefined,
        price: undefined,
      },
      {
        name: "empty cost",
        cost: {},
        expected: { ...catalogRates, tieredPricing: catalogTiers },
        preparedExpected: { ...preparedRates, tieredPricing: preparedTiers },
        total: undefined,
        price: undefined,
      },
      {
        name: "omitted cost with flat prepared rates",
        cost: undefined,
        flatPrepared: true,
        expected: { ...catalogRates, tieredPricing: catalogTiers },
        preparedExpected: preparedRates,
        total: 0.06,
        price: "$0.06",
      },
      {
        name: "empty cost with flat prepared rates",
        cost: {},
        flatPrepared: true,
        expected: { ...catalogRates, tieredPricing: catalogTiers },
        preparedExpected: preparedRates,
        total: 0.06,
        price: "$0.06",
      },
      {
        name: "partial cost",
        cost: { output: 3 },
        expected: { ...catalogRates, output: 3 },
        preparedExpected: { ...preparedRates, output: 3 },
        total: 0.05,
        price: "$0.05",
      },
      {
        name: "input/output-only cost",
        cost: { input: 1, output: 2 },
        expected: { ...catalogRates, input: 1, output: 2 },
        preparedExpected: { ...preparedRates, input: 1, output: 2 },
        total: 0.039,
        price: "$0.04",
      },
      {
        name: "full cost",
        cost: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
        expected: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
        preparedExpected: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
        total: 0.019,
        price: "$0.02",
      },
      {
        name: "zero cost",
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        expected: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        preparedExpected: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        total: 0,
        price: "$0.0000",
      },
      {
        name: "empty tiers",
        cost: { tieredPricing: [] },
        expected: catalogRates,
        preparedExpected: preparedRates,
        total: 0.06,
        price: "$0.06",
      },
      {
        name: "authored tiers",
        cost: { tieredPricing: [{ input: 7, output: 9, cacheRead: 1, cacheWrite: 2, range: [0] }] },
        expected: {
          ...catalogRates,
          tieredPricing: [
            { input: 7, output: 9, cacheRead: 1, cacheWrite: 2, range: [0, Infinity] },
          ],
        },
        preparedExpected: {
          ...preparedRates,
          tieredPricing: [
            { input: 7, output: 9, cacheRead: 1, cacheWrite: 2, range: [0, Infinity] },
          ],
        },
        total: undefined,
        price: undefined,
      },
    ].flatMap(({ preparedExpected, ...testCase }) => [
      { ...testCase, mode: "catalog", allowPluginNormalization: true },
      {
        ...testCase,
        mode: "prepared",
        allowPluginNormalization: false,
        expected: preparedExpected,
      },
    ]),
  )(
    "resolves $name from authored source over $mode pricing",
    ({ cost, expected, allowPluginNormalization, total, price, flatPrepared }) => {
      const source = {
        messages: { responseUsage: "full" },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-authored",
                  name: "Authored GPT",
                  contextWindow: 64_000,
                  ...(cost ? { cost } : {}),
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const runtime = structuredClone(source);
      const model = expectDefined(
        runtime.models?.providers?.openai?.models[0],
        "materialized model",
      );
      model.cost = {
        ...preparedRates,
        ...(flatPrepared ? {} : { tieredPricing: [{ ...preparedRates, range: [0] }] }),
      };
      setRuntimeConfigSnapshot(runtime, source);
      const agentDir = tempDirs.make("openclaw-authored-pricing-");
      vi.stubEnv("OPENCLAW_STATE_DIR", agentDir);
      const fetch = vi.fn(() => {
        throw new Error("pricing display must not use the network");
      });
      vi.stubGlobal("fetch", fetch);
      for (const config of [runtime, structuredClone(runtime)]) {
        resetUsageFormatCachesForTest();
        const discoverySpies = allowPluginNormalization
          ? []
          : [
              vi.spyOn(manifestNormalization, "normalizeProviderModelIdWithManifest"),
              vi.spyOn(runtimeNormalization, "normalizeProviderModelIdWithRuntime"),
              vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshot"),
            ];
        const params = { config, agentDir, provider: "openai", model: "gpt-authored" };
        const resolvedCost = resolveModelCostConfig({ ...params, allowPluginNormalization });
        expect.soft(resolvedCost).toEqual(expected);
        if (allowPluginNormalization) {
          expect(resolveModelCostConfigFingerprint(config, agentDir)).toBe(
            resolveModelCostConfigFingerprint(source, agentDir),
          );
          continue;
        }
        const usage = { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000 };
        const estimate = estimateAggregateUsageCost({ usage, cost: resolvedCost });
        if (total === undefined) {
          expect.soft(estimate).toBeUndefined();
        } else {
          expect.soft(estimate).toBeCloseTo(total);
        }
        expect
          .soft(resolveResponseUsageLine({ ...params, usage }))
          .toBe(
            `Usage: 1.0k in / 1.0k out · cache 1.0k cached / 1.0k new${price ? ` · est ${price}` : ""}`,
          );
        for (const spy of discoverySpies) {
          expect.soft(spy).not.toHaveBeenCalled();
          spy.mockRestore();
        }
        const status = buildStatusMessageParts({
          config,
          agent: { model: "openai/gpt-authored" },
          modelAuth: "api-key",
          activeModelAuth: "api-key",
          sessionEntry: {
            sessionId: "prepared-pricing",
            updatedAt: 0,
            modelProvider: "openai",
            model: "gpt-authored",
            inputTokens: 1000,
            outputTokens: 1000,
            cacheRead: 1000,
            cacheWrite: 1000,
          },
        });
        if (price) {
          expect.soft(status.text).toContain(`Cost: ${price}`);
        } else {
          expect.soft(status.text).not.toContain("Cost:");
        }
        const rows = status.presentation.blocks.flatMap((block) =>
          block.type === "table" ? block.rows : [],
        );
        expect.soft(rows.find((row) => row[0] === "💵 Cost")?.[1]).toBe(price);
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(model.contextWindow).toBe(64_000);
    },
  );

  it.each(["unpaired", "incompatible"] as const)(
    "preserves independent configured pricing with an %s runtime snapshot",
    (snapshot) => {
      const runtime = { agents: { defaults: {} } } satisfies OpenClawConfig;
      setRuntimeConfigSnapshot(runtime, snapshot === "unpaired" ? undefined : {});
      const config = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [{ id: "gpt-authored", name: "Authored GPT", cost: { output: 3 } }],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const agentDir = tempDirs.make("openclaw-independent-pricing-");
      expect(
        resolveModelCostConfig({ config, agentDir, provider: "openai", model: "gpt-authored" }),
      ).toEqual({ ...catalogRates, output: 3 });
      expect(
        resolveModelCostConfig({
          config,
          agentDir,
          provider: "openai",
          model: "gpt-authored",
          allowPluginNormalization: false,
        }),
      ).toEqual({ input: 0, output: 3, cacheRead: 0, cacheWrite: 0 });
      expect(
        resolveModelCostConfig({
          config,
          agentDir,
          provider: "openai",
          model: "missing",
          allowPluginNormalization: false,
        }),
      ).toBeUndefined();
    },
  );

  it("invalidates pricing fingerprints when authored empty tiers replace inherited tiers", () => {
    const cost = {} as ModelDefinitionConfig["cost"];
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-authored", name: "Authored GPT", cost }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const agentDir = tempDirs.make("openclaw-empty-tier-pricing-");
    expect(
      resolveModelCostConfig({ config, agentDir, provider: "openai", model: "gpt-authored" }),
    ).toEqual({ ...catalogRates, tieredPricing: catalogTiers });
    const before = resolveModelCostConfigFingerprint(config, agentDir);
    cost.tieredPricing = [];
    expect(resolveModelCostConfigFingerprint(config, agentDir)).not.toBe(before);
    expect(
      resolveModelCostConfig({ config, agentDir, provider: "openai", model: "gpt-authored" }),
    ).toEqual(catalogRates);
  });

  it("resolves a non-catalog model from the stored hosted pricing map", () => {
    const agentDir = tempDirs.make("openclaw-hosted-pricing-");
    expect(
      resolveModelCostConfig({
        config: configFor("https://api.openai.com/v1"),
        agentDir,
        provider: "openai",
        model: "gpt-external",
      }),
    ).toEqual({ input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 });
  });

  it("prefers configured pricing over merged catalog pricing", () => {
    const agentDir = tempDirs.make("openclaw-catalog-pricing-");
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-catalog",
                name: "Catalog GPT",
                cost: { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolveModelCostConfig({ config, agentDir, provider: "openai", model: "gpt-catalog" }),
    ).toEqual({ input: 99, output: 99, cacheRead: 0, cacheWrite: 0 });
  });

  it("does not apply hosted pricing to private endpoints or unknown models", () => {
    const agentDir = tempDirs.make("openclaw-private-pricing-");
    expect(
      resolveModelCostConfig({
        config: configFor("http://127.0.0.1:8080/v1"),
        agentDir,
        provider: "openai",
        model: "gpt-external",
      }),
    ).toBeUndefined();
    expect(resolveModelCostConfigFingerprint(configFor("https://api.openai.com/v1"))).not.toBe(
      resolveModelCostConfigFingerprint(configFor("http://127.0.0.1:8080/v1")),
    );
    expect(
      resolveModelCostConfig({
        config: configFor("https://fc-proxy.example.com/v1"),
        agentDir,
        provider: "openai",
        model: "gpt-external",
      }),
    ).toEqual({ input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 });
    expect(
      resolveModelCostConfig({
        config: configFor("http://127.0.0.1:8080/v1"),
        agentDir,
        provider: "openai",
        model: "gpt-catalog",
      }),
    ).toBeUndefined();
    expect(
      resolveModelCostConfig({
        config: configFor("https://api.openai.com/v1"),
        agentDir,
        provider: "openai",
        model: "unknown-model",
      }),
    ).toBeUndefined();
    expect(
      resolveModelCostConfig({
        config: configFor("https://api.openai.com/v1"),
        agentDir,
        provider: "openai",
        model: "gpt-zero-hosted",
      }),
    ).toBeUndefined();
    const disabled = configFor("https://api.openai.com/v1");
    disabled.models = {
      ...disabled.models,
      catalogRefresh: { enabled: false },
    };
    expect(
      resolveModelCostConfig({
        config: disabled,
        agentDir,
        provider: "openai",
        model: "gpt-external",
      }),
    ).toBeUndefined();
  });

  it("resolves passthrough provider aliases through a priced catalog row", () => {
    const agentDir = tempDirs.make("openclaw-passthrough-pricing-");
    const config = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            models: [{ id: "openai/gpt-catalog", name: "Catalog GPT through OpenRouter" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolveModelCostConfig({
        config,
        agentDir,
        provider: "openrouter",
        model: "openai/gpt-catalog",
      }),
    ).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it("falls through zero-only catalog tiers without reviving disabled source aliases", () => {
    const agentDir = tempDirs.make("openclaw-zero-tier-pricing-");
    expect(
      resolveModelCostConfig({
        config: configFor("https://api.openai.com/v1"),
        agentDir,
        provider: "openai",
        model: "gpt-zero-tier",
      }),
    ).toEqual({ input: 4, output: 8, cacheRead: 0, cacheWrite: 0 });

    const zaiConfig = {
      models: {
        providers: {
          zai: {
            baseUrl: "https://api.z.ai/api/paas/v4",
            models: [{ id: "forbidden", name: "Forbidden source alias" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolveModelCostConfig({
        config: zaiConfig,
        agentDir,
        provider: "zai",
        model: "forbidden",
      }),
    ).toBeUndefined();
  });

  it("fingerprints provider overlays without explicit model rows", () => {
    const config = {
      models: { providers: { openai: { baseUrl: "https://api.openai.com/v1" } } },
    } as unknown as OpenClawConfig;
    expect(() => resolveModelCostConfigFingerprint(config)).not.toThrow();
  });

  it("keeps optional pricing non-throwing without an ambient agent owner", () => {
    const config = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, other: {} },
      },
      models: {
        providers: {
          fixture: {
            baseUrl: "https://fixture.invalid",
            models: [
              {
                id: "priced",
                name: "Priced",
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveModelCostConfig({ config, provider: "fixture", model: "priced" })).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(
      resolveModelCostConfig({ config, provider: "fixture", model: "missing" }),
    ).toBeUndefined();
    expect(() => resolveModelCostConfigFingerprint(config)).not.toThrow();
  });

  it("bounds fingerprints for multi-megabyte hosted pricing catalogs", () => {
    const pricing = Object.fromEntries(
      Array.from({ length: 40_000 }, (_, index) => [
        `openai/catalog-model-${index}`,
        { input: index + 1, output: index + 2, cacheRead: index + 3 },
      ]),
    );
    const bundle = {
      schemaVersion: 1,
      generatedAt: 200,
      minVersion: "2026.7.0",
      sourceCommit: "large-pricing-test",
      providers: {
        openai: { models: [{ id: "catalog-model-0", cost: { input: 1, output: 2 } }] },
      },
      pricing,
    };
    const bundleJson = JSON.stringify(bundle);
    expect(Buffer.byteLength(bundleJson)).toBeGreaterThan(2 * 1024 * 1024);
    readStoredCatalog.mockReturnValue({
      source_url: "https://catalog.openclaw.ai/models/v1/catalog.json",
      bundle_json: bundleJson,
    });

    const fingerprint = resolveModelCostConfigFingerprint(configFor("https://api.openai.com/v1"));
    const withoutHostedPricing = configFor("https://api.openai.com/v1");
    withoutHostedPricing.models = {
      ...withoutHostedPricing.models,
      catalogRefresh: { enabled: false },
    };

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(fingerprint).not.toBe(resolveModelCostConfigFingerprint(withoutHostedPricing));
  });
});
