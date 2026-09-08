import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
} from "./model-catalog-visibility.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import {
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "./openai-model-routes.js";

describe("provider-owned catalog identity", () => {
  const authored: ModelCatalogEntry = {
    provider: "arcee",
    id: "arcee-ai/trinity-large-thinking",
    name: "Authored default",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    contextWindow: 32768,
    reasoning: false,
  };
  const cfg: OpenClawConfig = {
    plugins: { allow: ["arcee"] },
    agents: {
      defaults: {
        model: { primary: "arcee/trinity-large-thinking" },
        models: { "arcee/trinity-large-thinking": { alias: "Authored alias" } },
      },
    },
    models: {
      mode: "replace",
      providers: {
        arcee: {
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-completions",
          models: [
            {
              id: authored.id,
              name: "Authored default",
              contextWindow: 32768,
              reasoning: false,
              input: ["text"],
              maxTokens: 2048,
              cost: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
            },
          ],
        },
      },
    },
  };

  async function project(catalog: ModelCatalogEntry[]) {
    return resolveLogicalVisibleModelCatalog({
      cfg,
      catalog,
      defaultProvider: "arcee",
      defaultModel: "trinity-large-thinking",
      view: "all",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async () =>
        resolveLogicalModelCatalogEntryState({
          evaluation: { availability: true, routeResolution: null },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
    });
  }

  it("joins equivalent provider-owned spellings before authored metadata projection", async () => {
    const rows = await project([
      authored,
      {
        ...authored,
        id: "trinity-large-thinking",
        name: "Trinity Large Thinking",
        contextWindow: 262144,
        reasoning: true,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "arcee",
      id: "trinity-large-thinking",
      name: "Authored default",
      contextWindow: 32768,
      reasoning: false,
    });
  });

  it("retains the existing same-spelling deduplication control", async () => {
    const rows = await project([
      authored,
      { ...authored, name: "Static sibling", contextWindow: 262144, reasoning: true },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "arcee",
      name: "Authored default",
      contextWindow: 32768,
      reasoning: false,
    });
  });
  it("keeps unknown model case and separate credential providers distinct", () => {
    expect(resolveModelCatalogIdentityKey({ provider: "custom", id: "Reader" })).not.toBe(
      resolveModelCatalogIdentityKey({ provider: "custom", id: "reader" }),
    );
    expect(
      resolveModelCatalogIdentityKey({ provider: "arcee", id: "arcee-ai/trinity-large-thinking" }),
    ).not.toBe(
      resolveModelCatalogIdentityKey({
        provider: "openrouter",
        id: "arcee-ai/trinity-large-thinking",
      }),
    );
  });
});
