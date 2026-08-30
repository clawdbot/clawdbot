import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "../utils/usage-format.js";
import { resolveModelPricing, resolveModelPricingContext } from "./pricing.js";
import {
  resetRemoteModelCatalogOverlayForTest,
  setRemoteModelCatalogOverlaySourcesForTest,
} from "./remote-overlay.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readStoredCatalog = vi.fn();

beforeEach(() => {
  resetRemoteModelCatalogOverlayForTest();
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
  setRemoteModelCatalogOverlaySourcesForTest();
  resetRemoteModelCatalogOverlayForTest();
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
    const context = resolveModelPricingContext({ config: configFor("https://api.openai.com/v1") });

    expect(
      [model, `openai/${model}`].map(
        (modelId) => resolveModelPricing(context, context.normalizeKey("openai", modelId))?.input,
      ),
    ).toEqual(expected);
  });

  it("checks the exact model endpoint before applying hosted pricing", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: ["pricing-hosted", "openai/pricing-hosted"].map((id, index) => ({
              id,
              name: id,
              baseUrl: index === 1 ? "http://127.0.0.1:8080/v1" : undefined,
              reasoning: false,
              input: ["text" as const],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 8192,
            })),
          },
        },
      },
    };

    const context = resolveModelPricingContext({ config });
    expect(
      resolveModelPricing(context, context.normalizeKey("openai", "pricing-hosted"))?.input,
    ).toBe(4);
    expect(
      resolveModelPricing(context, context.normalizeKey("openai", "openai/pricing-hosted")),
    ).toBeUndefined();
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
    resetRemoteModelCatalogOverlayForTest();

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
