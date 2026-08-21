import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";

type CreateStaticCatalogResolver =
  typeof import("./embedded-agent-runner/model.static-catalog.js").createBundledStaticCatalogModelResolver;
type StaticCatalogResolver = ReturnType<CreateStaticCatalogResolver>;

const mocks = vi.hoisted(() => {
  const metadataSnapshot = {
    plugins: [],
    pluginIds: [],
    index: { plugins: [{ pluginId: "openai", enabled: true }] },
    manifestRegistry: { plugins: [], diagnostics: [] },
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map([["openai", ["openai"]]]),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
  };
  const authStorage = {
    getAll: vi.fn(() => ({ openai: { type: "api_key" as const, key: "test-openai-key" } })),
    getOAuthProviders: vi.fn(() => []),
  };
  const modelRegistry = {
    fork: vi.fn((nextAuthStorage: unknown) => ({ authStorage: nextAuthStorage })),
    getAll: vi.fn(() => []),
    find: vi.fn(() => null),
  };
  const resolveSyntheticAuth = vi.fn(() => ({
    apiKey: "synthetic-openai-key",
    source: "test",
    mode: "api-key" as const,
  }));
  return {
    authStorage,
    modelRegistry,
    metadataSnapshot,
    resolvePluginMetadataSnapshot: vi.fn(() => metadataSnapshot),
    resolveAmbientCredentials: vi.fn((..._args: unknown[]) => ({})),
    discoverAuthStorage: vi.fn((_agentDir?: string, _options?: unknown) => authStorage),
    discoverModels: vi.fn(() => modelRegistry),
    ensureOpenClawModelsJson: vi.fn(
      async (_config: unknown, _agentDir: unknown, _options?: unknown) => ({
        agentDir: "/tmp/agent",
        wrote: false,
      }),
    ),
    planOpenClawModelsJsonSource: vi.fn(
      async (_config: unknown, agentDir: unknown, _options?: unknown) => ({
        agentDir: String(agentDir),
        modelsJsonContents: null,
        pluginCatalogs: [],
      }),
    ),
    buildPreparedModelCatalogSnapshot: vi.fn(async () => ({ entries: [], routeVariants: [] })),
    runPreparedModelCatalogWorker: vi.fn(async () => ({ entries: [], routeVariants: [] })),
    loadAgentRuntimePluginRegistryHandle: vi.fn(),
    loadStaticCatalog: vi.fn(async () => []),
    prepareStaticCatalog: vi.fn(async (..._args: unknown[]) => ({
      providers: [
        {
          id: "openai",
          label: "OpenAI",
          auth: [],
          resolveSyntheticAuth,
        },
      ],
      entries: [
        {
          provider: { id: "openai", label: "OpenAI", auth: [] },
          result: {
            provider: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-responses",
              models: [
                {
                  id: "gpt-5.5",
                  name: "GPT-5.5",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        },
      ],
    })),
    resolveStaticCatalogModel: vi.fn<StaticCatalogResolver>(() => undefined),
    resolveSyntheticAuth,
    mutationListener: undefined as
      | ((event: { agentDir?: string; affectsInheritedStores: boolean }) => void)
      | undefined,
  };
});

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  isPluginMetadataSnapshotCompatible: () => true,
  loadPluginMetadataSnapshot: () => mocks.metadataSnapshot,
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

vi.mock("./agent-auth-discovery.js", () => ({
  resolveAmbientAgentCredentialsForDiscovery: mocks.resolveAmbientCredentials,
}));

vi.mock("./prepared-model-catalog-worker.js", () => ({
  createPreparedModelCatalogWorkerInput: ({ agentFacts }: { agentFacts: unknown }) => ({
    generationFingerprint: "test-generation",
    input: (agentFacts as { input: unknown }).input,
  }),
  createPreparedModelCatalogWorker: () => ({
    loadCatalog: mocks.runPreparedModelCatalogWorker,
    loadAuth: async () => ({ authStore: { version: 1, profiles: {} }, authModes: {} }),
  }),
}));

vi.mock("./agent-model-discovery.js", () => ({
  discoverAuthStorageFacts: (agentDir: string, options?: unknown) => {
    const authStorage = mocks.discoverAuthStorage(agentDir, options);
    const credentials = authStorage.getAll();
    return {
      authStorage,
      store: {
        version: 1,
        profiles: Object.fromEntries(
          Object.entries(credentials).map(([provider, credential]) => [
            `${provider}:default`,
            { ...(credential as object), provider },
          ]),
        ),
      },
      credentials,
    };
  },
  discoverAuthStorage: mocks.discoverAuthStorage,
  discoverModels: mocks.discoverModels,
  discoverModelsFromCapturedSources: mocks.discoverModels,
}));

vi.mock("../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: () => [],
}));

vi.mock("./legacy-inherited-auth-dir.js", () => ({
  resolveLegacyInheritedAuthDir: () => "/tmp/prepared-static-agent",
}));

vi.mock("./agent-scope.js", () => ({
  listAgentEntries: (config: { agents?: { list?: unknown[] } }) => config.agents?.list ?? [],
  listAgentIds: () => ["default"],
  resolveAgentDir: () => "/tmp/prepared-static-agent",
  resolveAgentWorkspaceDir: () => "/tmp/prepared-static-workspace",
  tryResolveConfiguredAgentWorkspaceDir: () => "/tmp/prepared-static-workspace",
  tryResolveSystemAgentWorkspaceDir: () => "/tmp/prepared-static-workspace",
  resolveDefaultAgentDir: () => "/tmp/prepared-static-agent",
  resolveDefaultAgentId: () => "default",
  tryResolveSoleAgentId: () => "default",
  resolveAgentEffectiveModelPrimary: () => undefined,
  resolveAgentModelFallbacksOverride: () => undefined,
  resolveRunModelFallbacksOverride: () => undefined,
  resolveSessionAgentIds: ({ agentId }: { agentId?: string }) => ({
    defaultAgentId: "default",
    sessionAgentId: agentId ?? "default",
  }),
}));

vi.mock("./auth-profiles/runtime-snapshots.js", () => ({
  getPreparedRuntimeAuthProfileStoreSnapshotCore: () => undefined,
  registerRuntimeAuthProfileStoreMutationListener: (
    listener: (event: { agentDir?: string; affectsInheritedStores: boolean }) => void,
  ) => {
    mocks.mutationListener = listener;
    return () => {};
  },
}));

vi.mock("./model-catalog.js", () => ({
  buildPreparedModelCatalogSnapshot: mocks.buildPreparedModelCatalogSnapshot,
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: mocks.ensureOpenClawModelsJson,
  planOpenClawModelsJsonSource: mocks.planOpenClawModelsJsonSource,
}));

vi.mock("./models-config.providers.implicit.js", () => ({
  prepareImplicitProviderStaticCatalog: mocks.prepareStaticCatalog,
}));

vi.mock("./runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: mocks.loadAgentRuntimePluginRegistryHandle,
}));

vi.mock("./embedded-agent-runner/model.static-catalog.js", () => ({
  loadBundledProviderStaticCatalogContextModels: mocks.loadStaticCatalog,
  createBundledStaticCatalogModelResolver: () => mocks.resolveStaticCatalogModel,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: vi.fn() }),
}));

const { getPreparedModelRuntimeSnapshot, refreshPreparedModelRuntimeSnapshots } =
  await import("./prepared-model-runtime.js");
const { getAvailablePreparedModelCatalogSnapshot } = await import("./prepared-model-catalog.js");
const { prepareScopedReadOnlyLiveModelCatalog, prepareScopedReadOnlyModelCatalog } =
  await import("./prepared-model-runtime.scoped-catalog.js");
const { resetPreparedModelRuntimeSnapshotsForTest } =
  await import("./prepared-model-runtime.test-support.js");

beforeEach(() => {
  resetPreparedModelRuntimeSnapshotsForTest();
  mocks.loadAgentRuntimePluginRegistryHandle
    .mockReset()
    .mockReturnValue(createEmptyPluginRegistry());
  vi.clearAllMocks();
  mocks.resolveStaticCatalogModel.mockReturnValue(undefined);
});

describe("prepared model runtime Gateway catalog mode", () => {
  it("imports and materializes only configured and auth-candidate providers", async () => {
    const config = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    };

    await prepareScopedReadOnlyModelCatalog(
      {
        agentId: "default",
        agentDir: "/tmp/prepared-static-agent",
        config,
        inheritedAuthDir: "/tmp/prepared-static-agent",
        workspaceDir: "/tmp/prepared-static-workspace",
        env: {},
        readOnly: true,
      },
      ["anthropic", "local-runtime"],
    );

    expect(mocks.prepareStaticCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        providerDiscoveryProviderIds: ["anthropic", "local-runtime", "openai"],
        staticCatalogProviderIds: ["anthropic", "local-runtime", "openai"],
      }),
    );
    expect(mocks.planOpenClawModelsJsonSource).toHaveBeenCalledWith(
      config,
      "/tmp/prepared-static-agent",
      expect.objectContaining({
        providerDiscoveryEntriesOnly: true,
        providerDiscoveryProviderIds: ["anthropic", "local-runtime", "openai"],
      }),
    );
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("uses live provider catalogs for an explicit read-only list scope", async () => {
    const config = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    };

    await prepareScopedReadOnlyLiveModelCatalog(
      {
        agentId: "default",
        agentDir: "/tmp/prepared-live-agent",
        config,
        inheritedAuthDir: "/tmp/prepared-live-agent",
        workspaceDir: "/tmp/prepared-live-workspace",
        env: {},
        readOnly: true,
      },
      ["anthropic"],
    );

    expect(mocks.planOpenClawModelsJsonSource).toHaveBeenCalledWith(
      config,
      "/tmp/prepared-live-agent",
      expect.objectContaining({
        providerDiscoveryProviderIds: ["anthropic"],
        providerDiscoveryTimeoutMs: expect.any(Number),
      }),
    );
    expect(mocks.planOpenClawModelsJsonSource).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ providerDiscoveryEntriesOnly: true }),
    );
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("does not publish a static catalog generation superseded while its hook is running", async () => {
    const staleConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.6" } } };
    const defaultPrepareStaticCatalog = mocks.prepareStaticCatalog.getMockImplementation();
    let releaseStaleHook: (() => void) | undefined;
    let staleHookStarted!: () => void;
    const staleHookPending = new Promise<void>((resolve) => {
      staleHookStarted = resolve;
    });
    mocks.prepareStaticCatalog.mockImplementationOnce(async (...args: unknown[]) => {
      staleHookStarted();
      await new Promise<void>((resolve) => {
        releaseStaleHook = resolve;
      });
      if (!defaultPrepareStaticCatalog) {
        throw new Error("expected default static catalog implementation");
      }
      return await defaultPrepareStaticCatalog(...args);
    });

    const stale = refreshPreparedModelRuntimeSnapshots(staleConfig, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    await staleHookPending;
    const latest = refreshPreparedModelRuntimeSnapshots(latestConfig, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    releaseStaleHook?.();

    await expect(stale).rejects.toThrow("superseded");
    await latest;
    expect(
      getPreparedModelRuntimeSnapshot({
        agentId: "default",
        config: latestConfig,
        agentDir: "/tmp/prepared-static-agent",
        inheritedAuthDir: "/tmp/prepared-static-agent",
        workspaceDir: "/tmp/prepared-static-workspace",
      })?.config,
    ).toBe(latestConfig);
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);
    expect(mocks.discoverModels).toHaveBeenCalledOnce();
  });

  it("publishes configured turn facts without eagerly building a full catalog", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
        },
      },
    };

    let configuredRuntimeModelCount = 0;
    let generatedCatalogReadCount = -1;
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      onBuildStats: (stats) => {
        configuredRuntimeModelCount = stats.configuredRuntimeModelCount;
        generatedCatalogReadCount = stats.generatedCatalogReadCount;
      },
    });

    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);
    expect(mocks.loadAgentRuntimePluginRegistryHandle.mock.calls[0]?.[0]).not.toHaveProperty(
      "selections",
    );
    expect(mocks.loadAgentRuntimePluginRegistryHandle.mock.calls[1]?.[0]).toMatchObject({
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "openclaw" }],
    });
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        providerDiscoveryProviderIds: ["openai"],
        staticCatalogProviderIds: ["openai"],
      }),
    );
    expect(mocks.resolveAmbientCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        syntheticAuthProviderRefs: ["openai"],
        resolveSyntheticAuth: expect.any(Function),
      }),
    );
    const ambientOptions = mocks.resolveAmbientCredentials.mock.calls[0]?.[0] as
      | { resolveSyntheticAuth?: (provider: string) => { apiKey?: string } | undefined }
      | undefined;
    expect(ambientOptions?.resolveSyntheticAuth?.("openai")).toMatchObject({
      apiKey: "synthetic-openai-key",
    });
    expect(mocks.resolveSyntheticAuth).toHaveBeenCalledWith({
      config,
      provider: "openai",
      providerConfig: undefined,
    });
    expect(mocks.discoverModels).toHaveBeenLastCalledWith(
      mocks.authStorage,
      expect.objectContaining({
        config,
        includePluginCatalogs: true,
        modelsJsonContents: null,
        pluginCatalogs: [],
        pluginMetadataSnapshot: mocks.metadataSnapshot,
        workspaceDir: "/tmp/prepared-static-workspace",
      }),
    );
    expect(mocks.buildPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadStaticCatalog).not.toHaveBeenCalled();
    // Two slot-probing resolutions share the published generation: the prepared
    // cold plugin context and the model-id normalization lane. Neither builds a
    // catalog; the laziness guards above are the eager-work protections.
    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledTimes(2);
    expect(configuredRuntimeModelCount).toBe(1);
    expect(generatedCatalogReadCount).toBe(0);
    const snapshot = getPreparedModelRuntimeSnapshot({
      agentId: "default",
      config,
      agentDir: "/tmp/prepared-static-agent",
      inheritedAuthDir: "/tmp/prepared-static-agent",
      workspaceDir: "/tmp/prepared-static-workspace",
    });
    expect(
      getAvailablePreparedModelCatalogSnapshot({
        agentId: "default",
        config,
        agentDir: "/tmp/prepared-static-agent",
        workspaceDir: "/tmp/prepared-static-workspace",
      }),
    ).toBe(snapshot?.modelCatalog);
    expect(snapshot?.configuredRuntimeModels).toHaveLength(1);
    expect(snapshot?.pluginRegistry).toBeDefined();
    expect(snapshot?.messageToolCatalog).toBeUndefined();
    expect(snapshot?.mediaCapabilityProviders).toBeDefined();
    await snapshot?.loadFullModelCatalog?.();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);

    await expect(snapshot?.loadFullModelCatalog?.()).resolves.toEqual({
      entries: [],
      routeVariants: [],
    });
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
    expect(snapshot?.readFullModelCatalog?.()).toEqual({ entries: [], routeVariants: [] });
    expect(
      getAvailablePreparedModelCatalogSnapshot({
        agentId: "default",
        config,
        agentDir: "/tmp/prepared-static-agent",
        workspaceDir: "/tmp/prepared-static-workspace",
      }),
    ).toEqual({ entries: [], routeVariants: [] });
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();

    await snapshot?.loadFullModelCatalog?.({ refresh: true });
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
    mocks.runPreparedModelCatalogWorker.mockRejectedValueOnce(new Error("refresh failed"));
    await expect(snapshot?.loadFullModelCatalog?.({ refresh: true })).rejects.toThrow(
      "refresh failed",
    );
    expect(snapshot?.readFullModelCatalog?.()).toEqual({ entries: [], routeVariants: [] });
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(3);
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
    expect(mocks.discoverModels).toHaveBeenCalledOnce();

    mocks.mutationListener?.({
      agentDir: "/tmp/prepared-static-agent",
      affectsInheritedStores: false,
    });
    await expect(snapshot?.loadFullModelCatalog?.()).rejects.toThrow("superseded");
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(3);
  });

  it("publishes exact dynamic configured models without building a live catalog", async () => {
    const provider = "fixture-provider";
    const modelId = "fixture-model-2026-08-09";
    const registry = createEmptyPluginRegistry();
    const resolveDynamicModel = vi.fn(
      (context: { provider: string; modelId: string; modelRegistry: unknown }) => ({
        id: context.modelId,
        name: "Fixture dated model",
        provider: context.provider,
        api: "openai-responses" as const,
        baseUrl: "https://fixture.invalid/v1",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64_000,
        maxTokens: 8_192,
      }),
    );
    registry.providers.push({
      pluginId: provider,
      provider: { id: provider, label: "Fixture provider", auth: [], resolveDynamicModel },
      source: "test",
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
    const providerConfig = {
      api: "openai-responses" as const,
      baseUrl: "https://configured.fixture.invalid/v1",
      models: [],
    };
    const config = {
      models: { providers: { [provider]: providerConfig } },
      agents: {
        defaults: {
          model: {
            primary: `${provider}/${modelId}`,
            fallbacks: ["openai/gpt-5.5", `${provider}/${modelId}`],
          },
        },
      },
    };

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });

    expect(resolveDynamicModel).toHaveBeenCalledOnce();
    expect(mocks.discoverModels.mock.invocationCallOrder[0]).toBeLessThan(
      resolveDynamicModel.mock.invocationCallOrder[0]!,
    );
    expect(resolveDynamicModel).toHaveBeenCalledWith({
      config,
      agentDir: "/tmp/prepared-static-agent",
      workspaceDir: "/tmp/prepared-static-workspace",
      provider,
      modelId,
      modelRegistry: mocks.modelRegistry,
      providerConfig,
    });
    const snapshot = getPreparedModelRuntimeSnapshot({
      agentId: "default",
      config,
      agentDir: "/tmp/prepared-static-agent",
      inheritedAuthDir: "/tmp/prepared-static-agent",
      workspaceDir: "/tmp/prepared-static-workspace",
    });
    expect(
      snapshot?.configuredRuntimeModels.map(
        (configured) => `${configured.provider}/${configured.modelId}`,
      ),
    ).toEqual([`${provider}/${modelId}`, "openai/gpt-5.5"]);
    expect(snapshot?.configuredRuntimeModels[0]?.model).toMatchObject({
      provider,
      id: modelId,
      name: "Fixture dated model",
      api: "openai-responses",
      baseUrl: "https://fixture.invalid/v1",
    });
    for (const entries of [
      snapshot?.modelCatalog.entries,
      snapshot?.modelCatalog.routeVariants,
      snapshot?.modelCatalog.staticEntries,
    ]) {
      expect(entries?.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
        `${provider}/${modelId}`,
        "openai/gpt-5.5",
      ]);
    }
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        providerDiscoveryProviderIds: [provider, "openai"],
        staticCatalogProviderIds: [provider, "openai"],
      }),
    );
    expect(mocks.discoverModels).toHaveBeenCalledOnce();
    expect(mocks.buildPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadStaticCatalog).not.toHaveBeenCalled();
    expect(mocks.planOpenClawModelsJsonSource).not.toHaveBeenCalled();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("does not request a static provider hook when manifest facts resolve the configured model", async () => {
    mocks.resolveStaticCatalogModel.mockReturnValue({
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
      },
    };

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });

    expect(mocks.prepareStaticCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        providerDiscoveryProviderIds: ["openai"],
        staticCatalogProviderIds: [],
      }),
    );
    const snapshot = getPreparedModelRuntimeSnapshot({
      agentId: "default",
      config,
      agentDir: "/tmp/prepared-static-agent",
      inheritedAuthDir: "/tmp/prepared-static-agent",
      workspaceDir: "/tmp/prepared-static-workspace",
    });
    expect(snapshot?.configuredRuntimeModels).toHaveLength(1);
  });
});
