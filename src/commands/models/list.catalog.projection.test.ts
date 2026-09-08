import { describe, expect, it, vi } from "vitest";
import { createModelCatalogView } from "../../agents/model-catalog-view.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import { toListRowInput, toModelRow } from "./list.model-row.js";

describe("catalog view to CLI row", () => {
  it("does not repeat configured metadata lookup after filtering", () => {
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
    const model: ModelCatalogEntry = {
      id: "model-1",
      name: "Catalog Model",
      api: "openai-completions",
      provider: "bench",
      baseUrl: "https://models.example.test/v1",
      input: ["text"],
      contextWindow: 8192,
    };
    const view = createModelCatalogView({ cfg: { models: { providers } }, catalog: [model] });
    const evaluation = { availability: true, routeResolution: null };
    const { entry } = view.project(model, evaluation);
    const row = toModelRow({
      model: { ...entry, input: toListRowInput(entry.input) },
      key: "bench/model-1",
      tags: [],
      authAvailability: evaluation.availability,
    });

    expect(providerCatalogScan.mock.calls.length).toBeLessThanOrEqual(1);
    expect(row).toMatchObject({
      key: "bench/model-1",
      name: "Configured Model",
      input: "text+image",
      contextWindow: 64_000,
      available: true,
    });
  });
});
