import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const metadataSnapshot = {
    plugins: [],
    pluginIds: [],
    index: { plugins: [] },
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
  };
  const modelRegistry = {
    fork: vi.fn((nextAuthStorage: unknown) => ({ authStorage: nextAuthStorage })),
    getAll: vi.fn(() => []),
  };
  return {
    authStorage,
    modelRegistry,
    metadataSnapshot,
    discoverAuthStorage: vi.fn(() => authStorage),
    discoverModels: vi.fn(() => modelRegistry),
    ensureOpenClawModelsJson: vi.fn(async () => ({ agentDir: "/tmp/agent", wrote: false })),
    buildPreparedModelCatalogSnapshot: vi.fn(async () => ({ entries: [], routeVariants: [] })),
    ensureRuntimePluginsLoaded: vi.fn(),
    loadStaticCatalog: vi.fn(async () => []),
    mutationListener: undefined as
      | ((event: { agentDir?: string; affectsInheritedStores: boolean }) => void)
      | undefined,
  };
});

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: () => mocks.metadataSnapshot,
}));

vi.mock("./agent-model-discovery.js", () => ({
  discoverAuthStorage: mocks.discoverAuthStorage,
  discoverModels: mocks.discoverModels,
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
}));

vi.mock("./runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: mocks.ensureRuntimePluginsLoaded,
}));

vi.mock("./embedded-agent-runner/model.static-catalog.js", () => ({
  loadBundledProviderStaticCatalogContextModels: mocks.loadStaticCatalog,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: vi.fn() }),
}));

const { refreshPreparedModelRuntimeSnapshots } = await import("./prepared-model-runtime.js");
const { resetPreparedModelRuntimeSnapshotsForTest } =
  await import("./prepared-model-runtime.test-support.js");

beforeEach(() => {
  resetPreparedModelRuntimeSnapshotsForTest();
  vi.clearAllMocks();
});

describe("prepared model runtime Gateway catalog mode", () => {
  it("keeps startup and auth refreshes on configured static provider facts", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
        },
      },
    };

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });

    const expectedStaticOptions = expect.objectContaining({
      pluginMetadataSnapshot: mocks.metadataSnapshot,
      providerDiscoveryEntriesOnly: true,
      providerDiscoveryProviderIds: ["openai"],
    });
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenLastCalledWith(
      config,
      "/tmp/prepared-static-agent",
      expectedStaticOptions,
    );
    expect(mocks.discoverModels).toHaveBeenLastCalledWith(
      mocks.authStorage,
      "/tmp/prepared-static-agent",
      expect.objectContaining({ normalizeModels: false }),
    );
    expect(mocks.buildPreparedModelCatalogSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeProviderPluginAugmentation: false }),
    );
    expect(mocks.loadStaticCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerIds: ["openai"] }),
    );

    mocks.mutationListener?.({
      agentDir: "/tmp/prepared-static-agent",
      affectsInheritedStores: false,
    });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenLastCalledWith(
      config,
      "/tmp/prepared-static-agent",
      expectedStaticOptions,
    );
  });
});
