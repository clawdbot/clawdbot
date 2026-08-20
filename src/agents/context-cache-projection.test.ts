import { afterEach, describe, expect, it } from "vitest";
import { prepareContextWindowCaches } from "./context-cache-projection.js";
import {
  lookupCachedContextTokens,
  lookupCachedContextWindow,
  replaceContextWindowCaches,
} from "./context-cache.js";
import { resetContextWindowCacheForTest } from "./context-runtime-state.js";

function publishConfiguredModel(model: string, contextWindow: number): void {
  replaceContextWindowCaches({
    configuredTokenCache: new Map([[model, contextWindow]]),
    discoveredTokenCache: new Map(),
    contextWindowCache: new Map(),
  });
}

function createLargeCatalog(prefix: string, count: number) {
  return {
    entries: Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`,
      provider: "synthetic",
      contextWindow: 64_000,
    })),
    staticEntries: [],
  };
}

describe("context cache projection", () => {
  afterEach(() => {
    resetContextWindowCacheForTest();
  });

  it("keeps the prior generation visible until a cooperative projection is complete", async () => {
    publishConfiguredModel("prior-model", 48_000);

    const pending = prepareContextWindowCaches({
      config: {
        models: {
          providers: {
            synthetic: {
              baseUrl: "https://example.invalid",
              models: [{ id: "next-model", contextWindow: 96_000 } as never],
            },
          },
        },
      },
      modelCatalog: createLargeCatalog("discovered", 600),
    });

    expect(lookupCachedContextTokens("prior-model")).toBe(48_000);
    expect(lookupCachedContextTokens("next-model")).toBeUndefined();

    replaceContextWindowCaches(await pending);
    expect(lookupCachedContextTokens("prior-model")).toBeUndefined();
    expect(lookupCachedContextWindow("next-model")).toBe(96_000);
    expect(lookupCachedContextTokens("discovered-599")).toBe(64_000);
  });

  it("does not publish a superseded cooperative projection", async () => {
    publishConfiguredModel("prior-model", 48_000);
    let current = true;
    const pending = prepareContextWindowCaches({
      config: {},
      modelCatalog: createLargeCatalog("superseded", 1_024),
      assertCurrent: () => {
        if (!current) {
          throw new Error("projection superseded");
        }
      },
    });
    current = false;

    await expect(pending).rejects.toThrow("projection superseded");
    expect(lookupCachedContextTokens("prior-model")).toBe(48_000);
    expect(lookupCachedContextTokens("superseded-1023")).toBeUndefined();
  });
});
