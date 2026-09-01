import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RemoteModelCatalogBundle } from "@openclaw/model-catalog-core";
import {
  LITELLM_PRICING_URL,
  OPENROUTER_MODELS_URL,
} from "@openclaw/model-catalog-core/model-catalog-pricing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleModelCatalogBundle,
  enrichModelCatalogPricing,
  MODEL_CATALOG_MIN_MODELS,
  parsePublishModelCatalogArgs,
  readModelCatalogManifests,
  serializeModelCatalogBundle,
  summarizeModelCatalogBundle,
} from "../../scripts/publish-model-catalog.mts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../../src/model-catalog/remote-overlay.test-support.js";
import {
  estimateAggregateUsageCost,
  resetUsageFormatCachesForTest,
  resolveModelCostConfig,
} from "../../src/utils/usage-format.js";

const tempDirs: string[] = [];

afterEach(() => {
  setRemoteModelCatalogOverlaySourcesForTest();
  resetUsageFormatCachesForTest();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureProvider(
  prefix: string,
  count: number,
): {
  models: Array<{ id: string; cost?: { input: number; output: number } }>;
} {
  return { models: Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` })) };
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function publishedPricingParams(bundle: RemoteModelCatalogBundle, provider: string) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-native-pricing-"));
  tempDirs.push(agentDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", agentDir);
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: () => 1,
    readStoredCatalog: () => ({
      id: 1,
      source_url: "https://catalog.openclaw.ai/models/v1/catalog.json",
      bundle_json: serializeModelCatalogBundle(bundle),
      generated_at: bundle.generatedAt,
      min_version: bundle.minVersion ?? null,
      etag: null,
      last_modified: null,
      checked_at: bundle.generatedAt,
    }),
  });
  const config: OpenClawConfig = {
    plugins: { allow: [provider], entries: { [provider]: { enabled: true } } },
  };
  return { config, agentDir, provider };
}

function writeFixtureManifest(root: string, pluginId: string, providers: Record<string, unknown>) {
  const pluginDir = path.join(root, "extensions", pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({ id: pluginId, modelCatalog: { providers } }, null, 2)}\n`,
  );
}

function nativeManifests(source: "OpenCode" | "Venice" | "Chutes" | "Cerebras" | "DeepInfra") {
  const provider = source.toLowerCase();
  const sourceId = source === "OpenCode" ? "openCode" : provider;
  return [
    {
      pluginId: "fixture",
      manifestPath: "fixture.json",
      manifest: {
        providers: ["anthropic", "openai", provider],
        modelCatalog: {
          providers: {
            anthropic: fixtureProvider("claude", 100),
            openai: fixtureProvider("gpt", 100),
            [provider]: { models: [{ id: "priced-fixture", cost: { input: 99, output: 99 } }] },
          },
        },
        modelPricing: {
          providers: {
            [provider]: {
              external: true,
              [sourceId]: { provider: source === "OpenCode" ? "upstream-zen" : provider },
              openRouter: { provider },
              liteLLM: { provider },
            },
          },
        },
      },
    },
  ];
}

function openCodePrices(
  cost: Record<string, unknown>,
  ids = ["priced-fixture", "new-priced-fixture"],
) {
  return {
    "upstream-zen": {
      id: "upstream-zen",
      models: Object.fromEntries(ids.map((id) => [id, { id, cost }])),
    },
  };
}

function venicePrices(
  pricing: Record<string, unknown>,
  ids = ["priced-fixture", "new-priced-fixture"],
) {
  return {
    data: ids.map((id) => ({
      id,
      type: "text",
      model_spec: { pricing },
    })),
  };
}

const OPENCODE_PRICING_URL = "https://models.opencode.ai/api.json";
const VENICE_PRICING_URL = "https://api.venice.ai/api/v1/models";
const NATIVE_SOURCES = [
  { source: "OpenCode", provider: "opencode", url: OPENCODE_PRICING_URL },
  { source: "Venice", provider: "venice", url: VENICE_PRICING_URL },
] as const;

describe("publish model catalog", () => {
  it("publishes native DeepInfra array prices with discounts rather than generic rates", async () => {
    const manifests = nativeManifests("DeepInfra");
    const bundle = await assembleModelCatalogBundle({
      manifests,
      generatedAt: Date.now(),
      sourceCommit: "fixture",
    });
    const provider = bundle.providers.deepinfra!;
    for (const id of ["qualified", "absent", "free"]) {
      provider.models.push({
        ...provider.models[0]!,
        id,
        name: `Fixture ${id}`,
        contextWindow: 123456,
      });
    }
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      const url = requestUrl(input);
      if (url === "https://api.deepinfra.com/models/list") {
        return Response.json([
          {
            model_name: "priced-fixture",
            pricing: {
              type: "tokens",
              cents_per_input_token: 0.0002,
              cents_per_output_token: 0.001,
              discount: 0.5,
              rate_per_input_token_cached: 0.2,
            },
          },
          {
            model_name: "qualified",
            pricing: {
              type: "tokens",
              cents_per_input_token: 0.0002,
              cents_per_output_token: 0.001,
              full: "Higher rates at long context",
            },
          },
          ...["free", "standalone-free", "foreign/hidden"].map((model_name) => ({
            model_name,
            pricing: { type: "tokens", cents_per_input_token: 0, cents_per_output_token: 0 },
          })),
        ]);
      }
      if (url === OPENROUTER_MODELS_URL) {
        return Response.json({
          data: ["priced-fixture", "qualified", "absent", "absent-unbundled"].map((id) => ({
            id: `deepinfra/${id}`,
            pricing: { prompt: "1", completion: "1" },
          })),
        });
      }
      expect(url).toBe(LITELLM_PRICING_URL);
      return Response.json({
        absent: {
          litellm_provider: "deepinfra",
          input_cost_per_token: 1,
          output_cost_per_token: 1,
        },
      });
    });
    await enrichModelCatalogPricing({ bundle, manifests, fetchImpl });
    expect(bundle.providers.deepinfra?.models[0]?.cost).toEqual({
      input: 1,
      output: 5,
      cacheRead: 0.2,
      cacheWrite: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const id of ["qualified", "absent"]) {
      const model = bundle.providers.deepinfra?.models.find((row) => row.id === id);
      expect(model).toMatchObject({ name: `Fixture ${id}`, contextWindow: 123456 });
      expect(model?.cost).toBeUndefined();
    }
    for (const id of ["priced-fixture", "qualified", "absent", "absent-unbundled"]) {
      expect(bundle.pricing).not.toHaveProperty(`deepinfra/${id}`);
    }
    expect(bundle.pricing).not.toHaveProperty("absent");
    expect(bundle.pricing).not.toHaveProperty("foreign/hidden");
    expect(bundle.providers).not.toHaveProperty("foreign");
    const params = publishedPricingParams(bundle, "deepinfra");
    for (const model of ["free", "standalone-free"]) {
      expect(bundle.pricing?.[`deepinfra/${model}`]).toEqual({ input: 0, output: 0 });
      expect(resolveModelCostConfig({ ...params, model })).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
    }
    expect(resolveModelCostConfig({ ...params, model: "qualified" })).toBeUndefined();
  });

  it.each(["outage", "object response", "malformed qualified price"])(
    "rejects DeepInfra %s before mutating the previous bundle",
    async (scenario) => {
      const manifests = nativeManifests("DeepInfra");
      const bundle = await assembleModelCatalogBundle({
        manifests,
        generatedAt: Date.now(),
        sourceCommit: "fixture",
      });
      const previous = serializeModelCatalogBundle(bundle);
      await expect(
        enrichModelCatalogPricing({
          bundle,
          manifests,
          fetchImpl: async (input) => {
            const url = requestUrl(input);
            if (url === "https://api.deepinfra.com/models/list") {
              if (scenario === "outage") {
                return new Response("unavailable", { status: 503 });
              }
              if (scenario === "object response") {
                return Response.json({ data: [] });
              }
              return Response.json([
                {
                  model_name: "fixture/bad",
                  pricing: {
                    type: "tokens",
                    cents_per_input_token: -1,
                    cents_per_output_token: 0.001,
                    full: "Qualified",
                  },
                },
              ]);
            }
            return Response.json(url === OPENROUTER_MODELS_URL ? { data: [] } : {});
          },
        }),
      ).rejects.toThrow("DeepInfra pricing");
      expect(serializeModelCatalogBundle(bundle)).toBe(previous);
    },
  );

  it("assembles and validates fixture manifests at the 200-model floor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-publish-catalog-"));
    tempDirs.push(root);
    writeFixtureManifest(root, "anthropic", { anthropic: fixtureProvider("claude", 100) });
    writeFixtureManifest(root, "openai", { openai: fixtureProvider("gpt", 100) });

    const bundle = await assembleModelCatalogBundle({
      manifests: readModelCatalogManifests({ rootDir: root }),
      generatedAt: Date.now(),
      sourceCommit: "fixture-sha",
    });
    expect(summarizeModelCatalogBundle(bundle)).toEqual({
      providers: 2,
      models: 200,
      costModels: 0,
      pricingEntries: 0,
    });
    expect(MODEL_CATALOG_MIN_MODELS).toBe(200);
  });

  it("rejects missing required providers, low counts, and invalid provider rows", async () => {
    const makeEntry = (providers: Record<string, unknown>) => [
      {
        pluginId: "fixture",
        manifestPath: "fixture.json",
        manifest: { modelCatalog: { providers } },
      },
    ];
    await expect(
      assembleModelCatalogBundle({
        manifests: makeEntry({ anthropic: fixtureProvider("claude", 200) }),
        generatedAt: Date.now(),
        sourceCommit: "fixture-sha",
      }),
    ).rejects.toThrow("anthropic and openai");
    await expect(
      assembleModelCatalogBundle({
        manifests: makeEntry({
          anthropic: fixtureProvider("claude", 100),
          openai: fixtureProvider("gpt", 99),
        }),
        generatedAt: Date.now(),
        sourceCommit: "fixture-sha",
      }),
    ).rejects.toThrow("below required floor 200");
    await expect(
      assembleModelCatalogBundle({
        manifests: makeEntry({
          anthropic: fixtureProvider("claude", 100),
          openai: { models: [{ id: "" }, ...fixtureProvider("gpt", 100).models] },
        }),
        generatedAt: Date.now(),
        sourceCommit: "fixture-sha",
      }),
    ).rejects.toThrow();
  });

  it("parses supported CLI arguments and rejects missing output", () => {
    expect(parsePublishModelCatalogArgs(["--dry-run", "--out", "ignored.json"])).toEqual({
      dryRun: true,
      pricing: false,
      out: "ignored.json",
    });
    expect(() => parsePublishModelCatalogArgs([])).toThrow("provide --out");
  });

  it("dry-runs the repository manifests without writing output", () => {
    const root = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-publish-catalog-smoke-"));
    tempDirs.push(tempDir);
    const out = path.join(tempDir, "catalog.json");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/publish-model-catalog.mts", "--dry-run", "--out", out],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const stats = /dry-run schemaVersion=1 providers=[1-9]\d* models=(\d+)/u.exec(result.stdout);
    expect(stats).not.toBeNull();
    expect(Number(stats?.[1])).toBeGreaterThanOrEqual(MODEL_CATALOG_MIN_MODELS);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("enriches catalog models and emits unmatched hosted pricing keys", async () => {
    const anthropic = fixtureProvider("claude", 100);
    anthropic.models[0] = { id: "claude-3-5-sonnet" };
    const openai = fixtureProvider("gpt", 100);
    openai.models[0] = { id: "gpt-special" };
    openai.models[1] = { id: "zero-upstream", cost: { input: 5, output: 6 } };
    const manifests = [
      {
        pluginId: "anthropic",
        manifestPath: "anthropic.json",
        manifest: {
          providers: ["anthropic"],
          modelCatalog: { providers: { anthropic } },
          modelPricing: {
            providers: { anthropic: { openRouter: { modelIdTransforms: ["version-dots"] } } },
          },
        },
      },
      {
        pluginId: "openai",
        manifestPath: "openai.json",
        manifest: { modelCatalog: { providers: { openai } } },
      },
      {
        pluginId: "openrouter",
        manifestPath: "openrouter.json",
        manifest: {
          providers: ["openrouter"],
          modelPricing: {
            providers: {
              openrouter: {
                openRouter: { passthroughProviderModel: true },
                liteLLM: false,
              },
            },
          },
        },
      },
      {
        pluginId: "mapped",
        manifestPath: "mapped.json",
        manifest: {
          providers: ["mapped"],
          modelPricing: {
            providers: {
              mapped: { openRouter: { provider: "approved-source" }, liteLLM: false },
            },
          },
        },
      },
    ];
    const bundle = await assembleModelCatalogBundle({
      manifests,
      generatedAt: Date.now(),
      sourceCommit: "fixture-sha",
    });
    const fetchImpl = async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === OPENROUTER_MODELS_URL) {
        return Response.json({
          data: [
            {
              id: "anthropic/claude-3.5-sonnet",
              pricing: { prompt: "0.000001", completion: "0.000002" },
            },
            {
              id: "openai/gpt-special",
              pricing: {
                prompt: "0.000003",
                completion: "0.000004",
                input_cache_read: "0.0000005",
                input_cache_write: "0.0000025",
                overrides: [{ min_prompt_tokens: 1000, prompt: "0.000007" }],
              },
            },
            { id: "openai/gpt-2", pricing: { prompt: "-1", completion: "0.000004" } },
            { id: "unknown/new-model", pricing: { prompt: "1", completion: "1" } },
            { id: "custom/secondary-wins", pricing: { prompt: "0", completion: "0" } },
            { id: "mapped/wrong-source", pricing: { prompt: "0.000013", completion: "0.000014" } },
          ],
        });
      }
      expect(url).toBe(LITELLM_PRICING_URL);
      return Response.json({
        "gpt-special": {
          litellm_provider: "openai",
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000004,
          tiered_pricing: [
            { input_cost_per_token: 0.000005, output_cost_per_token: 0.000006, range: [1000] },
          ],
        },
        "gpt-2": {
          litellm_provider: "openai",
          input_cost_per_token: -1,
          output_cost_per_token: 0.000004,
        },
        "unknown/new-model": { input_cost_per_token: 1, output_cost_per_token: 1 },
        "external-model": {
          litellm_provider: "custom",
          input_cost_per_token: 0.000007,
          output_cost_per_token: 0.000008,
        },
        "forbidden-model": {
          litellm_provider: "openrouter",
          input_cost_per_token: 0.000009,
          output_cost_per_token: 0.00001,
        },
        "secondary-wins": {
          litellm_provider: "custom",
          input_cost_per_token: 0.000011,
          output_cost_per_token: 0.000012,
        },
        "zero-upstream": {
          litellm_provider: "openai",
          input_cost_per_token: 0,
          output_cost_per_token: 0,
        },
      });
    };

    await expect(enrichModelCatalogPricing({ bundle, manifests, fetchImpl })).resolves.toEqual({
      modelsEnriched: 2,
      pricingEntries: 11,
    });
    expect(bundle.providers.anthropic?.models[0]?.cost).toMatchObject({ input: 1, output: 2 });
    const tieredPricing = [
      { input: 3, output: 4, cacheRead: 0.5, cacheWrite: 2.5, range: [0, 1001] },
      { input: 7, output: 4, cacheRead: 0.5, cacheWrite: 2.5, range: [1001] },
    ];
    expect(bundle.providers.openai?.models[0]?.cost).toEqual({
      input: 3,
      output: 4,
      cacheRead: 0.5,
      cacheWrite: 2.5,
      tieredPricing,
    });
    expect(bundle.providers.openai?.models[1]?.cost).toEqual({ input: 5, output: 6 });
    expect(bundle.providers.openai?.models[2]?.cost).toBeUndefined();
    expect(bundle.pricing).toEqual({
      "anthropic/claude-3.5-sonnet": { input: 1, output: 2 },
      "custom/external-model": { input: 7, output: 8 },
      "custom/secondary-wins": { input: 11, output: 12 },
      "external-model": { input: 7, output: 8 },
      "forbidden-model": { input: 9, output: 10 },
      "openrouter/anthropic/claude-3.5-sonnet": { input: 1, output: 2 },
      "openrouter/mapped/wrong-source": { input: 13, output: 14 },
      "openrouter/openai/gpt-special": {
        input: 3,
        output: 4,
        cacheRead: 0.5,
        cacheWrite: 2.5,
        tieredPricing,
      },
      "openrouter/unknown/new-model": { input: 1_000_000, output: 1_000_000 },
      "secondary-wins": { input: 11, output: 12 },
      "unknown/new-model": { input: 1_000_000, output: 1_000_000 },
    });
    expect(bundle.pricing).not.toHaveProperty("openrouter/forbidden-model");
    expect(bundle.pricing).not.toHaveProperty("mapped/wrong-source");
    expect(bundle.pricing).not.toHaveProperty("gpt-special");
    expect(bundle.pricing).not.toHaveProperty("openai/gpt-special");
    expect(summarizeModelCatalogBundle(bundle)).toMatchObject({
      models: 200,
      costModels: 3,
      pricingEntries: 11,
    });
    expect(Object.hasOwn(bundle.providers, "unknown")).toBe(false);
  });

  it.each([
    {
      source: "Chutes" as const,
      url: "https://llm.chutes.ai/v1/models",
      pricing: { prompt: 2, completion: 3, input_cache_read: 0.2 },
      cost: { input: 2, output: 3, cacheRead: 0.2, cacheWrite: 0 },
    },
    {
      source: "Cerebras" as const,
      url: "https://api.cerebras.ai/public/v1/models",
      pricing: { prompt: "0.000002", completion: "0.000003" },
      cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
    },
  ])(
    "publishes $source native rates with the provider's actual units",
    async ({ source, url, pricing, cost }) => {
      const provider = source.toLowerCase();
      const manifests = nativeManifests(source);
      const bundle = await assembleModelCatalogBundle({
        manifests,
        generatedAt: Date.now(),
        sourceCommit: "fixture",
      });
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        if (requestUrl(input) === url) {
          return Response.json({
            data: ["priced-fixture", "new-priced-fixture", "foreign/hidden"].map((id) => ({
              id,
              pricing,
            })),
          });
        }
        return Response.json({ data: [] });
      });
      await enrichModelCatalogPricing({ bundle, manifests, fetchImpl });
      expect(bundle.providers[provider]?.models[0]?.cost).toEqual(cost);
      expect(bundle.pricing?.[`${provider}/new-priced-fixture`]).toEqual({
        input: 2,
        output: 3,
        ...(cost.cacheRead > 0 ? { cacheRead: cost.cacheRead } : {}),
      });
      expect(bundle.pricing).not.toHaveProperty(`${provider}/priced-fixture`);
      expect(bundle.pricing).not.toHaveProperty("foreign/hidden");
      expect(bundle.providers).not.toHaveProperty("foreign");
      expect(fetchImpl.mock.calls.filter(([input]) => requestUrl(input) === url)).toHaveLength(1);
    },
  );

  describe.each(NATIVE_SOURCES)("$source native source", ({ source, provider, url }) => {
    it("refreshes one complete owner schedule and publishes new models in that namespace only", async () => {
      const manifests = nativeManifests(source);
      const bundle = await assembleModelCatalogBundle({
        manifests,
        generatedAt: Date.now(),
        sourceCommit: "fixture",
      });
      const base = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
      const extended = { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 };
      const payload =
        source === "OpenCode"
          ? {
              ...openCodePrices({
                input: 2,
                output: 10,
                cache_read: 0.2,
                cache_write: 2.5,
                tiers: [
                  {
                    input: 4,
                    output: 15,
                    cache_read: 0.4,
                    cache_write: 5,
                    tier: { type: "context", size: 272_000 },
                  },
                ],
                context_over_200k: { input: 88, output: 88 },
              }),
              unrelated: {
                id: "unrelated",
                models: { hidden: { id: "hidden", cost: { input: 99, output: 99 } } },
              },
            }
          : {
              data: [
                ...venicePrices({
                  input: { usd: 2 },
                  output: { usd: 10 },
                  cache_input: { usd: 0.2 },
                  cache_write: { usd: 2.5 },
                  extended: {
                    context_token_threshold: 272_000,
                    input: { usd: 4 },
                    output: { usd: 15 },
                    cache_input: { usd: 0.4 },
                    cache_write: { usd: 5 },
                  },
                }).data,
                {
                  id: "unrelated/hidden",
                  type: "text",
                  model_spec: { pricing: { input: { usd: 3 }, output: { usd: 4 } } },
                },
                {
                  id: "non-text",
                  type: "image",
                  model_spec: { pricing: { input: { usd: 3 }, output: { usd: 4 } } },
                },
              ],
            };
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        const request = requestUrl(input);
        if (request === url) {
          return Response.json(payload);
        }
        if (request === OPENROUTER_MODELS_URL) {
          return Response.json({
            data: [{ id: `${provider}/priced-fixture`, pricing: { prompt: "1", completion: "1" } }],
          });
        }
        expect(request).toBe(LITELLM_PRICING_URL);
        return Response.json({});
      });

      await enrichModelCatalogPricing({ bundle, manifests, fetchImpl });

      const boundary = source === "Venice" ? 272_001 : 272_000;
      const expectedPricing = {
        ...base,
        tieredPricing: [
          { ...base, range: [0, boundary] },
          { ...extended, range: [boundary] },
        ],
      };
      expect(bundle.providers[provider]?.models[0]?.cost).toEqual(expectedPricing);
      expect(bundle.pricing?.[`${provider}/new-priced-fixture`]).toEqual(expectedPricing);
      expect(fetchImpl.mock.calls.filter(([input]) => requestUrl(input) === url)).toHaveLength(1);
      expect(bundle.providers).not.toHaveProperty("unrelated");
      expect(bundle.pricing).not.toHaveProperty("unrelated/hidden");
      expect(bundle.pricing).not.toHaveProperty("upstream-zen/priced-fixture");
      expect(bundle.pricing).not.toHaveProperty(`${provider}/priced-fixture`);
      expect(bundle.pricing).not.toHaveProperty(`${provider}/non-text`);
      if (source === "Venice") {
        expect(bundle.pricing?.["venice/unrelated/hidden"]).toEqual({ input: 3, output: 4 });
      }
    });

    it("resolves published native zeros as free for paid seeds and standalone models", async () => {
      const manifests = nativeManifests(source);
      const bundle = await assembleModelCatalogBundle({
        manifests,
        generatedAt: Date.now(),
        sourceCommit: "fixture",
      });
      const fetchImpl: typeof fetch = async (input) => {
        if (requestUrl(input) === url) {
          return Response.json(
            source === "OpenCode"
              ? openCodePrices({ input: 0, output: 0 })
              : venicePrices({ input: { usd: 0 }, output: { usd: 0 } }),
          );
        }
        return Response.json({ data: [] });
      };
      await enrichModelCatalogPricing({ bundle, manifests, fetchImpl });
      expect(bundle.providers[provider]?.models[0]?.cost).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      const params = publishedPricingParams(bundle, provider);
      for (const model of ["priced-fixture", "new-priced-fixture"]) {
        expect(bundle.pricing?.[`${provider}/${model}`]).toEqual({ input: 0, output: 0 });
        const cost = resolveModelCostConfig({ ...params, model });
        expect.soft(cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        expect
          .soft(estimateAggregateUsageCost({ cost, usage: { input: 1000, output: 1000 } }))
          .toBe(0);
      }
    });

    it.each([
      { kind: "paid", cost: { input: 99, output: 99 } },
      { kind: "zero", cost: { input: 0, output: 0 } },
      { kind: "unpriced", cost: undefined },
    ])(
      "preserves $kind model metadata without inventing an unavailable native price",
      async ({ cost }) => {
        const manifests = nativeManifests(source);
        const bundle = await assembleModelCatalogBundle({
          manifests,
          generatedAt: Date.now(),
          sourceCommit: "fixture",
        });
        const model = bundle.providers[provider]!.models[0]!;
        model.cost = cost;
        model.name = "Existing explicit model";
        model.contextWindow = 123_456;
        model.status = "deprecated";
        const expected = { ...model };
        delete expected.cost;
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          await enrichModelCatalogPricing({
            bundle,
            manifests,
            fetchImpl: async (input) => {
              const request = requestUrl(input);
              if (request === url) {
                return Response.json(
                  source === "OpenCode"
                    ? openCodePrices({ input: 2, output: 3 }, ["new-priced-fixture"])
                    : venicePrices({ input: { usd: 2 }, output: { usd: 3 } }, [
                        "new-priced-fixture",
                      ]),
                );
              }
              if (request === OPENROUTER_MODELS_URL) {
                return Response.json({
                  data: [
                    { id: `${provider}/priced-fixture`, pricing: { prompt: "1", completion: "1" } },
                    {
                      id: `${provider}/absent-unbundled`,
                      pricing: { prompt: "1", completion: "1" },
                    },
                  ],
                });
              }
              return Response.json({
                "priced-fixture": {
                  litellm_provider: provider,
                  input_cost_per_token: 1,
                  output_cost_per_token: 1,
                },
              });
            },
          });
          expect(bundle.providers[provider]?.models[0]).toEqual(expected);
          expect(bundle.pricing).not.toHaveProperty(`${provider}/priced-fixture`);
          expect(bundle.pricing).not.toHaveProperty(`${provider}/absent-unbundled`);
          expect(bundle.pricing).not.toHaveProperty("priced-fixture");
          expect(bundle.pricing?.[`${provider}/new-priced-fixture`]).toEqual({
            input: 2,
            output: 3,
          });
          expect(stderr.mock.calls.map(([message]) => String(message)).join("")).toContain(
            `${source} pricing unavailable for ${provider}/priced-fixture`,
          );
          expect(
            resolveModelCostConfig({
              ...publishedPricingParams(bundle, provider),
              model: "priced-fixture",
            }),
          ).toBeUndefined();
        } finally {
          stderr.mockRestore();
        }
      },
    );

    it.each([
      "unreachable",
      "malformed JSON",
      "malformed body",
      "empty catalog",
      "invalid price",
      "invalid zero seed",
    ])("rejects %s instead of publishing unverified prices", async (scenario) => {
      const manifests = nativeManifests(source);
      const bundle = await assembleModelCatalogBundle({
        manifests,
        generatedAt: Date.now(),
        sourceCommit: "fixture",
      });
      if (scenario === "invalid zero seed") {
        bundle.providers[provider]!.models[0]!.cost = { input: 0, output: 0 };
      }
      const fetchImpl: typeof fetch = async (input) => {
        const request = requestUrl(input);
        if (request === OPENROUTER_MODELS_URL) {
          return Response.json({ data: [] });
        }
        if (request === LITELLM_PRICING_URL) {
          return Response.json({});
        }
        expect(request).toBe(url);
        if (scenario === "unreachable") {
          throw new Error("source unavailable");
        }
        if (scenario === "malformed JSON") {
          return new Response("not JSON");
        }
        if (scenario === "malformed body") {
          return Response.json({});
        }
        if (scenario === "empty catalog") {
          return Response.json(
            source === "OpenCode"
              ? { "upstream-zen": { id: "upstream-zen", models: {} } }
              : { data: [] },
          );
        }
        return Response.json(
          source === "OpenCode"
            ? openCodePrices({ input: -1, output: 2 })
            : venicePrices({
                input: { usd: 2 },
                output: { usd: 10 },
                extended: { context_token_threshold: 200_000, input: { usd: 4 } },
              }),
        );
      };
      await expect(enrichModelCatalogPricing({ bundle, manifests, fetchImpl })).rejects.toThrow(
        `${source} pricing`,
      );
    });

    it.each(["missing policy", "unowned policy", "disabled policy"])(
      "does not fetch without an owning opt-in: %s",
      async (scenario) => {
        const manifests = nativeManifests(source);
        if (scenario === "missing policy") {
          delete manifests[0]!.manifest.modelPricing.providers[provider];
        }
        if (scenario === "unowned policy") {
          manifests[0]!.manifest.providers = ["anthropic", "openai"];
        }
        if (scenario === "disabled policy") {
          manifests[0]!.manifest.modelPricing.providers[provider]!.external = false;
        }
        const bundle = await assembleModelCatalogBundle({
          manifests,
          generatedAt: Date.now(),
          sourceCommit: "fixture",
        });
        const fetchImpl = vi.fn<typeof fetch>(async (input) => {
          expect(requestUrl(input)).not.toBe(url);
          return Response.json({ data: [] });
        });
        await enrichModelCatalogPricing({ bundle, manifests, fetchImpl });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("fails soft when pricing sources are unreachable or malformed", async () => {
    const manifests = [
      {
        pluginId: "fixture",
        manifestPath: "fixture.json",
        manifest: {
          modelCatalog: {
            providers: {
              anthropic: fixtureProvider("claude", 100),
              openai: fixtureProvider("gpt", 100),
            },
          },
        },
      },
    ];
    const bundle = await assembleModelCatalogBundle({
      manifests,
      generatedAt: Date.now(),
      sourceCommit: "fixture-sha",
    });
    const warnings: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      warnings.push(String(value));
      return true;
    });
    try {
      await expect(
        enrichModelCatalogPricing({
          bundle,
          manifests,
          fetchImpl: async (input) => {
            if (requestUrl(input) === OPENROUTER_MODELS_URL) {
              throw new Error("offline");
            }
            return new Response("not-json", { status: 200 });
          },
        }),
      ).resolves.toEqual({ modelsEnriched: 0, pricingEntries: 0 });
    } finally {
      stderr.mockRestore();
    }
    expect(warnings.join("")).toContain("OpenRouter pricing unavailable");
    expect(warnings.join("")).toContain("LiteLLM pricing unavailable");
    expect(summarizeModelCatalogBundle(bundle).costModels).toBe(0);
  });

  it("serializes provider keys and model rows deterministically", () => {
    const base = {
      schemaVersion: 1,
      generatedAt: 1,
      minVersion: "2026.7.0",
      sourceCommit: "sha",
    } as const;
    const left = {
      ...base,
      providers: { zeta: { models: [{ id: "b" }, { id: "a" }] }, alpha: { models: [{ id: "c" }] } },
      pricing: { "z/model": { input: 2, output: 3 }, "a/model": { input: 1, output: 2 } },
    };
    const right = {
      ...base,
      providers: { alpha: { models: [{ id: "c" }] }, zeta: { models: [{ id: "a" }, { id: "b" }] } },
      pricing: { "a/model": { output: 2, input: 1 }, "z/model": { output: 3, input: 2 } },
    };
    expect(serializeModelCatalogBundle(left)).toBe(serializeModelCatalogBundle(right));
  });

  it.each([
    { source: "OpenCode", scenario: "unreachable" },
    ...["unreachable", "malformed body", "invalid price"].map((scenario) => ({
      source: "DeepInfra",
      scenario,
    })),
    ...["unreachable", "malformed body", "missing model", "invalid price"].map((scenario) => ({
      source: "Venice",
      scenario,
    })),
  ])(
    "leaves published output untouched when $source pricing is $scenario",
    ({ source, scenario }) => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-publish-failure-")),
      );
      tempDirs.push(root);
      const out = path.join(root, "catalog.json");
      const preload = path.join(root, "offline.mjs");
      fs.writeFileSync(out, "previous published catalog\n");
      fs.writeFileSync(
        preload,
        `const manifests = ${JSON.stringify(readModelCatalogManifests().map((entry) => entry.manifest))};
const openCode = {};
for (const manifest of manifests) {
  for (const [provider, policy] of Object.entries(manifest.modelPricing?.providers ?? {})) {
    if (!policy.openCode) continue;
    const id = policy.openCode.provider ?? provider;
    const models = manifest.modelCatalog?.providers?.[provider]?.models ?? [];
    openCode[id] = { id, models: Object.fromEntries(models.map((model) => [model.id, { id: model.id, cost: { input: 1, output: 2 } }])) };
  }
}
globalThis.fetch = async (url) => {
  if (${JSON.stringify(source)} === "OpenCode") throw new Error("fixture outage");
  if (url === ${JSON.stringify(OPENCODE_PRICING_URL)}) return Response.json(openCode);
  if (${JSON.stringify(source)} === "DeepInfra") {
    if (url === "https://api.deepinfra.com/models/list") {
      if (${JSON.stringify(scenario)} === "unreachable") throw new Error("fixture outage");
      if (${JSON.stringify(scenario)} === "malformed body") return Response.json({ data: [] });
      return Response.json([{ model_name: "fixture/bad", pricing: { type: "tokens", cents_per_input_token: -1, cents_per_output_token: 0.001, full: "Qualified" } }]);
    }
    if (url === "https://llm.chutes.ai/v1/models") return Response.json({ data: [{ id: "fixture/chat", pricing: { prompt: 2, completion: 10 } }] });
    if (url === "https://api.cerebras.ai/public/v1/models") return Response.json({ data: [{ id: "fixture/chat", pricing: { prompt: "0.000002", completion: "0.00001" } }] });
    if (url === ${JSON.stringify(VENICE_PRICING_URL)}) return Response.json({ data: [{ id: "fixture/chat", type: "text", model_spec: { pricing: { input: { usd: 2 }, output: { usd: 10 } } } }] });
  }
  if (url === ${JSON.stringify(VENICE_PRICING_URL)}) {
    if (${JSON.stringify(scenario)} === "unreachable") throw new Error("fixture outage");
    if (${JSON.stringify(scenario)} === "malformed body") return Response.json({});
    if (${JSON.stringify(scenario)} === "invalid price") return Response.json({ data: manifests.flatMap((manifest) => (manifest.modelCatalog?.providers?.venice?.models ?? []).map((model) => ({ id: model.id, type: "text", model_spec: { pricing: { input: { usd: -1 }, output: { usd: 2 } } } }))) });
  }
  return Response.json({ data: [] });
};`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          preload,
          "scripts/publish-model-catalog.mts",
          "--pricing",
          "--out",
          out,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(`${source} pricing`);
      expect(result.stderr.trim().split("\n").at(-1)).toBe(
        "[publish-model-catalog] FAILED (exit 1)",
      );
      expect(fs.readFileSync(out, "utf8")).toBe("previous published catalog\n");
    },
  );
});
