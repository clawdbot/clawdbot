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
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";
import { openAIModelCatalogRoutePolicy } from "./openai-model-routes.js";

describe("resolveLogicalVisibleModelCatalog", () => {
  const selectedRoute = {
    api: "openai-chatgpt-responses" as const,
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authRequirement: "subscription" as const,
    requestTransportOverrides: "none" as const,
    runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
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

  const evaluateAvailableEntry = async (entry: ModelCatalogEntry) =>
    resolveLogicalModelCatalogEntryState({
      entry,
      evaluation: { availability: true, routeResolution: null },
      routePolicy: openAIModelCatalogRoutePolicy,
    });

  it.each(["default", "configured"] as const)(
    "hides deprecated and disabled rows from the %s picker view",
    async (view) => {
      const catalog: ModelCatalogEntry[] = [
        { provider: "demo", id: "current", name: "Current", status: "available" },
        { provider: "demo", id: "old", name: "Old", status: "deprecated" },
        { provider: "demo", id: "off", name: "Off", status: "disabled" },
      ];

      const result = await resolveLogicalVisibleModelCatalog({
        cfg: {} as OpenClawConfig,
        catalog,
        defaultProvider: "demo",
        view,
        routePolicy: openAIModelCatalogRoutePolicy,
        evaluateEntry: evaluateAvailableEntry,
      });

      expect(result.map((entry) => entry.id)).toEqual(["current"]);
    },
  );

  it("keeps deprecated and disabled rows in the all inventory", async () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: "demo", id: "old", name: "Old", status: "deprecated" },
      { provider: "demo", id: "off", name: "Off", status: "disabled" },
    ];

    const result = await resolveLogicalVisibleModelCatalog({
      cfg: {} as OpenClawConfig,
      catalog,
      defaultProvider: "demo",
      view: "all",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: evaluateAvailableEntry,
    });

    expect(result.map((entry) => entry.id)).toEqual(["off", "old"]);
  });

  it("preserves provider-owned strongest-first order through route projection", async () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", providerOrder: 3 },
      { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", providerOrder: 2 },
      { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", providerOrder: 0 },
      { provider: "openai", id: "gpt-5.6-terra", name: "GPT-5.6 Terra", providerOrder: 1 },
    ];

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

    expect(result.map((entry) => entry.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.4",
    ]);
  });

  it("keeps deprecated configured primary and alias-key rows visible", async () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: "demo", id: "primary", name: "Primary", status: "deprecated" },
      { provider: "demo", id: "alias-key", name: "Alias Key", status: "deprecated" },
      { provider: "demo", id: "hidden", name: "Hidden", status: "deprecated" },
    ];
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "demo/primary" },
          models: { "demo/alias-key": { alias: "legacy" } },
        },
      },
    } as OpenClawConfig;
    // This unit test covers configured-row retention, not runtime plugin
    // discovery. Keep fake provider refs on the deterministic static path.
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog,
      defaultProvider: "demo",
      defaultModel: "primary",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog,
      defaultProvider: "demo",
      defaultModel: "primary",
      view: "configured",
      policy,
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: evaluateAvailableEntry,
    });

    expect(result.map((entry) => entry.id)).toEqual(["alias-key", "primary"]);
  });

  it("represents an exact configured default missing from the catalog", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
        },
        list: [
          {
            id: "main",
            default: true,
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/gpt-5.6-sol",
      agentId: "main",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/gpt-5.6-sol",
      agentId: "main",
      view: "configured",
      policy,
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
        id: "gpt-5.6-sol",
        name: "gpt-5.6-sol",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    ]);
  });

  it.each([
    ["alias-only", { alias: "future" }],
    ["empty", {}],
    ["params-only", { params: { temperature: 0.2 } }],
    ["streaming-only", { streaming: false }],
    ["auto runtime", { agentRuntime: { id: "auto" } }],
    ["mixed-case auto runtime", { agentRuntime: { id: "AUTO" } }],
    ["default runtime", { agentRuntime: { id: "default" } }],
  ])("does not synthesize a %s model-map entry", async (_label, modelConfig) => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/future-model" },
        },
        list: [{ id: "main", models: { "openai/future-model": modelConfig } }],
      },
    } as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/future-model",
      agentId: "main",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/future-model",
      agentId: "main",
      view: "configured",
      policy,
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

    expect(result).toEqual([]);
  });

  it("honors an agent runtime override of a defaults-level binding", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/future-model" },
          modelPolicy: {},
          models: {
            "openai/future-model": { agentRuntime: { id: "codex" } },
          },
        },
        list: [
          {
            id: "main",
            models: {
              "openai/future-model": { agentRuntime: { id: "auto" } },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/future-model",
      agentId: "main",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/future-model",
      agentId: "main",
      view: "configured",
      policy,
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

    expect(result).toEqual([]);
  });

  it.each([
    {
      name: "canonical agent binding over a defaults alias",
      defaultsRef: "openai/gpt-5.4-codex",
      defaultsRuntime: "auto",
      agentRef: "openai/gpt-5.4",
      agentRuntime: "codex",
      visible: true,
    },
    {
      name: "canonical agent default runtime over a defaults alias",
      defaultsRef: "openai/gpt-5.4-codex",
      defaultsRuntime: "codex",
      agentRef: "openai/gpt-5.4",
      agentRuntime: "auto",
      visible: false,
    },
    {
      name: "agent alias binding over a canonical default",
      defaultsRef: "openai/gpt-5.4",
      defaultsRuntime: "auto",
      agentRef: "openai/gpt-5.4-codex",
      agentRuntime: "codex",
      visible: true,
    },
    {
      name: "agent alias default runtime over a canonical binding",
      defaultsRef: "openai/gpt-5.4",
      defaultsRuntime: "codex",
      agentRef: "openai/gpt-5.4-codex",
      agentRuntime: "auto",
      visible: false,
    },
  ])("honors $name", async ({ defaultsRef, defaultsRuntime, agentRef, agentRuntime, visible }) => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: agentRef },
          modelPolicy: {},
          models: {
            [defaultsRef]: { agentRuntime: { id: defaultsRuntime } },
          },
        },
        list: [
          {
            id: "main",
            models: {
              [agentRef]: { agentRuntime: { id: agentRuntime } },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: agentRef,
      agentId: "main",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: agentRef,
      agentId: "main",
      view: "configured",
      policy,
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

    expect(result).toEqual(
      visible
        ? [
            {
              provider: "openai",
              id: "gpt-5.4",
              name: "gpt-5.4",
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
            },
          ]
        : [],
    );
  });

  it("does not synthesize a primary without a model-specific runtime binding", async () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/future-model" } },
      },
    } as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/future-model",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/future-model",
      view: "configured",
      policy,
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: evaluateAvailableEntry,
    });

    expect(result).toEqual([]);
  });

  it("does not synthesize a runtime binding without a managed provider route", async () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/future-model" } },
        list: [
          {
            id: "main",
            models: {
              "openai/future-model": { agentRuntime: { id: "codex" } },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/future-model",
      agentId: "main",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/future-model",
      agentId: "main",
      view: "configured",
      policy,
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: evaluateAvailableEntry,
    });

    expect(result).toEqual([]);
  });

  it("does not synthesize a runtime binding for an incompatible provider route", async () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/future-model" } },
        list: [
          {
            id: "main",
            models: {
              "openai/future-model": { agentRuntime: { id: "codex" } },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/future-model",
      agentId: "main",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });
    const openClawOnlyRoute = {
      ...selectedRoute,
      runtimePolicy: { compatibleIds: ["openclaw"] },
    };

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/future-model",
      agentId: "main",
      view: "configured",
      policy,
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async (entry) =>
        resolveLogicalModelCatalogEntryState({
          entry,
          evaluation: {
            availability: true,
            routeResolution: {
              kind: "routes",
              routes: [openClawOnlyRoute, selectedRoute],
            },
            selectedRoute: openClawOnlyRoute,
          },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
    });

    expect(result).toEqual([]);
  });

  it("keeps an unavailable configured runtime visible when one route is compatible", async () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/future-model" } },
        list: [
          {
            id: "main",
            models: {
              "openai/future-model": { agentRuntime: { id: "codex" } },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/future-model",
      agentId: "main",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });
    const apiKeyRoute = {
      ...selectedRoute,
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key" as const,
      runtimePolicy: { compatibleIds: ["openclaw"] },
    };

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/future-model",
      agentId: "main",
      view: "configured",
      policy,
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async (entry) =>
        resolveLogicalModelCatalogEntryState({
          entry,
          evaluation: {
            availability: false,
            routeResolution: { kind: "routes", routes: [apiKeyRoute, selectedRoute] },
          },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
    });

    expect(result).toEqual([
      {
        provider: "openai",
        id: "future-model",
        name: "future-model",
      },
    ]);
  });

  it("does not synthesize runtime bindings outside the route policy owner", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/future-model" },
        },
        list: [
          {
            id: "main",
            models: {
              "anthropic/future-model": { agentRuntime: { id: "claude-cli" } },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "anthropic",
      defaultModel: "anthropic/future-model",
      agentId: "main",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog: [],
      defaultProvider: "anthropic",
      defaultModel: "anthropic/future-model",
      agentId: "main",
      view: "configured",
      policy,
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: evaluateAvailableEntry,
    });

    expect(result).toEqual([]);
  });

  it("does not broaden an explicit model allowlist with runtime-bound entries", async () => {
    const cfg = {
      agents: {
        defaults: {
          modelPolicy: { allow: ["openai/gpt-5.5"] },
        },
        list: [
          {
            id: "main",
            models: {
              "openai/future-model": { agentRuntime: { id: "codex" } },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/gpt-5.5",
      agentId: "main",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/gpt-5.5",
      agentId: "main",
      view: "configured",
      policy,
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: evaluateAvailableEntry,
    });

    expect(result.map((entry) => entry.id)).toEqual(["gpt-5.5"]);
  });

  it("keeps unavailable non-primary runtime bindings allowed by a provider wildcard", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          modelPolicy: { allow: ["openai/*"] },
        },
        list: [
          {
            id: "main",
            models: {
              "openai/future-model": { agentRuntime: { id: "codex" } },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/gpt-5.5",
      agentId: "main",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      defaultModel: "openai/gpt-5.5",
      agentId: "main",
      view: "configured",
      policy,
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: async (entry) =>
        resolveLogicalModelCatalogEntryState({
          entry,
          evaluation: {
            availability: false,
            routeResolution: { kind: "routes", routes: [selectedRoute] },
          },
          routePolicy: openAIModelCatalogRoutePolicy,
        }),
    });

    expect(result).toEqual([
      {
        provider: "openai",
        id: "future-model",
        name: "future-model",
      },
    ]);
  });

  it("does not add runtime-bound entries to the all inventory", async () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            models: {
              "openai/future-model": { agentRuntime: { id: "codex" } },
            },
          },
        ],
      },
    } as OpenClawConfig;

    const result = await resolveLogicalVisibleModelCatalog({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      agentId: "main",
      view: "all",
      routePolicy: openAIModelCatalogRoutePolicy,
      evaluateEntry: evaluateAvailableEntry,
    });

    expect(result).toEqual([]);
  });

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

  it.each([
    ["deprecated", []],
    ["available", ["gpt-5.5"]],
  ] as const)("uses the selected route's %s lifecycle status", async (status, expectedIds) => {
    const platformAvailable = { ...platform, status: "available" as const };
    const chatGPTSelected = { ...chatGPT, status };
    const catalog = [platformAvailable, chatGPTSelected];
    const result = await resolveLogicalVisibleModelCatalog({
      cfg: {} as OpenClawConfig,
      catalog,
      routeVariants: catalog,
      defaultProvider: "openai",
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

    expect(result.map((entry) => entry.id)).toEqual(expectedIds);
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
