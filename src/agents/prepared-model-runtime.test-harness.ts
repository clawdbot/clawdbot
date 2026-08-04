import { vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";

type LoadStaticCatalog =
  typeof import("./embedded-agent-runner/model.static-catalog.js").loadBundledProviderStaticCatalogContextModels;
type CreateStaticCatalogResolver =
  typeof import("./embedded-agent-runner/model.static-catalog.js").createBundledStaticCatalogModelResolver;
type StaticCatalogResolver = ReturnType<CreateStaticCatalogResolver>;

const preparedModelRuntimeMocks = vi.hoisted(() => ({
  authStorage: {
    getAll: vi.fn(() => ({ custom: { type: "api_key", key: "test-key" } })),
    getOAuthProviders: vi.fn(() => []),
  },
  modelRegistry: {
    fork: vi.fn((authStorage: unknown) => ({ authStorage })),
    getAll: vi.fn(() => []),
    find: vi.fn(() => null),
  },
  buildPreparedModelCatalogSnapshot: vi.fn(async (..._args: unknown[]) => ({
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
  resolveAmbientCredentials: vi.fn((..._args: unknown[]) => ({})),
  resolveStaticCatalogModel: vi.fn<StaticCatalogResolver>(() => undefined),
  warn: vi.fn(),
  mutationListener: undefined as
    | ((event: { agentDir?: string; affectsInheritedStores: boolean }) => void)
    | undefined,
}));

vi.mock("./model-catalog.js", () => ({
  buildPreparedModelCatalogSnapshot: (...args: unknown[]) =>
    preparedModelRuntimeMocks.buildPreparedModelCatalogSnapshot(...args),
}));

vi.mock("./agent-auth-discovery.js", () => ({
  resolveAmbientAgentCredentialsForDiscovery: (...args: unknown[]) =>
    preparedModelRuntimeMocks.resolveAmbientCredentials(...args),
}));

vi.mock("./agent-model-discovery.js", () => ({
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
  resolveRuntimeSyntheticAuthProviderRefs: () => [],
}));

vi.mock("./agent-scope.js", () => ({
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
  resolveDefaultAgentDir: () => "/tmp/unused-agent",
  resolveDefaultAgentId: () => "default",
  resolveAgentEffectiveModelPrimary: () => undefined,
  resolveRunModelFallbacksOverride: () => undefined,
  resolveSessionAgentIds: ({ agentId }: { agentId?: string }) => ({
    defaultAgentId: "default",
    sessionAgentId: agentId ?? "default",
  }),
}));

vi.mock("./auth-profiles/runtime-snapshots.js", () => ({
  registerRuntimeAuthProfileStoreMutationListener: (
    listener: (event: { agentDir?: string; affectsInheritedStores: boolean }) => void,
  ) => {
    preparedModelRuntimeMocks.mutationListener = listener;
    return () => {};
  },
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
