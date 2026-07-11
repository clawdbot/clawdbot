/**
 * Regression coverage for model catalog visibility filtering.
 * Keeps provider/model allow and hide rules aligned with catalog row metadata.
 */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
} from "./model-catalog-visibility.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { openAIModelCatalogRoutePolicy } from "./openai-model-routes.js";

describe("resolveLogicalVisibleModelCatalog", () => {
  const selectedRoute = {
    api: "openai-chatgpt-responses" as const,
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authRequirement: "subscription" as const,
    requestTransportOverrides: "none" as const,
  };
  const platform: ModelCatalogEntry = {
    provider: "openai",
    id: "gpt-5.5",
    name: "Platform GPT-5.5",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 1_000_000,
    reasoning: true,
    input: ["text", "image"],
  };
  const chatGPT: ModelCatalogEntry = {
    provider: "openai",
    id: "gpt-5.5",
    name: "ChatGPT GPT-5.5",
    api: "openai-chatgpt-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    contextWindow: 400_000,
    reasoning: false,
    input: ["text"],
  };

  it("dedupes physical routes after selected-route projection", async () => {
    const catalog = [platform, chatGPT];
    const result = await resolveLogicalVisibleModelCatalog({
      cfg: {} as OpenClawConfig,
      catalog,
      defaultProvider: "openai",
      view: "all",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async (entry) =>
        resolveLogicalModelCatalogEntryState({
          entry,
          evaluation: {
            availability: true,
            routeResolution: { kind: "routes", routes: [selectedRoute] },
            selectedRoute,
          },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
    });

    expect(result).toEqual([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "ChatGPT GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        contextWindow: 400_000,
        reasoning: false,
        input: ["text"],
      },
    ]);
  });

  it("omits physical capabilities while managed route selection is unresolved", async () => {
    const result = await resolveLogicalVisibleModelCatalog({
      cfg: {} as OpenClawConfig,
      catalog: [platform],
      defaultProvider: "openai",
      view: "all",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async (entry) =>
        resolveLogicalModelCatalogEntryState({
          entry,
          evaluation: {
            availability: false,
            routeResolution: { kind: "indeterminate", defaultRuntimeId: "codex" },
          },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
    });

    expect(result).toEqual([{ provider: "openai", id: "gpt-5.5", name: "Platform GPT-5.5" }]);
  });

  it.each([false, true])(
    "projects one canonical nano row from reversed physical variants (reverse=%s)",
    async (reverse) => {
      const platformNano: ModelCatalogEntry = {
        ...platform,
        id: "gpt-5.4-nano",
        name: "Platform Nano",
      };
      const chatGPTNano: ModelCatalogEntry = {
        ...chatGPT,
        id: "gpt-5.4-nano",
        name: "ChatGPT Nano",
      };
      const routeVariants = reverse ? [platformNano, chatGPTNano] : [chatGPTNano, platformNano];
      const evaluateEntry = vi.fn(
        async (entry: ModelCatalogEntry, _variants: readonly ModelCatalogEntry[]) =>
          resolveLogicalModelCatalogEntryState({
            entry,
            evaluation: {
              availability: true,
              routeResolution: { kind: "routes", routes: [selectedRoute] },
              selectedRoute,
            },
            routePolicy: openAIModelCatalogRoutePolicy,
          }),
      );

      const result = await resolveLogicalVisibleModelCatalog({
        cfg: {} as OpenClawConfig,
        catalog: [platformNano],
        routeVariants,
        defaultProvider: "openai",
        view: "all",
        routePolicy: openAIModelCatalogRoutePolicy,
        evaluateEntry,
      });

      expect(evaluateEntry).toHaveBeenCalledOnce();
      expect(evaluateEntry.mock.calls[0]?.[1]).toEqual(routeVariants);
      expect(result).toEqual([
        {
          provider: "openai",
          id: "gpt-5.4-nano",
          name: "ChatGPT Nano",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          contextWindow: 400_000,
          reasoning: false,
          input: ["text"],
        },
      ]);
    },
  );
});
