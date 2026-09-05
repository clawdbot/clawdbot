// Covers the best-effort contract of the bundled static catalog context
// enrichment: a failing static catalog hook must not break the caller's
// config-authored or default context-token fallback chain (#127239).
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMemoryFlushContextWindowTokens } from "../auto-reply/reply/memory-flush.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isCatalogOwnedContextResolution,
  resolveBundledStaticCatalogContext,
  resetContextWindowCacheForTest,
} from "./context.js";

vi.mock("./embedded-agent-runner/model.static-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createBundledStaticCatalogModelResolver: () => {
    throw new Error("manifest static catalog resolver exploded");
  },
  createBundledProviderStaticCatalogContextResolver: () => {
    throw new Error("bundled static catalog hook exploded");
  },
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRuntimeConfig: () => ({}),
}));

describe("bundled static catalog enrichment failure isolation", () => {
  afterEach(() => {
    resetContextWindowCacheForTest();
  });

  it("returns no enrichment when the bundled static catalog resolver rejects", async () => {
    resetContextWindowCacheForTest();
    await expect(
      resolveBundledStaticCatalogContext({
        provider: "deepseek",
        model: "deepseek-v4-flash",
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps the memory flush budget on the default fallback when enrichment rejects", async () => {
    resetContextWindowCacheForTest();
    expect(
      await resolveMemoryFlushContextWindowTokens({
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
      }),
    ).toBe(200_000);
  });

  it("keeps config authored context windows authoritative when enrichment rejects", async () => {
    resetContextWindowCacheForTest();
    const cfg = {
      models: {
        providers: {
          deepseek: {
            models: [{ id: "deepseek-v4-flash", contextWindow: 272_000 }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      await resolveMemoryFlushContextWindowTokens({
        cfg,
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
      }),
    ).toBe(272_000);
  });
});

describe("isCatalogOwnedContextResolution", () => {
  it.each([
    {
      name: "warm cache resolves the same catalog value through the discovered cache",
      staticCatalogContext: { modelContextWindow: 1_000_000 },
      resolvedTokens: 1_000_000,
      configOnlyTokens: 1_000_000,
      expected: true,
    },
    {
      name: "cold catalog resolution without config rows",
      staticCatalogContext: { modelContextWindow: 1_000_000 },
      resolvedTokens: 1_000_000,
      configOnlyTokens: undefined,
      expected: true,
    },
    {
      name: "authored cap below the catalog row is not catalog-owned",
      staticCatalogContext: { modelContextTokens: 200_000 },
      resolvedTokens: 100_000,
      configOnlyTokens: 100_000,
      expected: false,
    },
    {
      name: "authored cap equal to the catalog tokens stays catalog-owned",
      staticCatalogContext: { modelContextWindow: 1_050_000, modelContextTokens: 272_000 },
      resolvedTokens: 272_000,
      configOnlyTokens: 272_000,
      expected: true,
    },
    {
      name: "missing catalog context is never catalog-owned",
      staticCatalogContext: undefined,
      resolvedTokens: 200_000,
      configOnlyTokens: 200_000,
      expected: false,
    },
    {
      name: "unresolved model is never catalog-owned",
      staticCatalogContext: { modelContextWindow: 1_000_000 },
      resolvedTokens: undefined,
      configOnlyTokens: undefined,
      expected: false,
    },
  ])("$name", ({ staticCatalogContext, resolvedTokens, configOnlyTokens, expected }) => {
    expect(
      isCatalogOwnedContextResolution({
        staticCatalogContext,
        resolvedTokens,
        configOnlyTokens,
      }),
    ).toBe(expected);
  });
});
