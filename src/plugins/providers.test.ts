// Covers provider plugin registration and runtime composition.
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginAutoEnableResult } from "../config/plugin-auto-enable.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { OpenClawPackageManifest } from "./manifest.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import type { PluginRegistrySnapshot } from "./plugin-registry.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { ProviderPlugin } from "./types.js";

type ResolveRuntimePluginRegistry = typeof import("./loader.js").resolveRuntimePluginRegistry;
type ResolveCompatibleRuntimePluginRegistry =
  typeof import("./loader.js").resolveCompatibleRuntimePluginRegistry;
type GetRuntimePluginRegistryForLoadOptions =
  typeof import("./loader.js").getRuntimePluginRegistryForLoadOptions;
type LoadOpenClawPlugins = typeof import("./loader.js").loadOpenClawPlugins;
type IsPluginRegistryLoadInFlight = typeof import("./loader.js").isPluginRegistryLoadInFlight;
type LoadPluginManifestRegistry =
  typeof import("./manifest-registry.js").loadPluginManifestRegistryCore;
type LoadPluginMetadataSnapshot =
  typeof import("./plugin-metadata-snapshot.js").loadPluginMetadataSnapshot;
type ApplyPluginAutoEnable = typeof import("../config/plugin-auto-enable.js").applyPluginAutoEnable;
type SetActivePluginRegistry = typeof import("./runtime.js").setActivePluginRegistry;

const resolveRuntimePluginRegistryMock = vi.fn<ResolveRuntimePluginRegistry>();
const getRuntimePluginRegistryForLoadOptionsMock = vi.fn<GetRuntimePluginRegistryForLoadOptions>();
const resolveCompatibleRuntimePluginRegistryMock = vi.fn<ResolveCompatibleRuntimePluginRegistry>();
const loadOpenClawPluginsMock = vi.fn<LoadOpenClawPlugins>();
const isPluginRegistryLoadInFlightMock = vi.fn<IsPluginRegistryLoadInFlight>((_) => false);
const loadPluginManifestRegistryMock = vi.fn<LoadPluginManifestRegistry>();
const loadPluginMetadataSnapshotMock = vi.fn<LoadPluginMetadataSnapshot>();
const getCurrentPluginMetadataSnapshotMock = vi.fn();
const applyPluginAutoEnableMock = vi.fn<ApplyPluginAutoEnable>();

let resolveOwningPluginIdsForProvider: typeof import("./providers.js").resolveOwningPluginIdsForProvider;
let resolveOwningPluginIdsForProviderRef: typeof import("./providers.js").resolveOwningPluginIdsForProviderRef;
let resolveOwningPluginIdsForModelRef: typeof import("./providers.js").resolveOwningPluginIdsForModelRef;
let resolveProviderRefOwnership: typeof import("./providers.js").resolveProviderRefOwnership;
let resolveActivatableProviderOwnerPluginIds: typeof import("./providers.js").resolveActivatableProviderOwnerPluginIds;
let resolveEnabledProviderPluginIds: typeof import("./providers.js").resolveEnabledProviderPluginIds;
let resolveCatalogHookProviderPluginIds: typeof import("./providers.js").resolveCatalogHookProviderPluginIds;
let resolveUsageHookProviderPluginContracts: typeof import("./providers.js").resolveUsageHookProviderPluginContracts;
let resolveExternalAuthProfileProviderPluginIds: typeof import("./providers.js").resolveExternalAuthProfileProviderPluginIds;
let resolveDiscoveredProviderPluginIds: typeof import("./providers.js").resolveDiscoveredProviderPluginIds;
let resolveDiscoverableProviderOwnerPluginIds: typeof import("./providers.js").resolveDiscoverableProviderOwnerPluginIds;
let resolvePluginProviders: typeof import("./providers.runtime.js").resolvePluginProvidersCore;
let setActivePluginRegistry: SetActivePluginRegistry;

type ManifestProviderPluginFixture = {
  id: string;
  providerIds: string[];
  cliBackends?: string[];
  origin?: "bundled" | "workspace";
  enabledByDefault?: boolean;
  modelSupport?: { modelPrefixes?: string[]; modelPatterns?: string[] };
  activation?: PluginManifestRecord["activation"];
  setup?: PluginManifestRecord["setup"];
  contracts?: PluginManifestRecord["contracts"];
  modelCatalog?: PluginManifestRecord["modelCatalog"];
  providerAuthAliases?: PluginManifestRecord["providerAuthAliases"];
  packageManifest?: OpenClawPackageManifest;
};

function createManifestProviderPlugin(params: ManifestProviderPluginFixture): PluginManifestRecord {
  return {
    id: params.id,
    enabledByDefault: params.enabledByDefault,
    channels: [],
    providers: params.providerIds,
    cliBackends: params.cliBackends ?? [],
    modelSupport: params.modelSupport,
    activation: params.activation,
    setup: params.setup,
    modelCatalog: params.modelCatalog,
    providerAuthAliases: params.providerAuthAliases,
    packageManifest: params.packageManifest,
    contracts: params.contracts,
    skills: [],
    hooks: [],
    origin: params.origin ?? "bundled",
    rootDir: `/tmp/${params.id}`,
    source: params.origin ?? "bundled",
    manifestPath: `/tmp/${params.id}/openclaw.plugin.json`,
  };
}

function setManifestPlugins(plugins: PluginManifestRecord[]) {
  loadPluginManifestRegistryMock.mockReturnValue({
    plugins,
    diagnostics: [],
  });
}

function setManifestPlugin(params: ManifestProviderPluginFixture) {
  const plugin = createManifestProviderPlugin(params);
  setManifestPlugins([plugin]);
  return plugin;
}

function createOwningProviderManifestPlugins() {
  return [
    createManifestProviderPlugin({
      id: "minimax",
      providerIds: ["minimax", "minimax-portal"],
    }),
    createManifestProviderPlugin({
      id: "openai",
      providerIds: ["openai", "openai"],
      modelSupport: {
        modelPrefixes: ["gpt-", "o1", "o3", "o4"],
      },
    }),
    createManifestProviderPlugin({
      id: "anthropic",
      providerIds: ["anthropic"],
      cliBackends: ["claude-cli"],
      modelSupport: {
        modelPrefixes: ["claude-"],
      },
    }),
  ];
}

function setOwningProviderManifestPlugins() {
  setManifestPlugins(createOwningProviderManifestPlugins());
}

function setOwningProviderManifestPluginsWithWorkspace() {
  setManifestPlugins([
    ...createOwningProviderManifestPlugins(),
    createManifestProviderPlugin({
      id: "workspace-provider",
      providerIds: ["workspace-provider"],
      origin: "workspace",
      modelSupport: {
        modelPrefixes: ["workspace-model-"],
      },
    }),
  ]);
}

function createProviderRegistrySnapshotFixture(): PluginRegistrySnapshot {
  const manifestRegistry = loadPluginManifestRegistryMock();
  const plugins = manifestRegistry.plugins.map((plugin) => {
    const snapshotPlugin = {
      pluginId: plugin.id,
      manifestPath: plugin.manifestPath,
      manifestHash: `test-${plugin.id}`,
      source: plugin.source,
      rootDir: plugin.rootDir,
      origin: plugin.origin,
      enabled: plugin.enabledByDefault !== false,
      syntheticAuthRefs: plugin.syntheticAuthRefs,
      startup: {
        sidecar: false,
        memory: false,
        agentHarnesses: [],
      },
      compat: [],
    };
    if (plugin.enabledByDefault === true) {
      Object.assign(snapshotPlugin, { enabledByDefault: true });
    }
    return snapshotPlugin;
  });

  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords: {},
    plugins,
    diagnostics: [],
  };
}

function createMetadataSnapshotFixture(
  plugins: PluginManifestRecord[],
): Pick<PluginMetadataSnapshot, "owners" | "manifestRegistry" | "byPluginId"> {
  const ownerMap = (entries: Array<[string, readonly string[]]>) => new Map(entries);
  return {
    manifestRegistry: {
      plugins,
      diagnostics: [],
    },
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    owners: {
      channels: ownerMap([]),
      channelConfigs: ownerMap([]),
      providers: ownerMap(
        plugins.flatMap((plugin) =>
          plugin.providers.map((providerId) => [providerId, [plugin.id]] as const),
        ),
      ),
      modelCatalogProviders: ownerMap(
        plugins.flatMap((plugin) =>
          Object.keys(plugin.modelCatalog?.aliases ?? {}).map(
            (providerId) => [providerId, [plugin.id]] as const,
          ),
        ),
      ),
      cliBackends: ownerMap(
        plugins.flatMap((plugin) =>
          [...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])].map(
            (backendId) => [backendId, [plugin.id]] as const,
          ),
        ),
      ),
      setupProviders: ownerMap([]),
      commandAliases: ownerMap([]),
      contracts: ownerMap([]),
    },
  };
}

function normalizeProviderForFixture(value: string): string {
  return value.trim().toLowerCase();
}

function listManifestContributionIdsForFixture(
  plugin: PluginManifestRecord,
  contribution: string,
): readonly string[] {
  switch (contribution) {
    case "providers":
      return plugin.providers;
    case "cliBackends":
      return plugin.cliBackends;
    default:
      return [];
  }
}

function resolvePluginContributionOwnersFixture(params: {
  contribution: string;
  matches: string | ((contributionId: string) => boolean);
}): readonly string[] {
  const matcher =
    typeof params.matches === "string"
      ? (contributionId: string) => contributionId === params.matches
      : params.matches;
  return sortUniqueStrings(
    loadPluginManifestRegistryMock().plugins.flatMap((plugin) =>
      listManifestContributionIdsForFixture(plugin, params.contribution).some(matcher)
        ? [plugin.id]
        : [],
    ),
  );
}

function resolveProviderOwnersFixture(params: { providerId: string }): readonly string[] {
  const providerId = normalizeProviderForFixture(params.providerId);
  if (!providerId) {
    return [];
  }
  return resolvePluginContributionOwnersFixture({
    contribution: "providers",
    matches: (contributionId) => normalizeProviderForFixture(contributionId) === providerId,
  });
}

function getLastMockCallArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  label: string,
): unknown {
  const calls = mock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error(`expected ${label} to be called`);
  }
  return call[0];
}

function getLastRuntimeRegistryCall(): Record<string, unknown> {
  return getLastMockCallArg(resolveRuntimePluginRegistryMock, "runtime plugin registry") as Record<
    string,
    unknown
  >;
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function expectPluginConfigState(
  config: unknown,
  expected: {
    enabled?: boolean;
    allow?: readonly string[];
    entries?: Record<string, { enabled?: boolean }>;
  },
) {
  const plugins = expectRecordFields((config as { plugins?: unknown } | undefined)?.plugins, {});
  if (expected.enabled !== undefined) {
    expect(plugins.enabled).toBe(expected.enabled);
  }
  for (const pluginId of expected.allow ?? []) {
    expect(plugins.allow).toContain(pluginId);
  }
  for (const [pluginId, entry] of Object.entries(expected.entries ?? {})) {
    expect((plugins.entries as Record<string, unknown> | undefined)?.[pluginId]).toEqual(entry);
  }
  return plugins;
}

function expectLastRuntimeRegistryCall(params: {
  onlyPluginIds?: readonly string[];
  activate?: boolean;
  workspaceDir?: string;
  config?: {
    enabled?: boolean;
    allow?: readonly string[];
    entries?: Record<string, { enabled?: boolean }>;
  };
}) {
  const call = expectRecordFields(getLastRuntimeRegistryCall(), {
    ...(params.onlyPluginIds !== undefined ? { onlyPluginIds: params.onlyPluginIds } : {}),
    ...(params.activate !== undefined ? { activate: params.activate } : {}),
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
  });
  if (params.config) {
    expectPluginConfigState(call.config, params.config);
  }
}

function expectLastSetupRegistryCall(params: {
  onlyPluginIds?: readonly string[];
  activate?: boolean;
  config?: {
    enabled?: boolean;
    allow?: readonly string[];
    entries?: Record<string, { enabled?: boolean }>;
  };
}) {
  const call = getLastMockCallArg(loadOpenClawPluginsMock, "OpenClaw plugin setup loader");
  const options = expectRecordFields(call, {
    ...(params.onlyPluginIds !== undefined ? { onlyPluginIds: params.onlyPluginIds } : {}),
    ...(params.activate !== undefined ? { activate: params.activate } : {}),
  });
  if (params.config) {
    expectPluginConfigState(options.config, params.config);
  }
}

function expectResolvedProviders(providers: unknown, expected: unknown[]) {
  expect(providers).toEqual(expected);
}

function expectLastRuntimeRegistryLoad(params?: {
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}) {
  expectRecordFields(getLastRuntimeRegistryCall(), {
    cache: true,
    activate: false,
    ...(params?.env ? { env: params.env } : {}),
    ...(params?.onlyPluginIds !== undefined ? { onlyPluginIds: params.onlyPluginIds } : {}),
  });
}

function expectLastSetupRegistryLoad(params?: {
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}) {
  const call = getLastMockCallArg(loadOpenClawPluginsMock, "OpenClaw plugin setup loader");
  expectRecordFields(call, {
    cache: false,
    activate: false,
    ...(params?.env ? { env: params.env } : {}),
    ...(params?.onlyPluginIds !== undefined ? { onlyPluginIds: params.onlyPluginIds } : {}),
  });
}

function getLastResolvedPluginConfig() {
  return getLastRuntimeRegistryCall().config as
    | {
        plugins?: {
          allow?: string[];
          entries?: Record<string, { enabled?: boolean }>;
        };
      }
    | undefined;
}

function getLastSetupLoadedPluginConfig() {
  const call = expectRecordFields(
    getLastMockCallArg(loadOpenClawPluginsMock, "OpenClaw plugin setup loader"),
    {},
  );
  return (call.config ?? undefined) as
    | {
        plugins?: {
          allow?: string[];
          entries?: Record<string, { enabled?: boolean }>;
        };
      }
    | undefined;
}

function createAutoEnabledProviderConfig() {
  const rawConfig: OpenClawConfig = {
    plugins: {},
  };
  const autoEnabledConfig: OpenClawConfig = {
    ...rawConfig,
    plugins: {
      entries: {
        google: { enabled: true },
      },
    },
  };
  return { rawConfig, autoEnabledConfig };
}

function expectAutoEnabledProviderLoad(params: { rawConfig: unknown; autoEnabledConfig: unknown }) {
  expect(applyPluginAutoEnableMock).toHaveBeenCalledWith(
    expect.objectContaining({
      config: params.rawConfig,
      env: process.env,
      manifestRegistry: expect.objectContaining({
        plugins: expect.arrayContaining([expect.objectContaining({ id: "google" })]),
      }),
    }),
  );
  expectProviderRuntimeRegistryLoad({ config: params.autoEnabledConfig });
}
function expectOwningPluginIds(provider: string, expectedPluginIds?: readonly string[]) {
  expect(resolveOwningPluginIdsForProvider({ provider })).toEqual(expectedPluginIds);
}

function expectModelOwningPluginIds(model: string, expectedPluginIds?: readonly string[]) {
  expect(resolveOwningPluginIdsForModelRef({ model })).toEqual(expectedPluginIds);
}

function expectProviderRuntimeRegistryLoad(params?: { config?: unknown; env?: NodeJS.ProcessEnv }) {
  expectRecordFields(getLastRuntimeRegistryCall(), {
    ...(params?.config ? { config: params.config } : {}),
    ...(params?.env ? { env: params.env } : {}),
  });
}

describe("resolvePluginProviders", () => {
  beforeAll(async () => {
    vi.resetModules();
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    vi.doMock("./loader.js", () => ({
      loadOpenClawPlugins: (...args: Parameters<LoadOpenClawPlugins>) =>
        loadOpenClawPluginsMock(...args),
      isPluginRegistryLoadInFlight: (...args: Parameters<IsPluginRegistryLoadInFlight>) =>
        isPluginRegistryLoadInFlightMock(...args),
      resolveCompatibleRuntimePluginRegistry: (
        ...args: Parameters<ResolveCompatibleRuntimePluginRegistry>
      ) => resolveCompatibleRuntimePluginRegistryMock(...args),
      getRuntimePluginRegistryForLoadOptions: (
        ...args: Parameters<GetRuntimePluginRegistryForLoadOptions>
      ) => getRuntimePluginRegistryForLoadOptionsMock(...args),
      resolveRuntimePluginRegistry: (...args: Parameters<ResolveRuntimePluginRegistry>) =>
        resolveRuntimePluginRegistryMock(...args),
    }));
    vi.doMock("../config/plugin-auto-enable.js", () => ({
      applyPluginAutoEnable: (...args: Parameters<ApplyPluginAutoEnable>) =>
        applyPluginAutoEnableMock(...args),
    }));
    vi.doMock("./manifest-registry.js", () => ({
      loadPluginManifestRegistryCore: (...args: Parameters<LoadPluginManifestRegistry>) =>
        loadPluginManifestRegistryMock(...args),
    }));
    vi.doMock("./plugin-metadata-snapshot.js", () => {
      const loadSnapshot = (params: Parameters<LoadPluginMetadataSnapshot>[0]) => {
        loadPluginMetadataSnapshotMock(params);
        return {
          manifestRegistry: loadPluginManifestRegistryMock(),
          index: createProviderRegistrySnapshotFixture(),
        };
      };
      return {
        loadPluginMetadataSnapshot: loadSnapshot,
        resolvePluginMetadataSnapshot: loadSnapshot,
      };
    });
    vi.doMock("./current-plugin-metadata-snapshot.js", () => ({
      getCurrentPluginMetadataSnapshot: (...args: unknown[]) =>
        getCurrentPluginMetadataSnapshotMock(...args),
    }));
    vi.doMock("./plugin-registry.js", async () => {
      const actual =
        await vi.importActual<typeof import("./plugin-registry.js")>("./plugin-registry.js");
      return {
        ...actual,
        loadPluginRegistrySnapshot: () => createProviderRegistrySnapshotFixture(),
        resolvePluginContributionOwners: resolvePluginContributionOwnersFixture,
        resolveProviderOwners: resolveProviderOwnersFixture,
      };
    });
    vi.doMock("./installed-plugin-index-store.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./installed-plugin-index-store.js")>();
      return {
        ...actual,
        readPersistedInstalledPluginIndexSync: () => null,
      };
    });
    ({
      resolveActivatableProviderOwnerPluginIds,
      resolveOwningPluginIdsForProvider,
      resolveOwningPluginIdsForProviderRef,
      resolveOwningPluginIdsForModelRef,
      resolveProviderRefOwnership,
      resolveEnabledProviderPluginIds,
      resolveCatalogHookProviderPluginIds,
      resolveUsageHookProviderPluginContracts,
      resolveExternalAuthProfileProviderPluginIds,
      resolveDiscoveredProviderPluginIds,
      resolveDiscoverableProviderOwnerPluginIds,
    } = await import("./providers.js"));
    ({ resolvePluginProvidersCore: resolvePluginProviders } =
      await import("./providers.runtime.js"));
    ({ setActivePluginRegistry } = await import("./runtime.js"));
  });

  it("does not treat cli backend ids as provider owners", () => {
    setOwningProviderManifestPlugins();

    expectOwningPluginIds("claude-cli");
    expectOwningPluginIds("codex-cli");
  });

  it("maps setup-only cli backend ids to explicit provider refs via manifests", () => {
    setManifestPlugin({
      id: "setup-only-backend-owner",
      providerIds: [],
      setup: { cliBackends: ["setup-only-cli"] },
    });

    expectOwningPluginIds("setup-only-cli");
    expect(resolveOwningPluginIdsForProviderRef({ provider: "setup-only-cli" })).toEqual([
      "setup-only-backend-owner",
    ]);
  });

  it("maps explicit provider refs to provider or cli-backend owners", () => {
    setOwningProviderManifestPlugins();

    expect(resolveOwningPluginIdsForProviderRef({ provider: "claude-cli" })).toEqual(["anthropic"]);
    expect(resolveProviderRefOwnership({ provider: "claude-cli" })).toEqual({
      status: "owned",
      pluginIds: ["anthropic"],
    });
  });

  it("marks explicit provider refs with multiple owners as ambiguous", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "first-owner",
        providerIds: [],
        cliBackends: ["shared-cli"],
        origin: "workspace",
      }),
      createManifestProviderPlugin({
        id: "second-owner",
        providerIds: [],
        cliBackends: ["shared-cli"],
        origin: "workspace",
      }),
    ]);

    expect(resolveProviderRefOwnership({ provider: "shared-cli" })).toEqual({
      status: "ambiguous",
      pluginIds: ["first-owner", "second-owner"],
    });
  });

  it("maps explicit cli-backend model refs to owning plugin ids", () => {
    setOwningProviderManifestPlugins();

    expectModelOwningPluginIds("claude-cli/claude-sonnet-4-6", ["anthropic"]);
  });

  it("maps manifest model catalog provider aliases to owning plugin ids", () => {
    setManifestPlugin({
      id: "moonshot",
      providerIds: ["moonshot"],
      modelCatalog: {
        aliases: {
          moonshotai: { provider: "moonshot" },
          "moonshot-ai": { provider: "moonshot" },
        },
      },
    });

    expectOwningPluginIds("moonshotai", ["moonshot"]);
    expectOwningPluginIds("moonshot-ai", ["moonshot"]);
  });

  it("uses the current metadata owner maps before loading plugin metadata", () => {
    const plugins = [
      createManifestProviderPlugin({
        id: "openai",
        providerIds: ["openai", "openai"],
      }),
    ];
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(createMetadataSnapshotFixture(plugins));

    expectOwningPluginIds("openai", ["openai"]);

    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config: undefined,
      env: undefined,
      allowWorkspaceScopedSnapshot: true,
    });
  });

  it("uses current metadata owner maps for cli backend provider refs", () => {
    const plugins = [
      createManifestProviderPlugin({
        id: "anthropic",
        providerIds: [],
        cliBackends: ["claude-cli"],
      }),
    ];
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(createMetadataSnapshotFixture(plugins));

    expect(resolveOwningPluginIdsForProviderRef({ provider: "claude-cli" })).toEqual(["anthropic"]);

    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("keeps normalized case-variant owners from current metadata maps", () => {
    const plugins = [
      createManifestProviderPlugin({
        id: "exact-owner",
        providerIds: ["codex-cli"],
        cliBackends: ["codex-cli"],
      }),
      createManifestProviderPlugin({
        id: "case-owner",
        providerIds: ["CODEX-CLI"],
        cliBackends: ["CODEX-CLI"],
      }),
    ];
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(createMetadataSnapshotFixture(plugins));

    expect(resolveOwningPluginIdsForProvider({ provider: "codex-cli" })).toEqual([
      "case-owner",
      "exact-owner",
    ]);
    expect(resolveOwningPluginIdsForProviderRef({ provider: "codex-cli" })).toEqual([
      "case-owner",
      "exact-owner",
    ]);
  });

  it("keeps explicit manifest registries ahead of current metadata owner maps", () => {
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(
      createMetadataSnapshotFixture([
        createManifestProviderPlugin({
          id: "stale-owner",
          providerIds: ["dynamic-provider"],
          cliBackends: ["dynamic-cli"],
        }),
      ]),
    );
    const manifestRegistry = {
      diagnostics: [],
      plugins: [
        createManifestProviderPlugin({
          id: "fresh-owner",
          providerIds: ["dynamic-provider"],
          cliBackends: ["dynamic-cli"],
        }),
      ],
    };

    expect(
      resolveOwningPluginIdsForProvider({ provider: "dynamic-provider", manifestRegistry }),
    ).toEqual(["fresh-owner"]);
    expect(
      resolveOwningPluginIdsForProviderRef({ provider: "dynamic-cli", manifestRegistry }),
    ).toEqual(["fresh-owner"]);

    expect(getCurrentPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("maps manifest provider auth aliases to the target provider owner", () => {
    setManifestPlugin({
      id: "openai",
      providerIds: ["openai"],
      providerAuthAliases: {
        openai: "openai",
      },
    });

    expectOwningPluginIds("openai", ["openai"]);
    expectOwningPluginIds("openai", ["openai"]);
    expectModelOwningPluginIds("openai/gpt-5.5", ["openai"]);
  });

  it("reflects provider ownership manifest changes on the next lookup", () => {
    setManifestPlugin({
      id: "first-owner",
      providerIds: ["dynamic-provider"],
    });
    expectOwningPluginIds("dynamic-provider", ["first-owner"]);

    setManifestPlugin({
      id: "second-owner",
      providerIds: ["dynamic-provider"],
    });

    expectOwningPluginIds("dynamic-provider", ["second-owner"]);
  });

  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    resolveRuntimePluginRegistryMock.mockReset();
    getRuntimePluginRegistryForLoadOptionsMock.mockReset();
    resolveCompatibleRuntimePluginRegistryMock.mockReset();
    loadOpenClawPluginsMock.mockReset();
    isPluginRegistryLoadInFlightMock.mockReset();
    isPluginRegistryLoadInFlightMock.mockReturnValue(false);
    loadPluginMetadataSnapshotMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    const provider: ProviderPlugin = {
      id: "demo-provider",
      label: "Demo Provider",
      auth: [],
    };
    const registry = createEmptyPluginRegistry();
    registry.providers.push({ pluginId: "google", provider, source: "bundled" });
    resolveRuntimePluginRegistryMock.mockReturnValue(registry);
    getRuntimePluginRegistryForLoadOptionsMock.mockImplementation((...args) =>
      resolveRuntimePluginRegistryMock(...args),
    );
    loadOpenClawPluginsMock.mockReturnValue(registry);
    loadPluginManifestRegistryMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    applyPluginAutoEnableMock.mockImplementation(
      (params): PluginAutoEnableResult => ({
        config: params.config ?? ({} as OpenClawConfig),
        changes: [],
        autoEnabledReasons: {},
      }),
    );
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "google",
        providerIds: ["google"],
        enabledByDefault: true,
      }),
      createManifestProviderPlugin({ id: "browser", providerIds: [] }),
      createManifestProviderPlugin({
        id: "kilocode",
        providerIds: ["kilocode"],
        enabledByDefault: true,
      }),
      createManifestProviderPlugin({
        id: "moonshot",
        providerIds: ["moonshot"],
        enabledByDefault: true,
      }),
      createManifestProviderPlugin({ id: "google-gemini-cli-auth", providerIds: [] }),
      createManifestProviderPlugin({
        id: "workspace-provider",
        providerIds: ["workspace-provider"],
        origin: "workspace",
        modelSupport: {
          modelPrefixes: ["workspace-model-"],
        },
      }),
    ]);
  });

  it("forwards an explicit env to plugin loading", () => {
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    const providers = resolvePluginProviders({
      workspaceDir: "/workspace/explicit",
      env,
    });

    expectResolvedProviders(providers, [
      { id: "demo-provider", label: "Demo Provider", auth: [], pluginId: "google" },
    ]);
    expectRecordFields(getLastRuntimeRegistryCall(), {
      workspaceDir: "/workspace/explicit",
      env,
      cache: true,
      activate: false,
    });
  });

  it("keeps bundled provider plugins enabled when they default on outside Vitest compat", () => {
    expect(resolveEnabledProviderPluginIds({ config: {}, env: {} as NodeJS.ProcessEnv })).toEqual([
      "google",
      "kilocode",
      "moonshot",
    ]);
  });

  it("does not answer explicit registry lookups from current metadata snapshots", () => {
    setOwningProviderManifestPlugins();
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(
      createMetadataSnapshotFixture([
        createManifestProviderPlugin({
          id: "stale-owner",
          providerIds: ["stale-provider"],
        }),
      ]),
    );

    expect(
      resolveEnabledProviderPluginIds({
        config: {},
        env: {} as NodeJS.ProcessEnv,
        registry: createProviderRegistrySnapshotFixture(),
      }),
    ).toEqual([]);

    expect(getCurrentPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("loads catalog augment hooks only for declarative runtime catalog manifests", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "static-bundled",
        providerIds: ["static-bundled"],
        enabledByDefault: true,
        modelCatalog: {
          providers: {
            "static-bundled": {
              models: [{ id: "static-model" }],
            },
          },
        },
      }),
      createManifestProviderPlugin({
        id: "runtime-bundled",
        providerIds: ["runtime-bundled"],
        enabledByDefault: true,
        modelCatalog: {
          runtimeAugment: true,
        },
      }),
      createManifestProviderPlugin({
        id: "workspace-runtime",
        providerIds: ["workspace-runtime"],
        enabledByDefault: true,
        origin: "workspace",
      }),
    ]);

    expect(
      resolveCatalogHookProviderPluginIds({ config: {}, env: {} as NodeJS.ProcessEnv }),
    ).toEqual(["runtime-bundled"]);
  });

  it("loads bundled Ollama catalog augment hooks from the manifest runtime flag", () => {
    setManifestPlugin({
      id: "ollama",
      providerIds: ["ollama", "ollama-cloud"],
      enabledByDefault: true,
      modelCatalog: {
        runtimeAugment: true,
      },
    });

    expect(
      resolveCatalogHookProviderPluginIds({ config: {}, env: {} as NodeJS.ProcessEnv }),
    ).toEqual(["ollama"]);
  });

  it("loads usage hooks only for manifest-declared providers", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "usage-owner",
        providerIds: ["usage-provider"],
        enabledByDefault: true,
        contracts: { usageProviders: ["usage-provider"] },
      }),
      createManifestProviderPlugin({
        id: "regular-provider",
        providerIds: ["regular-provider"],
        enabledByDefault: true,
      }),
    ]);

    expect(
      resolveUsageHookProviderPluginContracts({ config: {}, env: {} as NodeJS.ProcessEnv }),
    ).toEqual([{ pluginId: "usage-owner", providerIds: ["usage-provider"] }]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves external auth hook plugin ids from manifest contracts without runtime loading", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "external-auth-owner",
        providerIds: ["demo"],
        contracts: { externalAuthProviders: ["demo"] },
      }),
      createManifestProviderPlugin({
        id: "regular-provider",
        providerIds: ["regular"],
      }),
    ]);

    expect(
      resolveExternalAuthProfileProviderPluginIds({
        config: {},
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toEqual(["external-auth-owner"]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("filters bundled provider plugins through restrictive allowlists", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "kilocode",
        providerIds: ["kilocode"],
        origin: "bundled",
        enabledByDefault: true,
      }),
      createManifestProviderPlugin({
        id: "moonshot",
        providerIds: ["moonshot"],
        origin: "bundled",
        enabledByDefault: true,
      }),
      createManifestProviderPlugin({
        id: "openrouter",
        providerIds: ["openrouter"],
        origin: "bundled",
        enabledByDefault: true,
      }),
    ]);

    const discovered = resolveDiscoveredProviderPluginIds({
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(discovered).toEqual(["openrouter"]);
  });

  it("treats explicit empty provider scopes as scoped-empty in provider helpers", () => {
    expect(
      resolveEnabledProviderPluginIds({
        config: {},
        env: {} as NodeJS.ProcessEnv,
        onlyPluginIds: [],
      }),
    ).toStrictEqual([]);
    expect(
      resolveDiscoveredProviderPluginIds({
        config: {},
        env: {} as NodeJS.ProcessEnv,
        onlyPluginIds: [],
      }),
    ).toStrictEqual([]);
  });

  it.each([
    ["ordinary env", {} as NodeJS.ProcessEnv],
    ["Vitest env", { VITEST: "true" } as NodeJS.ProcessEnv],
  ])("loads only provider plugins on the provider runtime path with %s", (_name, env) => {
    resolvePluginProviders({ env });

    expectLastRuntimeRegistryLoad({
      env,
      onlyPluginIds: ["google", "kilocode", "moonshot"],
    });
    expect(getLastResolvedPluginConfig()).toBeUndefined();
  });

  it("ignores every bundledProviderVitestCompat value without changing loader input", () => {
    const env = { VITEST: "true" } as NodeJS.ProcessEnv;
    const inputs = ([undefined, true, false] as const).map((bundledProviderVitestCompat) => {
      resolvePluginProviders({
        env,
        ...(bundledProviderVitestCompat === undefined ? {} : { bundledProviderVitestCompat }),
      });
      const { logger: _logger, ...input } = getLastRuntimeRegistryCall();
      expect(input.config).toBeUndefined();
      expect(input.activationSourceConfig).toBeUndefined();
      expect(input.onlyPluginIds).toEqual(["google", "kilocode", "moonshot"]);
      return input;
    });

    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[2]).toEqual(inputs[0]);
  });

  it("scopes setup provider plugin discovery to the allowlist by default", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["google"],
        },
      },
      mode: "setup",
      includeUntrustedWorkspacePlugins: false,
    });

    expectLastSetupRegistryLoad({
      onlyPluginIds: ["google"],
    });
    expectPluginConfigState(getLastSetupLoadedPluginConfig(), {
      allow: ["google"],
      entries: {
        google: { enabled: true },
      },
    });
  });

  it("does not include workspace providers blocked by allowlist gating", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter"],
          entries: {
            "workspace-provider": { enabled: true },
          },
        },
      },
      mode: "setup",
      includeUntrustedWorkspacePlugins: false,
    });

    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("loads provider plugins from the auto-enabled config snapshot", () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledProviderConfig();
    applyPluginAutoEnableMock.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        google: ["google auth configured"],
      },
    });

    resolvePluginProviders({ config: rawConfig });

    expectAutoEnabledProviderLoad({
      rawConfig,
      autoEnabledConfig,
    });
  });

  it("routes provider runtime resolution through the compatible active-registry seam", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["google"],
        },
      },
      onlyPluginIds: ["google"],
      workspaceDir: "/workspace/runtime",
    });

    expectRecordFields(getLastRuntimeRegistryCall(), {
      workspaceDir: "/workspace/runtime",
      cache: true,
      activate: false,
    });
  });

  it("inherits workspaceDir from the active registry when provider resolution omits it", () => {
    setActivePluginRegistry(
      createEmptyPluginRegistry(),
      undefined,
      "default",
      "/workspace/runtime",
    );

    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["google"],
        },
      },
      onlyPluginIds: ["google"],
    });

    expectRecordFields(getLastRuntimeRegistryCall(), {
      workspaceDir: "/workspace/runtime",
      cache: true,
      activate: false,
    });
  });

  it("inherits workspaceDir from the active registry when loading the metadata snapshot", () => {
    setActivePluginRegistry(
      createEmptyPluginRegistry(),
      undefined,
      "default",
      "/workspace/runtime",
    );

    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["google"],
        },
      },
      onlyPluginIds: ["google"],
    });

    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalled();
    const snapshotCall = loadPluginMetadataSnapshotMock.mock.calls.at(-1)?.[0];
    expect(snapshotCall?.workspaceDir).toBe("/workspace/runtime");
  });
  it("activates owning plugins for explicit provider refs", () => {
    setOwningProviderManifestPlugins();

    resolvePluginProviders({
      config: {},
      providerRefs: ["openai"],
      activate: true,
    });

    expectLastRuntimeRegistryCall({
      onlyPluginIds: ["openai"],
      activate: true,
      config: {
        allow: ["openai"],
        entries: {
          openai: { enabled: true },
        },
      },
    });
  });

  it("activates the owner plugin for custom provider refs that use a native provider api", () => {
    setManifestPlugin({
      id: "ollama",
      providerIds: ["ollama"],
      enabledByDefault: true,
    });

    resolvePluginProviders({
      config: {
        models: {
          providers: {
            "ollama-spark": {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      providerRefs: ["ollama-spark"],
      activate: true,
    });

    expectLastRuntimeRegistryCall({
      onlyPluginIds: ["ollama"],
      activate: true,
      config: {
        allow: ["ollama"],
        entries: {
          ollama: { enabled: true },
        },
      },
    });
  });

  it("uses activation.onProviders to keep explicit provider owners on the runtime path", () => {
    setManifestPlugin({
      id: "activation-owned-provider",
      providerIds: [],
      activation: {
        onProviders: ["activation-owned"],
      },
    });

    resolvePluginProviders({
      config: {},
      providerRefs: ["activation-owned"],
      activate: true,
    });

    expectLastRuntimeRegistryCall({
      onlyPluginIds: ["activation-owned-provider"],
      activate: true,
      config: {
        allow: ["activation-owned-provider"],
        entries: {
          "activation-owned-provider": { enabled: true },
        },
      },
    });
  });

  it("does not activate explicit runtime owners when plugins are globally disabled", () => {
    setManifestPlugin({
      id: "activation-owned-provider",
      providerIds: [],
      activation: {
        onProviders: ["activation-owned"],
      },
    });

    expect(
      resolveActivatableProviderOwnerPluginIds({
        pluginIds: ["activation-owned-provider"],
        config: {
          plugins: {
            enabled: false,
          },
        },
      }),
    ).toStrictEqual([]);
  });

  it("does not activate explicit runtime owners disabled in config", () => {
    setManifestPlugin({
      id: "activation-owned-provider",
      providerIds: [],
      activation: {
        onProviders: ["activation-owned"],
      },
    });

    expect(
      resolveActivatableProviderOwnerPluginIds({
        pluginIds: ["activation-owned-provider"],
        config: {
          plugins: {
            entries: {
              "activation-owned-provider": { enabled: false },
            },
          },
        },
      }),
    ).toStrictEqual([]);
  });

  it("does not activate explicit runtime owners outside the allowlist", () => {
    setManifestPlugin({
      id: "activation-owned-provider",
      providerIds: [],
      activation: {
        onProviders: ["activation-owned"],
      },
    });

    expect(
      resolveActivatableProviderOwnerPluginIds({
        pluginIds: ["activation-owned-provider"],
        config: {
          plugins: {
            allow: ["other-plugin"],
          },
        },
      }),
    ).toStrictEqual([]);
  });

  it("uses setup.providers to keep explicit provider owners on the setup path", () => {
    setManifestPlugin({
      id: "setup-owned-provider",
      providerIds: [],
      setup: {
        providers: [{ id: "setup-owned" }],
      },
    });

    resolvePluginProviders({
      config: {},
      providerRefs: ["setup-owned"],
      activate: true,
      mode: "setup",
    });

    expectLastSetupRegistryCall({
      onlyPluginIds: ["setup-owned-provider"],
      activate: true,
      config: {
        allow: ["setup-owned-provider"],
        entries: {
          "setup-owned-provider": { enabled: true },
        },
      },
    });
  });

  it("does not override global plugin disable during setup owner loading", () => {
    setManifestPlugin({
      id: "setup-owned-provider",
      providerIds: [],
      setup: {
        providers: [{ id: "setup-owned" }],
      },
    });

    resolvePluginProviders({
      config: {
        plugins: {
          enabled: false,
        },
      },
      providerRefs: ["setup-owned"],
      activate: true,
      mode: "setup",
    });

    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("does not override explicitly disabled setup owners", () => {
    setManifestPlugin({
      id: "setup-owned-provider",
      providerIds: [],
      setup: {
        providers: [{ id: "setup-owned" }],
      },
    });

    resolvePluginProviders({
      config: {
        plugins: {
          entries: {
            "setup-owned-provider": { enabled: false },
          },
        },
      },
      providerRefs: ["setup-owned"],
      activate: true,
      mode: "setup",
    });

    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("filters explicit setup owners through the untrusted workspace discovery gate", () => {
    setManifestPlugin({
      id: "workspace-activation-owner",
      providerIds: [],
      origin: "workspace",
      activation: {
        onProviders: ["workspace-activation"],
      },
    });

    const providers = resolvePluginProviders({
      config: {},
      providerRefs: ["workspace-activation"],
      activate: true,
      mode: "setup",
      includeUntrustedWorkspacePlugins: false,
    });

    expect(providers).toStrictEqual([]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("does not auto-activate untrusted workspace runtime owners when requested", () => {
    setManifestPlugin({
      id: "workspace-activation-owner",
      providerIds: [],
      origin: "workspace",
      activation: {
        onProviders: ["workspace-activation"],
      },
    });
    resolveRuntimePluginRegistryMock.mockReturnValue(createEmptyPluginRegistry());

    const providers = resolvePluginProviders({
      config: {},
      providerRefs: ["workspace-activation"],
      activate: true,
      includeUntrustedWorkspacePlugins: false,
    });

    expect(providers).toStrictEqual([]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(getRuntimePluginRegistryForLoadOptionsMock).not.toHaveBeenCalled();
  });

  it("does not auto-activate workspace runtime owners by default", () => {
    setManifestPlugin({
      id: "workspace-activation-owner",
      providerIds: [],
      origin: "workspace",
      activation: {
        onProviders: ["workspace-activation"],
      },
    });
    resolveRuntimePluginRegistryMock.mockReturnValue(createEmptyPluginRegistry());

    const providers = resolvePluginProviders({
      config: {},
      providerRefs: ["workspace-activation"],
      activate: true,
    });

    expect(providers).toStrictEqual([]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(getRuntimePluginRegistryForLoadOptionsMock).not.toHaveBeenCalled();
  });

  it("keeps explicit provider requests scoped when runtime owner activation resolves nothing", () => {
    setManifestPlugin({
      id: "activation-owned-provider",
      providerIds: [],
      activation: {
        onProviders: ["activation-owned"],
      },
    });
    resolveRuntimePluginRegistryMock.mockReturnValue(createEmptyPluginRegistry());

    const providers = resolvePluginProviders({
      config: {
        plugins: {
          allow: ["other-plugin"],
        },
      },
      providerRefs: ["activation-owned"],
      activate: true,
    });

    expect(providers).toStrictEqual([]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(getRuntimePluginRegistryForLoadOptionsMock).not.toHaveBeenCalled();
  });

  it("does not keep explicitly trusted disabled workspace setup owners discoverable", () => {
    setManifestPlugin({
      id: "workspace-activation-owner",
      providerIds: [],
      origin: "workspace",
      activation: {
        onProviders: ["workspace-activation"],
      },
    });

    expect(
      resolveDiscoverableProviderOwnerPluginIds({
        pluginIds: ["workspace-activation-owner"],
        config: {
          plugins: {
            enabled: true,
            allow: ["workspace-activation-owner"],
            entries: {
              "workspace-activation-owner": { enabled: false },
            },
          },
        },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toStrictEqual([]);
  });

  it("does not auto-activate explicitly disabled trusted workspace runtime owners", () => {
    setManifestPlugin({
      id: "workspace-activation-owner",
      providerIds: [],
      origin: "workspace",
      activation: {
        onProviders: ["workspace-activation"],
      },
    });

    expect(
      resolveActivatableProviderOwnerPluginIds({
        pluginIds: ["workspace-activation-owner"],
        config: {
          plugins: {
            allow: ["workspace-activation-owner"],
            entries: {
              "workspace-activation-owner": { enabled: false },
            },
          },
        },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toStrictEqual([]);
  });

  it("scopes cli-backend provider refs to their owning plugin", () => {
    setOwningProviderManifestPlugins();

    resolvePluginProviders({
      config: {},
      providerRefs: ["claude-cli"],
      activate: true,
    });

    expectLastRuntimeRegistryCall({
      onlyPluginIds: ["anthropic"],
      activate: true,
      config: {
        allow: ["anthropic"],
        entries: {
          anthropic: { enabled: true },
        },
      },
    });
  });
  it.each([
    {
      provider: "minimax-portal",
      expectedPluginIds: ["minimax"],
    },
    {
      provider: "openai",
      expectedPluginIds: ["openai"],
    },
    {
      provider: "gemini-cli",
      expectedPluginIds: undefined,
    },
  ] as const)(
    "maps $provider to owning plugin ids via manifests",
    ({ provider, expectedPluginIds }) => {
      setOwningProviderManifestPlugins();

      expectOwningPluginIds(provider, expectedPluginIds);
    },
  );

  it.each([
    {
      model: "gpt-5.4",
      expectedPluginIds: ["openai"],
    },
    {
      model: "claude-sonnet-4-6",
      expectedPluginIds: ["anthropic"],
    },
    {
      model: "openai/gpt-5.4",
      expectedPluginIds: ["openai"],
    },
    {
      model: "workspace-model-fast",
      expectedPluginIds: ["workspace-provider"],
    },
    {
      model: "unknown-model",
      expectedPluginIds: undefined,
    },
  ] as const)(
    "maps $model to owning plugin ids via modelSupport",
    ({ model, expectedPluginIds }) => {
      setOwningProviderManifestPluginsWithWorkspace();

      expectModelOwningPluginIds(model, expectedPluginIds);
    },
  );

  it("refuses ambiguous bundled shorthand model ownership", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "openai",
        providerIds: ["openai"],
        modelSupport: { modelPrefixes: ["gpt-"] },
      }),
      createManifestProviderPlugin({
        id: "proxy-openai",
        providerIds: ["proxy-openai"],
        modelSupport: { modelPrefixes: ["gpt-"] },
      }),
    ]);

    expectModelOwningPluginIds("gpt-5.4", undefined);
  });

  it("prefers non-bundled shorthand model ownership over bundled matches", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "openai",
        providerIds: ["openai"],
        modelSupport: { modelPrefixes: ["gpt-"] },
      }),
      createManifestProviderPlugin({
        id: "workspace-openai",
        providerIds: ["workspace-openai"],
        origin: "workspace",
        modelSupport: { modelPrefixes: ["gpt-"] },
      }),
    ]);

    expectModelOwningPluginIds("gpt-5.4", ["workspace-openai"]);
  });

  it("rejects ReDoS modelPatterns via compileSafeRegex guard", () => {
    setManifestPlugin({
      id: "malicious",
      providerIds: ["malicious"],
      modelSupport: {
        modelPatterns: ["(a+)+$"],
      },
    });

    // Without the guard, this input causes catastrophic backtracking.
    // With compileSafeRegex, the pattern is rejected and the plugin is not matched.
    const start = performance.now();
    expectModelOwningPluginIds("a".repeat(30) + "!", undefined);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it("preserves LM Studio @iq* quant suffixes when resolving model-owned provider plugins", () => {
    setManifestPlugin({
      id: "lmstudio",
      providerIds: ["lmstudio"],
      modelSupport: {
        modelPatterns: ["^qwen3\\.6-27b@iq3_xxs$"],
      },
    });
    const provider: ProviderPlugin = {
      id: "lmstudio",
      label: "LM Studio",
      auth: [],
    };
    const registry = createEmptyPluginRegistry();
    registry.providers.push({ pluginId: "lmstudio", provider, source: "bundled" });
    resolveRuntimePluginRegistryMock.mockReturnValue(registry);

    expectModelOwningPluginIds("qwen3.6-27b@iq3_xxs", ["lmstudio"]);
    expectModelOwningPluginIds("qwen3.6-27b", undefined);

    const providers = resolvePluginProviders({
      config: {},
      modelRefs: ["qwen3.6-27b@iq3_xxs"],
    });

    expectResolvedProviders(providers, [
      { id: "lmstudio", label: "LM Studio", auth: [], pluginId: "lmstudio" },
    ]);
    expectLastRuntimeRegistryCall({
      onlyPluginIds: ["lmstudio"],
      config: {
        allow: ["lmstudio"],
        entries: {
          lmstudio: { enabled: true },
        },
      },
    });
  });

  it("auto-loads a model-owned provider plugin from shorthand model refs", () => {
    setManifestPlugin({
      id: "openai",
      providerIds: ["openai", "openai"],
      modelSupport: {
        modelPrefixes: ["gpt-", "o1", "o3", "o4"],
      },
    });
    const provider: ProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      auth: [],
    };
    const registry = createEmptyPluginRegistry();
    registry.providers.push({ pluginId: "openai", provider, source: "bundled" });
    resolveRuntimePluginRegistryMock.mockReturnValue(registry);

    const providers = resolvePluginProviders({
      config: {},
      modelRefs: ["gpt-5.4"],
    });

    expectResolvedProviders(providers, [
      { id: "openai", label: "OpenAI", auth: [], pluginId: "openai" },
    ]);
    expectLastRuntimeRegistryCall({
      onlyPluginIds: ["openai"],
      config: {
        allow: ["openai"],
        entries: {
          openai: { enabled: true },
        },
      },
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
