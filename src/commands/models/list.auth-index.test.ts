import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { createOpenAIModelRoutesResolver } from "../../agents/openai-model-routes.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createModelListAuthIndex } from "./list.auth-index.js";

type ExternalCliProfilesResolver =
  typeof import("../../agents/auth-profiles/external-cli-sync.js").resolveExternalCliAuthProfiles;

const externalCliMocks = vi.hoisted(() => ({
  resolveExternalCliAuthProfiles: vi.fn<ExternalCliProfilesResolver>(() => []),
}));

vi.mock("../../agents/auth-profiles/external-cli-sync.js", () => ({
  listExternalCliSyncProviderIds: () => ["openai"],
  resolveExternalCliAuthProfiles: externalCliMocks.resolveExternalCliAuthProfiles,
}));

const emptyStore: AuthProfileStore = { version: 1, profiles: {} };
const emptyMetadataSnapshot = {
  registrySource: "persisted",
  registryDiagnostics: [],
  plugins: [],
  index: { plugins: [] },
} as unknown as PluginMetadataSnapshot;

function createTestModelListAuthIndex(
  params: Omit<Parameters<typeof createModelListAuthIndex>[0], "metadataSnapshot"> & {
    metadataSnapshot?: PluginMetadataSnapshot;
  },
) {
  return createModelListAuthIndex({
    metadataSnapshot: emptyMetadataSnapshot,
    ...params,
  });
}

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
    externalCliMocks.resolveExternalCliAuthProfiles.mockReset();
    externalCliMocks.resolveExternalCliAuthProfiles.mockReturnValue([]);
  });

  it("keeps a fresh auth scope empty", () => {
    const index = createTestModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {},
      routeResolverFactory: dualRouteResolverFactory,
    });

    expect(index.providerDiscoveryProviderIds).toEqual([]);
  });

  it("scopes provider discovery to concrete API-key evidence", () => {
    const index = createTestModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: { ANTHROPIC_API_KEY: "test-key" },
      routeResolverFactory: dualRouteResolverFactory,
    });

    expect(index.providerDiscoveryProviderIds).toEqual(["anthropic", "anthropic-openai"]);
  });

  it("scopes provider discovery to external CLI credentials", () => {
    externalCliMocks.resolveExternalCliAuthProfiles.mockReturnValue([
      {
        profileId: "openai:codex-cli",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "external-cli",
          refresh: "external-cli-refresh",
          expires: Date.now() + 60_000,
        },
      },
    ]);
    const index = createTestModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {},
      externalCliProviderIds: ["openai"],
      routeResolverFactory: dualRouteResolverFactory,
    });

    expect(index.providerDiscoveryProviderIds).toEqual(["openai"]);
  });

  it("scopes provider discovery to stored credential profiles", () => {
    const index = createTestModelListAuthIndex({
      cfg: {},
      authStore: {
        version: 1,
        profiles: {
          "moonshot:stored": {
            type: "api_key",
            provider: "moonshot",
            key: "stored-key",
          },
        },
      },
      env: {},
      routeResolverFactory: dualRouteResolverFactory,
    });

    expect(index.providerDiscoveryProviderIds).toEqual(["moonshot"]);
  });

  it("scopes provider discovery to configured auth profiles", () => {
    const index = createTestModelListAuthIndex({
      cfg: {
        auth: {
          profiles: {
            "openrouter:configured": {
              provider: "openrouter",
              mode: "api_key",
            },
          },
        },
      },
      authStore: emptyStore,
      env: {},
      routeResolverFactory: dualRouteResolverFactory,
    });

    expect(index.providerDiscoveryProviderIds).toEqual(["openrouter"]);
  });

  it("forwards route-aware evaluation through the command adapter", () => {
    const index = createTestModelListAuthIndex({
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
    expect(index.providerDiscoveryProviderIds).toEqual(["openai"]);
  });

  it("uses enabled synthetic refs from prepared persisted metadata", () => {
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
    const index = createTestModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {},
      metadataSnapshot,
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
    const index = createTestModelListAuthIndex({
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
  });

  it("maps synthetic auth refs to their configured plugin catalog providers", () => {
    const metadataSnapshot = {
      registrySource: "persisted",
      registryDiagnostics: [],
      plugins: [],
      index: {
        plugins: [
          {
            pluginId: "local-runtime",
            enabled: true,
            syntheticAuthRefs: ["local-cli"],
            contributions: {
              providers: ["local-runtime"],
              modelCatalogProviders: ["local-catalog"],
            },
          },
        ],
      },
    } as unknown as PluginMetadataSnapshot;
    const index = createTestModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {},
      metadataSnapshot,
      syntheticAuthProviderRefs: ["local-cli"],
      routeResolverFactory: dualRouteResolverFactory,
    });

    expect(index.providerDiscoveryProviderIds).toEqual(["local-catalog", "local-runtime"]);
  });

  it.each(["derived" as const, "persisted" as const])(
    "does not trust unusable synthetic refs from a %s snapshot",
    (source) => {
      const metadataSnapshot = {
        registrySource: source,
        registryDiagnostics: [],
        plugins: [],
        index: {
          plugins: [{ enabled: source === "derived", syntheticAuthRefs: ["codex"] }],
        },
      } as unknown as PluginMetadataSnapshot;
      const index = createTestModelListAuthIndex({
        cfg: {},
        authStore: emptyStore,
        env: {},
        metadataSnapshot,
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
    const index = createTestModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {},
      metadataSnapshot,
      syntheticAuthProviderRefs: ["codex"],
      routeResolverFactory: dualRouteResolverFactory,
    });

    expect(index.evaluateModelAuth("openai").evidence).toBe("synthetic");
  });

  it("fails closed before loading refs from a diagnostic-bearing metadata snapshot", () => {
    const metadataSnapshot = {
      index: { plugins: [] },
      plugins: [{ enabled: true, syntheticAuthRefs: ["codex"] }],
      registryDiagnostics: [{ level: "error", message: "invalid plugin metadata" }],
    } as unknown as PluginMetadataSnapshot;
    const index = createTestModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {},
      metadataSnapshot,
      routeResolverFactory: dualRouteResolverFactory,
    });

    expect(index.evaluateModelAuth("openai").availability).toBe(false);
  });
});
