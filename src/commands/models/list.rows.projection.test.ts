import { describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { Model } from "../../llm/types.js";
import { appendDiscoveredRows, type RowBuilderContext } from "./list.rows.js";
import type { ModelRow } from "./list.types.js";

describe("appendDiscoveredRows projection", () => {
  it("does not repeat configured metadata lookup after filtering", async () => {
    const providerCatalogScan = vi.fn();
    const providers = new Proxy<Record<string, ModelProviderConfig>>(
      {
        bench: {
          api: "openai-completions",
          baseUrl: "https://models.example.test/v1",
          models: [
            {
              id: "model-1",
              name: "Configured Model",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 64_000,
              maxTokens: 4096,
            },
          ],
        },
      },
      {
        ownKeys(target) {
          providerCatalogScan();
          return Reflect.ownKeys(target);
        },
      },
    );
    const rows: ModelRow[] = [];
    const models: Model[] = [
      {
        id: "model-1",
        name: "Catalog Model",
        api: "openai-completions",
        provider: "bench",
        baseUrl: "https://models.example.test/v1",
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      },
    ];
    const context: RowBuilderContext = {
      cfg: { models: { providers } },
      agentDir: "/tmp/openclaw-agent",
      authIndex: {
        evaluateModelAuth: () => ({ availability: true, routeResolution: null }),
      },
      configuredByKey: new Map(),
      discoveredKeys: new Set(["bench/model-1"]),
      filter: {},
      skipRuntimeModelSuppression: true,
    };

    await appendDiscoveredRows({
      rows,
      models,
      context,
    });

    expect(providerCatalogScan.mock.calls.length).toBeLessThanOrEqual(1);
    expect(rows).toEqual([
      expect.objectContaining({
        key: "bench/model-1",
        name: "Configured Model",
        input: "text+image",
        contextWindow: 64_000,
        available: true,
      }),
    ]);
  });
});
