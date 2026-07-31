import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { createOpenAIModelRoutesResolver } from "../../agents/openai-model-routes.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createModelListAuthIndex } from "./list.auth-index.js";

type PluginSnapshotResult = {
  source: "persisted" | "provided" | "derived";
  snapshot: {
    plugins: Array<{ enabled?: boolean; syntheticAuthRefs?: string[] }>;
  };
  diagnostics: [];
};

const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshotWithMetadata: vi.fn(
    (): PluginSnapshotResult => ({
      source: "persisted",
      snapshot: { plugins: [] },
      diagnostics: [],
    }),
  ),
}));

vi.mock("../../plugins/plugin-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/plugin-registry.js")>();
  return {
    ...actual,
    loadPluginRegistrySnapshotWithMetadata:
      pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata,
  };
});

const emptyStore: AuthProfileStore = { version: 1, profiles: {} };

const dualRouteResolverFactory = (() => () => ({
  kind: "routes",
  defaultRuntimeId: "codex",
  routes: [
    {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key",
      requestTransportOverrides: "none",
      runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
    },
    {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription",
      requestTransportOverrides: "none",
      runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
    },
  ],
})) as typeof createOpenAIModelRoutesResolver;

describe("createModelListAuthIndex", () => {
  beforeEach(() => {
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: { plugins: [] },
      diagnostics: [],
    });
  });

  it("forwards route-aware evaluation through the command adapter", () => {
    const index = createModelListAuthIndex({
      cfg: {},
      authStore: {
        version: 1,
        profiles: {
          "openai:platform": {
            type: "api_key",
            provider: "openai",
            key: "platform-key",
          },
        },
      },
      env: {},
      routeResolverFactory: dualRouteResolverFactory,
    });

    expect(index.evaluateModelAuth("openai", { modelId: "gpt-5.5" })).toMatchObject({
      availability: true,
      evidence: "profile",
      selectedProfileId: "openai:platform",
      selectedRoute: { authRequirement: "api-key" },
    });
  });

  it("uses enabled synthetic refs from a persisted plugin snapshot", () => {
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: {
        plugins: [
          { enabled: true, syntheticAuthRefs: ["codex"] },
          { enabled: false, syntheticAuthRefs: ["disabled-provider"] },
        ],
      },
      diagnostics: [],
    });
    const index = createModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {},
      routeResolverFactory: dualRouteResolverFactory,
    });

    const evaluation = index.evaluateModelAuth("openai", { modelId: "gpt-5.5" });
    expect(evaluation).toMatchObject({
      availability: undefined,
      evidence: "synthetic",
    });
    expect(evaluation).not.toHaveProperty("selectedRoute");
    expect(index.evaluateModelAuth("disabled-provider").availability).toBeUndefined();
  });

  it("uses enabled synthetic refs from prepared metadata without reloading the registry", () => {
    const metadataSnapshot = {
      registrySource: "persisted",
      registryDiagnostics: [],
      plugins: [],
      index: {
        plugins: [
          { enabled: true, syntheticAuthRefs: ["codex"] },
          { enabled: false, syntheticAuthRefs: ["disabled-provider"] },
        ],
      },
    } as unknown as PluginMetadataSnapshot;
    const index = createModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {},
      metadataSnapshot,
      routeResolverFactory: dualRouteResolverFactory,
    });

    expect(index.evaluateModelAuth("openai", { modelId: "gpt-5.5" })).toMatchObject({
      availability: undefined,
      evidence: "synthetic",
    });
    expect(index.evaluateModelAuth("disabled-provider").availability).toBeUndefined();
    expect(pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
  });

  it.each(["derived" as const, "persisted" as const])(
    "does not trust unusable synthetic refs from a %s snapshot",
    (source) => {
      pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
        source,
        snapshot: {
          plugins: [{ enabled: source === "derived", syntheticAuthRefs: ["codex"] }],
        },
        diagnostics: [],
      });
      const index = createModelListAuthIndex({
        cfg: {},
        authStore: emptyStore,
        env: {},
        routeResolverFactory: dualRouteResolverFactory,
      });

      expect(index.evaluateModelAuth("openai", { modelId: "gpt-5.5" })).toMatchObject({
        availability: false,
      });
    },
  );

  it("uses explicit synthetic refs without loading plugin metadata", () => {
    const metadataSnapshot = {
      registrySource: "persisted",
      plugins: [],
    } as unknown as PluginMetadataSnapshot;
    const index = createModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {},
      metadataSnapshot,
      syntheticAuthProviderRefs: ["codex"],
      routeResolverFactory: dualRouteResolverFactory,
    });

    expect(index.evaluateModelAuth("openai").evidence).toBe("synthetic");
    expect(pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
  });

  it("fails closed before loading refs from a diagnostic-bearing metadata snapshot", () => {
    const metadataSnapshot = {
      index: { plugins: [] },
      plugins: [{ enabled: true, syntheticAuthRefs: ["codex"] }],
      registryDiagnostics: [{ level: "error", message: "invalid plugin metadata" }],
    } as unknown as PluginMetadataSnapshot;
    const index = createModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {},
      metadataSnapshot,
      routeResolverFactory: dualRouteResolverFactory,
    });

    expect(index.evaluateModelAuth("openai").availability).toBe(false);
    expect(pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
  });
});
