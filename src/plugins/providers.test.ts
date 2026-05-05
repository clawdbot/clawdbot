import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginAutoEnableResult } from "../config/plugin-auto-enable.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { OpenClawPackageManifest } from "./manifest.js";
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
  typeof import("./manifest-registry.js").loadPluginManifestRegistry;
type ApplyPluginAutoEnable = typeof import("../config/plugin-auto-enable.js").applyPluginAutoEnable;
type SetActivePluginRegistry = typeof import("./runtime.js").setActivePluginRegistry;

const resolveRuntimePluginRegistryMock = vi.fn<ResolveRuntimePluginRegistry>();
const getRuntimePluginRegistryForLoadOptionsMock = vi.fn<GetRuntimePluginRegistryForLoadOptions>();
const resolveCompatibleRuntimePluginRegistryMock = vi.fn<ResolveCompatibleRuntimePluginRegistry>();
const loadOpenClawPluginsMock = vi.fn<LoadOpenClawPlugins>();
const isPluginRegistryLoadInFlightMock = vi.fn<IsPluginRegistryLoadInFlight>((_) => false);
const loadPluginManifestRegistryMock = vi.fn<LoadPluginManifestRegistry>();
const applyPluginAutoEnableMock = vi.fn<ApplyPluginAutoEnable>();

let resolveOwningPluginIdsForProvider: typeof import("./providers.js").resolveOwningPluginIdsForProvider;
let resolveOwningPluginIdsForModelRef: typeof import("./providers.js").resolveOwningPluginIdsForModelRef;
let resolveActivatableProviderOwnerPluginIds: typeof import("./providers.js").resolveActivatableProviderOwnerPluginIds;
let resolveEnabledProviderPluginIds: typeof import("./providers.js").resolveEnabledProviderPluginIds;
let resolveExternalAuthProfileCompatFallbackPluginIds: typeof import("./providers.js").resolveExternalAuthProfileCompatFallbackPluginIds;
let resolveExternalAuthProfileProviderPluginIds: typeof import("./providers.js").resolveExternalAuthProfileProviderPluginIds;
let resolveDiscoveredProviderPluginIds: typeof import("./providers.js").resolveDiscoveredProviderPluginIds;
let resolveDiscoverableProviderOwnerPluginIds: typeof import("./providers.js").resolveDiscoverableProviderOwnerPluginIds;
let resolvePluginProviders: typeof import("./providers.runtime.js").resolvePluginProviders;
let setActivePluginRegistry: SetActivePluginRegistry;

function createManifestProviderPlugin(params: {
  id: string;
  providerIds: string[];
  cliBackends?: string[];
  origin?: "bundled" | "workspace";
  enabledByDefault?: boolean;
  modelSupport?: { modelPrefixes?: string[]; modelPatterns?: string[] };
  activation?: PluginManifestRecord["activation"];
  setup?: PluginManifestRecord["setup"];
  contracts?: PluginManifestRecord["contracts"];
  packageManifest?: OpenClawPackageManifest;
}): PluginManifestRecord {
  return {
    id: params.id,
    enabledByDefault: params.enabledByDefault,
    channels: [],
    providers: params.providerIds,
    cliBackends: params.cliBackends ?? [],
    modelSupport: params.modelSupport,
    activation: params.activation,
    setup: params.setup,
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

function setOwningProviderManifestPlugins() {
  setManifestPlugins([
    createManifestProviderPlugin({
      id: "minimax",
      providerIds: ["minimax", "minimax-portal"],
    }),
    createManifestProviderPlugin({
      id: "openai",
      providerIds: ["openai", "openai-codex"],
      cliBackends: ["codex-cli"],
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
  ]);
}

function setOwningProviderManifestPluginsWithWorkspace() {
  setManifestPlugins([
    createManifestProviderPlugin({
      id: "minimax",
      providerIds: ["minimax", "minimax-portal"],
    }),
    createManifestProviderPlugin({
      id: "openai",
      providerIds: ["openai", "openai-codex"],
      cliBackends: ["codex-cli"],
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
        deferConfiguredChannelFullLoadUntilAfterListen: false,
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

function normalizeProviderForFixture(value: string): string {
  return value.trim().toLowerCase();
}

function sortUniqueFixtureValues(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
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
  return sortUniqueFixtureValues(
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

function getLastRuntimeRegistryCall(): Record<string, unknown> {
  const call = resolveRuntimePluginRegistryMock.mock.calls.at(-1)?.[0];
  expect(call).toBeDefined();
  return (call ?? {}) as Record<string, unknown>;
}

function cloneOptions<T>(value: T): T {
  return structuredClone(value);
}

function expectResolvedProviders(providers: unknown, expected: unknown[]) {
  expect(providers).toEqual(expected);
}

function expectLastRuntimeRegistryLoad(params?: {
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}) {
  expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
    expect.objectContaining({
      cache: true,
      activate: false,
      ...(params?.env ? { env: params.env } : {}),
      ...(params?.onlyPluginIds !== undefined ? { onlyPluginIds: params.onlyPluginIds } : {}),
    }),
  );
}

function expectLastSetupRegistryLoad(params?: {
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}) {
  expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      cache: false,
      activate: false,
      ...(params?.env ? { env: params.env } : {}),
      ...(params?.onlyPluginIds !== undefined ? { onlyPluginIds: params.onlyPluginIds } : {}),
    }),
  );
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
  const call = loadOpenClawPluginsMock.mock.calls.at(-1)?.[0];
  expect(call).toBeDefined();
  return (call?.config ?? undefined) as
    | {
        plugins?: {
          allow?: string[];
          entries?: Record<string, { enabled?: boolean }>;
        };
      }
    | undefined;
}

function createBundledProviderCompatOptions(params?: { onlyPluginIds?: readonly string[] }) {
  return {
    config: {
      plugins: {
        allow: ["openrouter"],
        bundledDiscovery: "compat" as const,
      },
    },
    bundledProviderAllowlistCompat: true,
    ...(params?.onlyPluginIds !== undefined ? { onlyPluginIds: params.onlyPluginIds } : {}),
  };
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
  expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
    config: params.rawConfig,
    env: process.env,
  });
  expectProviderRuntimeRegistryLoad({ config: params.autoEnabledConfig });
}

function expectResolvedAllowlistState(params?: {
  expectedAllow?: readonly string[];
  unexpectedAllow?: readonly string[];
  expectedEntries?: Record<string, { enabled?: boolean }>;
  expectedOnlyPluginIds?: readonly string[];
}) {
  expectLastRuntimeRegistryLoad(
    params?.expectedOnlyPluginIds ? { onlyPluginIds: params.expectedOnlyPluginIds } : undefined,
  );

  const config = getLastResolvedPluginConfig();
  const allow = config?.plugins?.allow ?? [];

  if (params?.expectedAllow) {
    expect(allow).toEqual(expect.arrayContaining([...params.expectedAllow]));
  }
  if (params?.expectedEntries) {
    expect(config?.plugins?.entries).toEqual(expect.objectContaining(params.expectedEntries));
  }
  params?.unexpectedAllow?.forEach((disallowedPluginId) => {
    expect(allow).not.toContain(disallowedPluginId);
  });
}

function expectOwningPluginIds(provider: string, expectedPluginIds?: readonly string[]) {
  expect(resolveOwningPluginIdsForProvider({ provider })).toEqual(expectedPluginIds);
}

function expectModelOwningPluginIds(model: string, expectedPluginIds?: readonly string[]) {
  expect(resolveOwningPluginIdsForModelRef({ model })).toEqual(expectedPluginIds);
}

function expectProviderRuntimeRegistryLoad(params?: { config?: unknown; env?: NodeJS.ProcessEnv }) {
  expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
    expect.objectContaining({
      ...(params?.config ? { config: params.config } : {}),
      ...(params?.env ? { env: params.env } : {}),
    }),
  );
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
      loadPluginManifestRegistry: (...args: Parameters<LoadPluginManifestRegistry>) =>
        loadPluginManifestRegistryMock(...args),
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
      resolveOwningPluginIdsForModelRef,
      resolveEnabledProviderPluginIds,
      resolveExternalAuthProfileCompatFallbackPluginIds,
      resolveExternalAuthProfileProviderPluginIds,
      resolveDiscoveredProviderPluginIds,
      resolveDiscoverableProviderOwnerPluginIds,
    } = await import("./providers.js"));
    ({ resolvePluginProviders } = await import("./providers.runtime.js"));
    ({ setActivePluginRegistry } = await import("./runtime.js"));
  });

  it("maps cli backend ids to owning plugin ids via manifests", () => {
    setOwningProviderManifestPlugins();

    expectOwningPluginIds("claude-cli", ["anthropic"]);
    expectOwningPluginIds("codex-cli", ["openai"]);
  });

  it("reflects provider ownership manifest changes on the next lookup", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "first-owner",
        providerIds: ["dynamic-provider"],
      }),
    ]);
    expectOwningPluginIds("dynamic-provider", ["first-owner"]);

    setManifestPlugins([
      createManifestProviderPlugin({
        id: "second-owner",
        providerIds: ["dynamic-provider"],
      }),
    ]);

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
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace/explicit",
        env,
        cache: true,
        activate: false,
      }),
    );
  });

  it("keeps bundled provider plugins enabled when they default on outside Vitest compat", () => {
    expect(resolveEnabledProviderPluginIds({ config: {}, env: {} as NodeJS.ProcessEnv })).toEqual([
      "google",
      "kilocode",
      "moonshot",
    ]);
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

  it("reuses declared external auth plugin ids for compat fallback filtering", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "declared-auth-owner",
        providerIds: ["declared"],
        origin: "workspace",
        contracts: { externalAuthProviders: ["declared"] },
      }),
      createManifestProviderPlugin({
        id: "legacy-auth-owner",
        providerIds: ["legacy"],
        origin: "workspace",
      }),
    ]);
    const declaredPluginIds = new Set(["declared-auth-owner"]);

    expect(
      resolveExternalAuthProfileCompatFallbackPluginIds({
        config: {
          plugins: {
            entries: {
              "declared-auth-owner": { enabled: true },
              "legacy-auth-owner": { enabled: true },
            },
          },
        },
        env: {} as NodeJS.ProcessEnv,
        declaredPluginIds,
      }),
    ).toEqual(["legacy-auth-owner"]);
  });

  it("filters bundled provider plugins by allowlist by default", () => {
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

  it("returns all bundled provider plugins in explicit compat mode", () => {
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
          bundledDiscovery: "compat",
        },
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(discovered).toEqual(["kilocode", "moonshot", "openrouter"]);
  });

  it("treats explicit empty provider scopes as scoped-empty in provider helpers", () => {
    expect(
      resolveEnabledProviderPluginIds({
        config: {},
        env: {} as NodeJS.ProcessEnv,
        onlyPluginIds: [],
      }),
    ).toEqual([]);
    expect(
      resolveDiscoveredProviderPluginIds({
        config: {},
        env: {} as NodeJS.ProcessEnv,
        onlyPluginIds: [],
      }),
    ).toEqual([]);
  });

  it.each([
    {
      name: "can augment restrictive allowlists for bundled provider compatibility",
      options: createBundledProviderCompatOptions(),
      expectedAllow: ["openrouter", "google", "kilocode", "moonshot"],
      expectedEntries: {
        google: { enabled: true },
        kilocode: { enabled: true },
        moonshot: { enabled: true },
      },
    },
    {
      name: "does not reintroduce the retired google auth plugin id into compat allowlists",
      options: createBundledProviderCompatOptions(),
      expectedAllow: ["google"],
      unexpectedAllow: ["google-gemini-cli-auth"],
    },
    {
      name: "does not inject non-bundled provider plugin ids into compat allowlists",
      options: createBundledProviderCompatOptions(),
      unexpectedAllow: ["workspace-provider"],
    },
    {
      name: "scopes bundled provider compat expansion to the requested plugin ids",
      options: createBundledProviderCompatOptions({
        onlyPluginIds: ["moonshot"],
      }),
      expectedAllow: ["openrouter", "moonshot"],
      unexpectedAllow: ["google", "kilocode"],
      expectedOnlyPluginIds: ["moonshot"],
    },
  ] as const)(
    "$name",
    ({ options, expectedAllow, expectedEntries, expectedOnlyPluginIds, unexpectedAllow }) => {
      resolvePluginProviders(
        cloneOptions(options) as unknown as Parameters<typeof resolvePluginProviders>[0],
      );

      expectResolvedAllowlistState({
        expectedAllow,
        expectedEntries,
        expectedOnlyPluginIds,
        unexpectedAllow,
      });
    },
  );

  it("can enable bundled provider plugins under Vitest when no explicit plugin config exists", () => {
    resolvePluginProviders({
      env: { VITEST: "1" } as NodeJS.ProcessEnv,
      bundledProviderVitestCompat: true,
    });

    expectLastRuntimeRegistryLoad();
    expect(getLastResolvedPluginConfig()).toEqual(
      expect.objectContaining({
        plugins: expect.objectContaining({
          enabled: true,
          allow: expect.arrayContaining(["google", "moonshot"]),
          entries: expect.objectContaining({
            google: { enabled: true },
            moonshot: { enabled: true },
          }),
        }),
      }),
    );
  });

  it("uses process env for Vitest compat when no explicit env is passed", () => {
    const previousVitest = process.env.VITEST;
    process.env.VITEST = "1";
    try {
      resolvePluginProviders({
        bundledProviderVitestCompat: true,
        onlyPluginIds: ["google"],
      });

      expectLastRuntimeRegistryLoad({
        onlyPluginIds: ["google"],
      });
      expect(getLastResolvedPluginConfig()).toEqual(
        expect.objectContaining({
          plugins: expect.objectContaining({
            enabled: true,
            allow: ["google"],
            entries: {
              google: { enabled: true },
            },
          }),
        }),
      );
    } finally {
      if (previousVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = previousVitest;
      }
    }
  });

  it("does not leak host Vitest env into an explicit non-Vitest env", () => {
    const previousVitest = process.env.VITEST;
    process.env.VITEST = "1";
    try {
      resolvePluginProviders({
        env: {} as NodeJS.ProcessEnv,
        bundledProviderVitestCompat: true,
      });

      expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          config: undefined,
          env: {},
        }),
      );
    } finally {
      if (previousVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = previousVitest;
      }
    }
  });

  it("loads only provider plugins on the provider runtime path", () => {
    resolvePluginProviders({
      bundledProviderAllowlistCompat: true,
    });

    expectLastRuntimeRegistryLoad({
      onlyPluginIds: ["google", "kilocode", "moonshot"],
    });
  });

  it("includes present bundled providers in bundled compat expansion", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "google",
        providerIds: ["google"],
      }),
      createManifestProviderPlugin({
        id: "codex",
        providerIds: ["codex"],
      }),
    ]);

    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter"],
          bundledDiscovery: "compat",
        },
      },
      bundledProviderAllowlistCompat: true,
    });

    expectResolvedAllowlistState({
      expectedAllow: ["openrouter", "google", "codex"],
    });
    expectLastRuntimeRegistryLoad({
      onlyPluginIds: ["codex", "google"],
    });
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
    expect(getLastSetupLoadedPluginConfig()).toEqual(
      expect.objectContaining({
        plugins: expect.objectContaining({
          allow: ["google"],
          entries: expect.objectContaining({
            google: { enabled: true },
          }),
        }),
      }),
    );
  });

  it("loads all discovered provider plugins in setup mode for explicit compat configs", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter"],
          bundledDiscovery: "compat",
          entries: {
            google: { enabled: false },
          },
        },
      },
      mode: "setup",
    });

    expectLastSetupRegistryLoad({
      onlyPluginIds: ["google", "kilocode", "moonshot", "workspace-provider"],
    });
    expect(getLastSetupLoadedPluginConfig()).toEqual(
      expect.objectContaining({
        plugins: expect.objectContaining({
          allow: expect.arrayContaining([
            "openrouter",
            "google",
            "kilocode",
            "moonshot",
            "workspace-provider",
          ]),
          entries: expect.objectContaining({
            google: { enabled: false },
            kilocode: { enabled: true },
            moonshot: { enabled: true },
            "workspace-provider": { enabled: true },
          }),
        }),
      }),
    );
  });

  it("excludes untrusted workspace provider plugins from setup discovery when requested", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter"],
          bundledDiscovery: "compat",
        },
      },
      mode: "setup",
      includeUntrustedWorkspacePlugins: false,
    });

    expectLastSetupRegistryLoad({
      onlyPluginIds: ["google", "kilocode", "moonshot"],
    });
  });

  it("does not keep trusted but disabled workspace provider plugins eligible in setup discovery", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter", "workspace-provider"],
          bundledDiscovery: "compat",
          entries: {
            "workspace-provider": { enabled: false },
          },
        },
      },
      mode: "setup",
      includeUntrustedWorkspacePlugins: false,
    });

    expectLastSetupRegistryLoad({
      onlyPluginIds: ["google", "kilocode", "moonshot"],
    });
  });

  it("does not include trusted-but-disabled workspace providers when denylist blocks them", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter", "workspace-provider"],
          bundledDiscovery: "compat",
          deny: ["workspace-provider"],
          entries: {
            "workspace-provider": { enabled: false },
          },
        },
      },
      mode: "setup",
      includeUntrustedWorkspacePlugins: false,
    });

    expectLastSetupRegistryLoad({
      onlyPluginIds: ["google", "kilocode", "moonshot"],
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

    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace/runtime",
        cache: true,
        activate: false,
      }),
    );
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

    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace/runtime",
        cache: true,
        activate: false,
      }),
    );
  });
  it("activates owning plugins for explicit provider refs", () => {
    setOwningProviderManifestPlugins();

    resolvePluginProviders({
      config: {},
      providerRefs: ["openai-codex"],
      activate: true,
    });

    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["openai"],
        activate: true,
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["openai"],
            entries: {
              openai: { enabled: true },
            },
          }),
        }),
      }),
    );
  });

  it("activates the owner plugin for custom provider refs that use a native provider api", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "ollama",
        providerIds: ["ollama"],
        enabledByDefault: true,
      }),
    ]);

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

    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["ollama"],
        activate: true,
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["ollama"],
            entries: {
              ollama: { enabled: true },
            },
          }),
        }),
      }),
    );
  });

  it("uses activation.onProviders to keep explicit provider owners on the runtime path", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "activation-owned-provider",
        providerIds: [],
        activation: {
          onProviders: ["activation-owned"],
        },
      }),
    ]);

    resolvePluginProviders({
      config: {},
      providerRefs: ["activation-owned"],
      activate: true,
    });

    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["activation-owned-provider"],
        activate: true,
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["activation-owned-provider"],
            entries: {
              "activation-owned-provider": { enabled: true },
            },
          }),
        }),
      }),
    );
  });

  it("does not activate explicit runtime owners when plugins are globally disabled", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "activation-owned-provider",
        providerIds: [],
        activation: {
          onProviders: ["activation-owned"],
        },
      }),
    ]);

    expect(
      resolveActivatableProviderOwnerPluginIds({
        pluginIds: ["activation-owned-provider"],
        config: {
          plugins: {
            enabled: false,
          },
        },
      }),
    ).toEqual([]);
  });

  it("does not activate explicit runtime owners disabled in config", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "activation-owned-provider",
        providerIds: [],
        activation: {
          onProviders: ["activation-owned"],
        },
      }),
    ]);

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
    ).toEqual([]);
  });

  it("does not activate explicit runtime owners outside the allowlist", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "activation-owned-provider",
        providerIds: [],
        activation: {
          onProviders: ["activation-owned"],
        },
      }),
    ]);

    expect(
      resolveActivatableProviderOwnerPluginIds({
        pluginIds: ["activation-owned-provider"],
        config: {
          plugins: {
            allow: ["other-plugin"],
          },
        },
      }),
    ).toEqual([]);
  });

  it("uses setup.providers to keep explicit provider owners on the setup path", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "setup-owned-provider",
        providerIds: [],
        setup: {
          providers: [{ id: "setup-owned" }],
        },
      }),
    ]);

    resolvePluginProviders({
      config: {},
      providerRefs: ["setup-owned"],
      activate: true,
      mode: "setup",
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["setup-owned-provider"],
        activate: true,
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["setup-owned-provider"],
            entries: {
              "setup-owned-provider": { enabled: true },
            },
          }),
        }),
      }),
    );
  });

  it("does not override global plugin disable during setup owner loading", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "setup-owned-provider",
        providerIds: [],
        setup: {
          providers: [{ id: "setup-owned" }],
        },
      }),
    ]);

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
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "setup-owned-provider",
        providerIds: [],
        setup: {
          providers: [{ id: "setup-owned" }],
        },
      }),
    ]);

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
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "workspace-activation-owner",
        providerIds: [],
        origin: "workspace",
        activation: {
          onProviders: ["workspace-activation"],
        },
      }),
    ]);

    const providers = resolvePluginProviders({
      config: {},
      providerRefs: ["workspace-activation"],
      activate: true,
      mode: "setup",
      includeUntrustedWorkspacePlugins: false,
    });

    expect(providers).toEqual([]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("does not auto-activate untrusted workspace runtime owners when requested", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "workspace-activation-owner",
        providerIds: [],
        origin: "workspace",
        activation: {
          onProviders: ["workspace-activation"],
        },
      }),
    ]);
    resolveRuntimePluginRegistryMock.mockReturnValue(createEmptyPluginRegistry());

    const providers = resolvePluginProviders({
      config: {},
      providerRefs: ["workspace-activation"],
      activate: true,
      includeUntrustedWorkspacePlugins: false,
    });

    expect(providers).toEqual([]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(getRuntimePluginRegistryForLoadOptionsMock).not.toHaveBeenCalled();
  });

  it("does not auto-activate workspace runtime owners by default", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "workspace-activation-owner",
        providerIds: [],
        origin: "workspace",
        activation: {
          onProviders: ["workspace-activation"],
        },
      }),
    ]);
    resolveRuntimePluginRegistryMock.mockReturnValue(createEmptyPluginRegistry());

    const providers = resolvePluginProviders({
      config: {},
      providerRefs: ["workspace-activation"],
      activate: true,
    });

    expect(providers).toEqual([]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(getRuntimePluginRegistryForLoadOptionsMock).not.toHaveBeenCalled();
  });

  it("keeps explicit provider requests scoped when runtime owner activation resolves nothing", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "activation-owned-provider",
        providerIds: [],
        activation: {
          onProviders: ["activation-owned"],
        },
      }),
    ]);
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

    expect(providers).toEqual([]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(getRuntimePluginRegistryForLoadOptionsMock).not.toHaveBeenCalled();
  });

  it("does not keep explicitly trusted disabled workspace setup owners discoverable", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "workspace-activation-owner",
        providerIds: [],
        origin: "workspace",
        activation: {
          onProviders: ["workspace-activation"],
        },
      }),
    ]);

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
    ).toEqual([]);
  });

  it("does not auto-activate explicitly disabled trusted workspace runtime owners", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "workspace-activation-owner",
        providerIds: [],
        origin: "workspace",
        activation: {
          onProviders: ["workspace-activation"],
        },
      }),
    ]);

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
    ).toEqual([]);
  });

  it("keeps legacy CLI backend ownership as the explicit provider fallback", () => {
    setOwningProviderManifestPlugins();

    resolvePluginProviders({
      config: {},
      providerRefs: ["claude-cli"],
      activate: true,
    });

    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["anthropic"],
        activate: true,
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["anthropic"],
            entries: {
              anthropic: { enabled: true },
            },
          }),
        }),
      }),
    );
  });
  it.each([
    {
      provider: "minimax-portal",
      expectedPluginIds: ["minimax"],
    },
    {
      provider: "openai-codex",
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

  it("preserves LM Studio @iq* quant suffixes when resolving model-owned provider plugins", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "lmstudio",
        providerIds: ["lmstudio"],
        modelSupport: {
          modelPatterns: ["^qwen3\\.6-27b@iq3_xxs$"],
        },
      }),
    ]);
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
      bundledProviderAllowlistCompat: true,
    });

    expectResolvedProviders(providers, [
      { id: "lmstudio", label: "LM Studio", auth: [], pluginId: "lmstudio" },
    ]);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["lmstudio"],
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["lmstudio"],
            entries: {
              lmstudio: { enabled: true },
            },
          }),
        }),
      }),
    );
  });

  it("auto-loads a model-owned provider plugin from shorthand model refs", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "openai",
        providerIds: ["openai", "openai-codex"],
        modelSupport: {
          modelPrefixes: ["gpt-", "o1", "o3", "o4"],
        },
      }),
    ]);
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
      bundledProviderAllowlistCompat: true,
    });

    expectResolvedProviders(providers, [
      { id: "openai", label: "OpenAI", auth: [], pluginId: "openai" },
    ]);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["openai"],
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["openai"],
            entries: {
              openai: { enabled: true },
            },
          }),
        }),
      }),
    );
  });
});
