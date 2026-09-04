// Covers the best-effort contract of the bundled static catalog context
// enrichment: a failing static catalog hook must not break the caller's
// config-authored or default context-token fallback chain (#127239).
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMemoryFlushContextWindowTokens } from "../auto-reply/reply/memory-flush.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBundledStaticCatalogContext, resetContextWindowCacheForTest } from "./context.js";

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
    } as OpenClawConfig;
    expect(
      await resolveMemoryFlushContextWindowTokens({
        cfg,
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
      }),
    ).toBe(272_000);
  });
});
