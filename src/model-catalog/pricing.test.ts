import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "../utils/usage-format.js";
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
