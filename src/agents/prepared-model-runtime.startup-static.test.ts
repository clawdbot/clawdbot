import { beforeEach, describe, expect, it, vi } from "vitest";

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
    resolveAmbientCredentials: vi.fn((..._args: unknown[]) => ({})),
    discoverAuthStorage: vi.fn(() => authStorage),
    discoverModels: vi.fn(() => modelRegistry),
    ensureOpenClawModelsJson: vi.fn(
      async (_config: unknown, _agentDir: unknown, _options?: unknown) => ({
        agentDir: "/tmp/agent",
        wrote: false,
      }),
    ),
    planOpenClawModelsJsonSource: vi.fn(async (_config: unknown, agentDir: unknown) => ({
      agentDir: String(agentDir),
      modelsJsonContents: null,
      pluginCatalogs: [],
    })),
    buildPreparedModelCatalogSnapshot: vi.fn(async () => ({ entries: [], routeVariants: [] })),
    ensureRuntimePluginsLoaded: vi.fn(),
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

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: () => mocks.metadataSnapshot,
  resolvePluginMetadataSnapshot: () => mocks.metadataSnapshot,
}));

vi.mock("./agent-auth-discovery.js", () => ({
  resolveAmbientAgentCredentialsForDiscovery: mocks.resolveAmbientCredentials,
}));

vi.mock("./agent-model-discovery.js", () => ({
  discoverAuthStorage: mocks.discoverAuthStorage,
  discoverModels: mocks.discoverModels,
  discoverModelsFromCapturedSources: mocks.discoverModels,
}));

vi.mock("../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: () => [],
}));

vi.mock("./agent-scope.js", () => ({
  listAgentIds: () => ["default"],
  resolveAgentDir: () => "/tmp/prepared-static-agent",
  resolveAgentWorkspaceDir: () => "/tmp/prepared-static-workspace",
  resolveDefaultAgentDir: () => "/tmp/prepared-static-agent",
  resolveDefaultAgentId: () => "default",
}));

vi.mock("./auth-profiles/runtime-snapshots.js", () => ({
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
  ensureRuntimePluginsLoaded: mocks.ensureRuntimePluginsLoaded,
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
const { resetPreparedModelRuntimeSnapshotsForTest } =
  await import("./prepared-model-runtime.test-support.js");

beforeEach(() => {
  resetPreparedModelRuntimeSnapshotsForTest();
  vi.clearAllMocks();
  mocks.resolveStaticCatalogModel.mockReturnValue(undefined);
});

describe("prepared model runtime Gateway catalog mode", () => {
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
    expect(mocks.ensureRuntimePluginsLoaded).not.toHaveBeenCalled();
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
        includePluginCatalogs: true,
        modelsJsonContents: null,
        pluginCatalogs: [],
        pluginMetadataSnapshot: mocks.metadataSnapshot,
        workspaceDir: "/tmp/prepared-static-workspace",
      }),
    );
    expect(mocks.buildPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadStaticCatalog).not.toHaveBeenCalled();
    expect(configuredRuntimeModelCount).toBe(1);
    expect(generatedCatalogReadCount).toBe(0);
    const snapshot = getPreparedModelRuntimeSnapshot({
      agentId: "default",
      config,
      agentDir: "/tmp/prepared-static-agent",
      inheritedAuthDir: "/tmp/prepared-static-agent",
      workspaceDir: "/tmp/prepared-static-workspace",
    });
    expect(snapshot?.configuredRuntimeModels).toHaveLength(1);
    expect(snapshot?.messageToolCatalog).toBeUndefined();
    expect(snapshot?.mediaCapabilityProviders).toBeUndefined();
    const fullCatalog = await snapshot?.loadFullModelCatalog?.();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.planOpenClawModelsJsonSource).toHaveBeenCalledWith(
      config,
      "/tmp/prepared-static-agent",
      expect.objectContaining({
        pluginMetadataSnapshot: mocks.metadataSnapshot,
        providerDiscoveryTimeoutMs: 5_000,
      }),
    );
    expect(mocks.buildPreparedModelCatalogSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ includeProviderPluginAugmentation: true }),
    );
    expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledOnce();
    expect(mocks.ensureRuntimePluginsLoaded.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.buildPreparedModelCatalogSnapshot.mock.invocationCallOrder[0]!,
    );
    expect(mocks.loadStaticCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ metadataSnapshot: mocks.metadataSnapshot }),
    );

    mocks.mutationListener?.({
      agentDir: "/tmp/prepared-static-agent",
      affectsInheritedStores: false,
    });
    await expect(snapshot?.loadFullModelCatalog?.()).resolves.toBe(fullCatalog);
    await vi.waitFor(() => expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2));
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.planOpenClawModelsJsonSource).toHaveBeenCalledOnce();
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);
    expect(mocks.discoverModels).toHaveBeenCalledTimes(3);
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
