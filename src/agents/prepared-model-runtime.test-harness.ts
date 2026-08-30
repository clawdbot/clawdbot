import { vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { AuthStorageData } from "./sessions/auth-storage.js";

type LoadStaticCatalog =
  typeof import("./embedded-agent-runner/model.static-catalog.js").loadBundledProviderStaticCatalogContextModels;
type BuildPreparedModelCatalogSnapshot =
  typeof import("./model-catalog.js").buildPreparedModelCatalogSnapshot;
type CreateStaticCatalogResolver =
  typeof import("./embedded-agent-runner/model.static-catalog.js").createBundledStaticCatalogModelResolver;
type StaticCatalogResolver = ReturnType<CreateStaticCatalogResolver>;

const preparedModelRuntimeMocks = vi.hoisted(() => ({
  pluginMetadataSnapshot: {
    plugins: [],
    pluginIds: [],
    index: { plugins: [] },
    manifestRegistry: { plugins: [], diagnostics: [] },
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
  },
  preparedAuthStore: undefined as import("./auth-profiles/types.js").AuthProfileStore | undefined,
  preparedAuthMaterializations:
    [] as import("./auth-profiles/runtime-materializations.js").RuntimeAuthMaterialization[],
  authStorage: {
    getAll: vi.fn<() => AuthStorageData>(() => ({
      custom: { type: "api_key", key: "test-key" },
    })),
    getOAuthProviders: vi.fn(() => []),
  },
  modelRegistry: {
    fork: vi.fn((authStorage: unknown) => ({ authStorage })),
    getAll: vi.fn(() => []),
    find: vi.fn(() => null),
  },
  buildPreparedModelCatalogSnapshot: vi.fn<BuildPreparedModelCatalogSnapshot>(async () => ({
    entries: [],
    routeVariants: [],
  })),
  configuredAgentIds: [] as string[],
  configuredAgentIdsError: undefined as Error | undefined,
  configuredAgentDirs: new Map<string, string>(),
  configuredWorkspaces: new Map<string, string>(),
  createStaticCatalogResolver: vi.fn<CreateStaticCatalogResolver>(),
  discoverAuthStorage: vi.fn((..._args: unknown[]) => undefined as unknown),
  discoverModels: vi.fn(),
  ensureOpenClawModelsJson: vi.fn(async (..._args: unknown[]) => ({
    agentDir: "/tmp/agent",
    wrote: false,
  })),
  loadAgentRuntimePluginRegistryHandle: vi.fn(),
  loadStaticCatalog: vi.fn<LoadStaticCatalog>(async () => []),
  planOpenClawModelsJsonSource: vi.fn(async (...args: unknown[]) => ({
    agentDir: String(args[1]),
    modelsJsonContents: null,
    pluginCatalogs: [],
  })),
  prepareStaticCatalog: vi.fn(async (..._args: unknown[]) => ({ entries: [] })),
  runPreparedModelCatalogWorker: vi.fn(async (..._args: unknown[]) => ({
    entries: [],
    routeVariants: [],
  })),
  runtimeSyntheticAuthProviderRefs: [] as string[],
  resolveAmbientCredentials: vi.fn((..._args: unknown[]) => ({})),
  resolveStaticCatalogModel: vi.fn<StaticCatalogResolver>(() => undefined),
  warn: vi.fn(),
  mutationListener: undefined as
    | ((event: { agentDir?: string; affectsInheritedStores: boolean }) => void)
    | undefined,
  mutationListeners: new Set<
    (event: { agentDir?: string; affectsInheritedStores: boolean }) => void
  >(),
  materializationListeners: new Set<
    (event: { agentDir?: string; affectsInheritedStores: boolean }) => void
  >(),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  isPluginMetadataSnapshotCompatible: () => true,
  loadPluginMetadataSnapshot: () => preparedModelRuntimeMocks.pluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: () => preparedModelRuntimeMocks.pluginMetadataSnapshot,
}));

vi.mock("./prepared-model-catalog-worker.js", () => ({
  createPreparedModelCatalogWorkerInput: ({
    agentFacts,
  }: {
    agentFacts: {
      input: unknown;
      authStore: unknown;
      providerIds: unknown;
    };
  }) => ({
    kind: "catalog",
    generationFingerprint: "test-generation",
    input: agentFacts.input,
    authStore: agentFacts.authStore,
    providerIds: agentFacts.providerIds,
  }),
  createPreparedModelCatalogWorker: () => ({
    loadCatalog: (...args: unknown[]) =>
      preparedModelRuntimeMocks.runPreparedModelCatalogWorker(...args),
    loadAuth: () =>
      Promise.resolve({
        authStore: preparedModelRuntimeMocks.preparedAuthStore ?? { version: 1, profiles: {} },
        authModes: {},
      }),
  }),
}));

vi.mock("./model-catalog.js", async () => ({
  findModelCatalogEntry: (await import("./model-catalog-lookup.js")).findModelCatalogEntry,
  buildPreparedModelCatalogSnapshot: (...args: Parameters<BuildPreparedModelCatalogSnapshot>) =>
    preparedModelRuntimeMocks.buildPreparedModelCatalogSnapshot(...args),
}));

vi.mock("./agent-auth-discovery.js", () => ({
  resolveAmbientAgentCredentialsForDiscovery: (...args: unknown[]) =>
    preparedModelRuntimeMocks.resolveAmbientCredentials(...args),
}));

vi.mock("./agent-model-discovery.js", () => ({
  discoverAuthStorageFacts: (...args: unknown[]) => {
    if ((args[1] as { skipCredentials?: boolean } | undefined)?.skipCredentials === true) {
      return {
        authStorage: { getAll: () => ({}), getOAuthProviders: () => [] },
        store: { version: 1, profiles: {} },
        credentials: {},
      };
    }
    const authStorage = (preparedModelRuntimeMocks.discoverAuthStorage(...args) ??
      preparedModelRuntimeMocks.authStorage) as {
      getAll(): AuthStorageData;
      getOAuthProviders(): unknown[];
    };
    const credentials = authStorage.getAll();
    return {
      authStorage,
      store: preparedModelRuntimeMocks.preparedAuthStore ?? {
        version: 1,
        profiles: Object.fromEntries(
          Object.entries(credentials).map(([provider, credential]) => [
            `${provider}:default`,
            { ...credential, provider },
          ]),
        ),
      },
      credentials,
    };
  },
  discoverAuthStorage: (...args: unknown[]) =>
    preparedModelRuntimeMocks.discoverAuthStorage(...args) ?? preparedModelRuntimeMocks.authStorage,
  discoverModels: (...args: unknown[]) => {
    preparedModelRuntimeMocks.discoverModels(...args);
    return preparedModelRuntimeMocks.modelRegistry;
  },
  discoverModelsFromCapturedSources: (...args: unknown[]) => {
    preparedModelRuntimeMocks.discoverModels(...args);
    return preparedModelRuntimeMocks.modelRegistry;
  },
}));

vi.mock("../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: () =>
    preparedModelRuntimeMocks.runtimeSyntheticAuthProviderRefs,
}));

const agentScopeMocks = vi.hoisted(() => ({
  listAgentEntries: (config: { agents?: { list?: unknown[] } }) => config.agents?.list ?? [],
  listAgentIds: () => {
    if (preparedModelRuntimeMocks.configuredAgentIdsError) {
      throw preparedModelRuntimeMocks.configuredAgentIdsError;
    }
    return preparedModelRuntimeMocks.configuredAgentIds;
  },
  resolveAgentDir: (_config: unknown, agentId: string) =>
    preparedModelRuntimeMocks.configuredAgentDirs.get(agentId) ??
    (agentId === "default" ? "/tmp/unused-agent" : `/tmp/configured-${agentId}`),
  resolveAgentWorkspaceDir: (_config: unknown, agentId: string) =>
    preparedModelRuntimeMocks.configuredWorkspaces.get(agentId) ??
    (agentId === "default" ? "/tmp/unused-workspace" : `/tmp/workspace-${agentId}`),
  tryResolveConfiguredAgentWorkspaceDir: () => "/tmp/unused-workspace",
  tryResolveSystemAgentWorkspaceDir: () => "/tmp/unused-workspace",
  resolveAmbientOwnerAgentId: () => "default",
  resolveDefaultAgentDir: () => "/tmp/unused-agent",
  resolveDefaultAgentId: () => "default",
  resolveAgentConfig: (config: { agents?: { list?: Array<{ id?: string }> } }, agentId: string) =>
    config.agents?.list?.find((entry) => entry.id === agentId),
  resolveAgentEffectiveModelPrimary: () => undefined,
  resolveAgentModelFallbacksOverride: () => undefined,
  resolveEffectiveModelFallbacks: () => undefined,
  resolveSubagentSpawnModelFallbacksOverride: () => undefined,
  resolveRunModelFallbacksOverride: () => undefined,
  resolveSessionAgentIds: ({ agentId }: { agentId?: string }) => ({
    defaultAgentId: "default",
    sessionAgentId: agentId ?? "default",
  }),
}));

vi.mock("./agent-scope.js", () => agentScopeMocks);
vi.mock("./agent-scope-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-scope-config.js")>()),
  listAgentIds: agentScopeMocks.listAgentIds,
  resolveAgentDir: agentScopeMocks.resolveAgentDir,
  resolveAgentWorkspaceDir: agentScopeMocks.resolveAgentWorkspaceDir,
}));

vi.mock("./legacy-inherited-auth-dir.js", () => ({
  resolveLegacyInheritedAuthDir: () => "/tmp/unused-agent",
}));

vi.mock("./auth-profiles/runtime-materializations.js", () => ({
  getPreparedRuntimeAuthMaterializations: () =>
    preparedModelRuntimeMocks.preparedAuthMaterializations,
  registerRuntimeAuthMaterializationMutationListener: (
    listener: (event: { agentDir?: string; affectsInheritedStores: boolean }) => void,
  ) => {
    preparedModelRuntimeMocks.materializationListeners.add(listener);
    return () => preparedModelRuntimeMocks.materializationListeners.delete(listener);
  },
  recordRuntimeAuthMaterialization: (params: {
    agentDir?: string;
    provider: string;
    modelId: string;
    modelApi: string;
    modelBaseUrl: string;
    requestTransportOverrides: "none" | "present";
    authMode: string;
    runtimeOwnerId: string;
    authProfileId?: string;
  }) => {
    preparedModelRuntimeMocks.preparedAuthMaterializations.push({
      provider: params.provider.trim().toLowerCase(),
      modelId: params.modelId.trim().toLowerCase(),
      modelApi: params.modelApi.trim().toLowerCase(),
      modelBaseUrl: params.modelBaseUrl,
      requestTransportOverrides: params.requestTransportOverrides,
      authMode: params.authMode.trim().toLowerCase(),
      runtimeOwnerId: params.runtimeOwnerId.trim().toLowerCase(),
      ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
    });
    const event = {
      agentDir: params.agentDir,
      affectsInheritedStores: params.agentDir === undefined,
    };
    for (const listener of preparedModelRuntimeMocks.materializationListeners) {
      listener(event);
    }
    return true;
  },
  revokeRuntimeAuthMaterializations: (params: {
    agentDir?: string;
    provider: string;
    runtimeOwnerId: string;
  }) => {
    const previousLength = preparedModelRuntimeMocks.preparedAuthMaterializations.length;
    preparedModelRuntimeMocks.preparedAuthMaterializations =
      preparedModelRuntimeMocks.preparedAuthMaterializations.filter(
        (fact) =>
          fact.provider !== params.provider || fact.runtimeOwnerId !== params.runtimeOwnerId,
      );
    if (preparedModelRuntimeMocks.preparedAuthMaterializations.length === previousLength) {
      return false;
    }
    const event = {
      agentDir: params.agentDir,
      affectsInheritedStores: params.agentDir === undefined,
    };
    for (const listener of preparedModelRuntimeMocks.materializationListeners) {
      listener(event);
    }
    return true;
  },
}));

vi.mock("./auth-profiles/runtime-snapshots.js", () => ({
  getPreparedRuntimeAuthProfileStoreSnapshotCore: () => preparedModelRuntimeMocks.preparedAuthStore,
  getRuntimeAuthProfileStoreSnapshot: () => preparedModelRuntimeMocks.preparedAuthStore,
  getRuntimeAuthProfileStoreSnapshotRevision: () => 0,
  registerRuntimeAuthProfileStoreMutationListener: (
    listener: (event: { agentDir?: string; affectsInheritedStores: boolean }) => void,
  ) => {
    preparedModelRuntimeMocks.mutationListener ??= listener;
    preparedModelRuntimeMocks.mutationListeners.add(listener);
    return () => preparedModelRuntimeMocks.mutationListeners.delete(listener);
  },
}));

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  listExternalCliSyncProviderIds: () => [],
  resolveExternalCliAuthProfiles: () => [],
}));

vi.mock("./model-discovery-context.js", () => ({
  resolveModelPluginMetadataSnapshot: () => undefined,
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: (...args: unknown[]) =>
    preparedModelRuntimeMocks.ensureOpenClawModelsJson(...args),
  planOpenClawModelsJsonSource: (...args: unknown[]) =>
    preparedModelRuntimeMocks.planOpenClawModelsJsonSource(...args),
}));

vi.mock("./models-config.providers.implicit.js", () => ({
  prepareImplicitProviderStaticCatalog: (...args: unknown[]) =>
    preparedModelRuntimeMocks.prepareStaticCatalog(...args),
}));

vi.mock("./runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: (...args: unknown[]) =>
    preparedModelRuntimeMocks.loadAgentRuntimePluginRegistryHandle(...args),
}));

vi.mock("./embedded-agent-runner/model.static-catalog.js", () => ({
  loadBundledProviderStaticCatalogContextModels: (...args: Parameters<LoadStaticCatalog>) =>
    preparedModelRuntimeMocks.loadStaticCatalog(...args),
  createBundledStaticCatalogModelResolver: (...args: Parameters<CreateStaticCatalogResolver>) =>
    preparedModelRuntimeMocks.createStaticCatalogResolver(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: preparedModelRuntimeMocks.warn }),
}));

type PreparedModelRuntimeTestApi = {
  getPreparedModelRuntimeOwnerCountForTest(): number;
  resetPreparedModelRuntimeSnapshotsForTest(): void;
  setModelRuntimeBuildTimeoutMsForTest(timeoutMs: number): void;
};

export function getPreparedModelRuntimeMocks(): typeof preparedModelRuntimeMocks {
  return preparedModelRuntimeMocks;
}

export function getPreparedModelRuntimeTestApi(): PreparedModelRuntimeTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.preparedModelRuntimeTestApi")
  ] as PreparedModelRuntimeTestApi;
}

export function resetPreparedModelRuntimeHarness(): void {
  getPreparedModelRuntimeTestApi().resetPreparedModelRuntimeSnapshotsForTest();
  preparedModelRuntimeMocks.authStorage.getAll.mockReset().mockReturnValue({
    custom: { type: "api_key", key: "test-key" },
  });
  preparedModelRuntimeMocks.authStorage.getOAuthProviders.mockReset().mockReturnValue([]);
  preparedModelRuntimeMocks.preparedAuthStore = undefined;
  preparedModelRuntimeMocks.preparedAuthMaterializations = [];
  preparedModelRuntimeMocks.modelRegistry.fork
    .mockReset()
    .mockImplementation((authStorage: unknown) => ({ authStorage }));
  preparedModelRuntimeMocks.modelRegistry.getAll.mockReset().mockReturnValue([]);
  preparedModelRuntimeMocks.modelRegistry.find.mockReset().mockReturnValue(null);
  preparedModelRuntimeMocks.buildPreparedModelCatalogSnapshot
    .mockReset()
    .mockResolvedValue({ entries: [], routeVariants: [] });
  preparedModelRuntimeMocks.discoverAuthStorage
    .mockReset()
    .mockImplementation(() => preparedModelRuntimeMocks.authStorage);
  preparedModelRuntimeMocks.discoverModels.mockReset();
  preparedModelRuntimeMocks.ensureOpenClawModelsJson
    .mockReset()
    .mockResolvedValue({ agentDir: "/tmp/agent", wrote: false });
  preparedModelRuntimeMocks.loadAgentRuntimePluginRegistryHandle
    .mockReset()
    .mockReturnValue(createEmptyPluginRegistry());
  preparedModelRuntimeMocks.loadStaticCatalog.mockReset().mockResolvedValue([]);
  preparedModelRuntimeMocks.planOpenClawModelsJsonSource
    .mockReset()
    .mockImplementation(async (_config, agentDir) => ({
      agentDir: String(agentDir),
      modelsJsonContents: null,
      pluginCatalogs: [],
    }));
  preparedModelRuntimeMocks.prepareStaticCatalog.mockReset().mockResolvedValue({ entries: [] });
  preparedModelRuntimeMocks.runPreparedModelCatalogWorker.mockReset().mockResolvedValue({
    entries: [],
    routeVariants: [],
  });
  preparedModelRuntimeMocks.runtimeSyntheticAuthProviderRefs = [];
  preparedModelRuntimeMocks.resolveAmbientCredentials.mockReset().mockReturnValue({});
  preparedModelRuntimeMocks.resolveStaticCatalogModel.mockReset().mockReturnValue(undefined);
  preparedModelRuntimeMocks.createStaticCatalogResolver
    .mockReset()
    .mockReturnValue(preparedModelRuntimeMocks.resolveStaticCatalogModel);
  preparedModelRuntimeMocks.warn.mockReset();
  preparedModelRuntimeMocks.configuredAgentIds = [];
  preparedModelRuntimeMocks.configuredAgentIdsError = undefined;
  preparedModelRuntimeMocks.configuredAgentDirs.clear();
  preparedModelRuntimeMocks.configuredWorkspaces.clear();
}
