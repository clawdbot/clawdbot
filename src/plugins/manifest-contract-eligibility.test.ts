// Covers manifest contract eligibility decisions.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePluginsConfig } from "./config-state.js";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
  readBundledDiscoveryMode: vi.fn<() => "compat" | "allowlist" | undefined>(() => "allowlist"),
}));

vi.mock("./bundled-discovery-state.js", async () => {
  const { registerPluginMetadataProcessMemoLifecycleClear } =
    await import("./plugin-metadata-lifecycle.js");
  // Mirror the real single-slot memo over the mocked raw reader so the
  // read-once-per-lifecycle assertions keep exercising the memoized seam.
  let memo: { value: "compat" | "allowlist" | undefined } | undefined;
  registerPluginMetadataProcessMemoLifecycleClear(() => {
    memo = undefined;
  });
  return {
    readBundledDiscoveryMode: mocks.readBundledDiscoveryMode,
    readBundledDiscoveryModeMemoized: () => {
      memo ??= { value: mocks.readBundledDiscoveryMode() };
      return memo.value;
    },
    clearBundledDiscoveryModeMemo: () => {
      memo = undefined;
    },
  };
});

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

let isManifestPluginAvailableForControlPlane: typeof import("./manifest-contract-eligibility.js").isManifestPluginAvailableForControlPlane;
let listAvailableManifestContractValues: typeof import("./manifest-contract-eligibility.js").listAvailableManifestContractValues;
let loadManifestContractSnapshot: typeof import("./manifest-contract-eligibility.js").loadManifestContractSnapshot;
let clearPluginMetadataLifecycleCaches: typeof import("./plugin-metadata-lifecycle.js").clearPluginMetadataLifecycleCaches;
let makePluginMetadataIndex: typeof import("./current-plugin-metadata.test-support.js").makePluginMetadataIndex;
let createInstalledPluginEnabledPredicate: typeof import("./installed-plugin-index.js").createInstalledPluginEnabledPredicate;

beforeAll(async () => {
  // The plugins project shares module state across files. Rebind this module graph
  // after the hoisted mocks so an earlier production import cannot bypass them.
  vi.resetModules();
  ({
    isManifestPluginAvailableForControlPlane,
    listAvailableManifestContractValues,
    loadManifestContractSnapshot,
  } = await import("./manifest-contract-eligibility.js"));
  ({ clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js"));
  ({ makePluginMetadataIndex } = await import("./current-plugin-metadata.test-support.js"));
  ({ createInstalledPluginEnabledPredicate } = await import("./installed-plugin-index.js"));
});

describe("bundled manifest contract availability", () => {
  const plugin = {
    id: "google",
    origin: "bundled" as const,
    contracts: { imageGenerationProviders: ["google"] },
  };
  const index = { plugins: [{ pluginId: "google", origin: "bundled", enabled: false }] };
  const snapshot = {
    index,
    plugins: [plugin],
  } as never;

  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    mocks.readBundledDiscoveryMode.mockReset();
    mocks.readBundledDiscoveryMode.mockReturnValue("allowlist");
  });

  it.each([
    {
      name: "an explicitly disabled plugin",
      config: { plugins: { entries: { google: { enabled: false } } } },
    },
    {
      name: "a denylisted plugin",
      config: { plugins: { deny: ["google"] } },
    },
    {
      name: "a plugin outside a restrictive allowlist",
      config: { plugins: { allow: ["another-plugin"] } },
    },
  ])("does not expose $name", ({ config }) => {
    expect(
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config,
        allowBundledProviderCompat: true,
      }),
    ).toBe(false);
    expect(
      listAvailableManifestContractValues({
        snapshot,
        contract: "imageGenerationProviders",
        config,
      }),
    ).toEqual([]);
  });

  it("preserves bundled auto-activation when no explicit owner restriction exists", () => {
    expect(isManifestPluginAvailableForControlPlane({ snapshot, plugin, config: {} })).toBe(true);
    expect(mocks.readBundledDiscoveryMode).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: true },
    { token: "configured" },
    { accounts: { primary: { token: "configured" } } },
  ])(
    "preserves explicitly configured bundled channels outside a restrictive allowlist",
    (channelConfig) => {
      expect(
        isManifestPluginAvailableForControlPlane({
          snapshot,
          plugin: { ...plugin, id: "discord-owner", channels: ["discord"] },
          config: {
            plugins: { allow: ["another-plugin"] },
            channels: { discord: channelConfig },
          } as never,
        }),
      ).toBe(true);
      expect(mocks.readBundledDiscoveryMode).not.toHaveBeenCalled();
    },
  );

  it("preserves explicitly configured custom channel ids distinct from their plugin owner", () => {
    expect(
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin: { ...plugin, id: "custom-owner", channels: ["private-channel"] },
        config: {
          plugins: { allow: ["another-plugin"] },
          channels: { "private-channel": { enabled: true } },
        } as never,
      }),
    ).toBe(true);
    expect(mocks.readBundledDiscoveryMode).not.toHaveBeenCalled();
  });

  it("does not let disabled channel configuration bypass a restrictive allowlist", () => {
    expect(
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin: { ...plugin, id: "discord-owner", channels: ["discord"] },
        config: {
          plugins: { allow: ["another-plugin"] },
          channels: { discord: { enabled: false, token: "configured" } },
        } as never,
      }),
    ).toBe(false);
  });

  it("accepts a normalized owner explicitly included in the restrictive allowlist", () => {
    expect(
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: { plugins: { allow: [" GOOGLE "] } },
      }),
    ).toBe(true);
    expect(mocks.readBundledDiscoveryMode).not.toHaveBeenCalled();
  });

  it.each([{ deny: ["discord-owner"] }, { entries: { "discord-owner": { enabled: false } } }])(
    "does not let channel configuration override explicit plugin prohibition",
    (plugins) => {
      expect(
        isManifestPluginAvailableForControlPlane({
          snapshot,
          plugin: { ...plugin, id: "discord-owner", channels: ["discord"] },
          config: {
            plugins: { allow: ["another-plugin"], ...plugins },
            channels: { discord: { token: "configured" } },
          } as never,
        }),
      ).toBe(false);
    },
  );

  it("reads machine-owned bundled compatibility once per metadata lifecycle", () => {
    const anotherPlugin = {
      ...plugin,
      id: "another-google",
      contracts: { imageGenerationProviders: ["another-google"] },
    };
    const config = { plugins: { allow: ["allowed-plugin"] } };
    const restrictedSnapshot = {
      index: { plugins: [] },
      plugins: [plugin, anotherPlugin],
    } as never;

    expect(
      listAvailableManifestContractValues({
        snapshot: restrictedSnapshot,
        contract: "imageGenerationProviders",
        config,
      }),
    ).toEqual([]);
    expect(mocks.readBundledDiscoveryMode).toHaveBeenCalledTimes(1);

    clearPluginMetadataLifecycleCaches();
    expect(
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config,
        allowBundledProviderCompat: true,
      }),
    ).toBe(false);
    expect(mocks.readBundledDiscoveryMode).toHaveBeenCalledTimes(2);
  });

  it("preserves globally disabled bundled metadata for the named speech compatibility path", () => {
    const config = { plugins: { enabled: false } };
    const normalizedConfig = normalizePluginsConfig(config.plugins);
    expect(
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config,
        normalizedConfig,
      }),
    ).toBe(true);
    expect(
      listAvailableManifestContractValues({
        snapshot,
        config,
        contract: "imageGenerationProviders",
      }),
    ).toEqual(["google"]);
    expect(normalizedConfig.enabled).toBe(false);
  });

  it("preserves the shipped provider-contract compatibility mode", () => {
    mocks.readBundledDiscoveryMode.mockReturnValue("compat");

    expect(
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: { plugins: { allow: ["another-plugin"] } },
        allowBundledProviderCompat: true,
      }),
    ).toBe(true);
  });

  it.each([{ entries: { google: { enabled: false } } }, { deny: ["google"] }])(
    "never bypasses explicit owner prohibition in bundled compatibility mode",
    (plugins) => {
      mocks.readBundledDiscoveryMode.mockReturnValue("compat");

      expect(
        isManifestPluginAvailableForControlPlane({
          snapshot,
          plugin,
          config: { plugins },
          allowBundledProviderCompat: true,
        }),
      ).toBe(false);
    },
  );

  it("keeps non-provider manifest contracts behind the allowlist", () => {
    mocks.readBundledDiscoveryMode.mockReturnValue("compat");
    const nonProviderPlugin = {
      ...plugin,
      contracts: { documentExtractors: ["document"] },
    };
    expect(
      listAvailableManifestContractValues({
        snapshot: { index, plugins: [nonProviderPlugin] } as never,
        contract: "documentExtractors",
        config: { plugins: { allow: ["another-plugin"] } },
      }),
    ).toEqual([]);
  });
});

describe("prepared installed-plugin eligibility", () => {
  it("normalizes installed policy once for a batch of manifest checks", () => {
    const ids = Array.from({ length: 8 }, (_, index) => `external-${index}`);
    const index = makePluginMetadataIndex();
    index.plugins = ids.flatMap((id) => makePluginMetadataIndex(id).plugins);
    let enumerations = 0;
    const entries = new Proxy(Object.fromEntries(ids.map((id) => [id, { enabled: true }])), {
      ownKeys(target) {
        enumerations += 1;
        return Reflect.ownKeys(target);
      },
    });
    const config = { plugins: { entries } };
    const normalizedConfig = normalizePluginsConfig(config.plugins);
    enumerations = 0;
    const isInstalledPluginEnabled = createInstalledPluginEnabledPredicate(index.plugins, config);
    expect(
      ids.map((id) =>
        isManifestPluginAvailableForControlPlane({
          snapshot: { index },
          plugin: { id, origin: "global" },
          config,
          normalizedConfig,
          isInstalledPluginEnabled,
        }),
      ),
    ).toEqual(ids.map(() => true));
    expect(enumerations).toBe(1);
  });

  it.each([
    { config: undefined, expected: [true, true, true, false, false, false] },
    { config: {}, expected: [true, true, false, true, false, false] },
    {
      config: { plugins: { enabled: false } },
      expected: [true, false, false, false, false, false],
    },
    {
      config: { plugins: { allow: ["global", "workspace", "duplicate"] } },
      expected: [false, true, true, false, true, false],
    },
    {
      config: {
        plugins: {
          allow: ["global", "workspace", "duplicate"],
          deny: ["workspace"],
          entries: { global: { enabled: false } },
        },
      },
      expected: [false, false, false, false, true, false],
    },
  ])("preserves policy and first-record selection for $config", ({ config, expected }) => {
    const index = makePluginMetadataIndex();
    index.plugins = [
      ...makePluginMetadataIndex("provider").plugins.map((record) =>
        Object.assign({}, record, {
          origin: "bundled" as const,
          enabledByDefault: true,
          contributions: {
            channels: [],
            channelConfigs: [],
            providers: ["provider"],
            modelCatalogProviders: [],
            modelSupportPrefixes: [],
            modelSupportPatterns: [],
            autoEnableProviderIds: [],
            commandAliases: [],
            contracts: {},
          },
        }),
      ),
      ...makePluginMetadataIndex("global").plugins,
      ...makePluginMetadataIndex("workspace").plugins.map((record) =>
        Object.assign({}, record, {
          origin: "workspace" as const,
        }),
      ),
      ...makePluginMetadataIndex("disabled").plugins.map((record) =>
        Object.assign({}, record, {
          enabled: false,
        }),
      ),
      ...makePluginMetadataIndex("duplicate").plugins.map((record) =>
        Object.assign({}, record, {
          origin: "workspace" as const,
          enabled: false,
        }),
      ),
      ...makePluginMetadataIndex("duplicate").plugins,
    ];
    const plugins = index.plugins.slice(0, 5).map((record) => ({
      id: record.pluginId,
      origin: record.origin,
    }));
    plugins.push({ id: "missing", origin: "global" });
    const isInstalledPluginEnabled = createInstalledPluginEnabledPredicate(index.plugins, config);
    const params = {
      snapshot: { index },
      config,
      normalizedConfig: normalizePluginsConfig(config?.plugins),
    };
    expect(
      plugins.map((plugin) => isManifestPluginAvailableForControlPlane({ ...params, plugin })),
    ).toEqual(expected);
    expect(
      plugins.map((plugin) =>
        isManifestPluginAvailableForControlPlane({ ...params, plugin, isInstalledPluginEnabled }),
      ),
    ).toEqual(expected);
  });
});

describe("loadManifestContractSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      plugins: [],
    });
    mocks.resolvePluginMetadataSnapshot.mockImplementation(
      (params?: Parameters<typeof mocks.loadPluginMetadataSnapshot>[0]) =>
        mocks.loadPluginMetadataSnapshot(params),
    );
  });

  it("resolves metadata with env and workspace scope", () => {
    const env = { HOME: "/home/snapshot" } as NodeJS.ProcessEnv;
    const snapshot = {
      index: { plugins: [] },
      plugins: [],
    };
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(snapshot);

    expect(loadManifestContractSnapshot({ config: {}, workspaceDir: "/workspace", env })).toEqual({
      index: snapshot.index,
      plugins: snapshot.plugins,
    });

    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env,
      workspaceDir: "/workspace",
      allowWorkspaceScopedCurrent: false,
    });
    expect(mocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("opts unscoped callers into the stored workspace-scoped snapshot", () => {
    const env = { HOME: "/home/snapshot" } as NodeJS.ProcessEnv;
    const snapshot = {
      index: { plugins: [] },
      plugins: [],
    };
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(snapshot);

    expect(loadManifestContractSnapshot({ config: {}, env })).toEqual({
      index: snapshot.index,
      plugins: snapshot.plugins,
    });

    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env,
      allowWorkspaceScopedCurrent: true,
    });
    expect(mocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("preserves configless default-discovery snapshot compatibility", () => {
    const env = { HOME: "/home/default-config" } as NodeJS.ProcessEnv;
    const snapshot = {
      index: { plugins: [{ pluginId: "demo" }] },
      plugins: [{ id: "demo" }],
    };
    mocks.loadPluginMetadataSnapshot.mockReturnValue(snapshot);

    expect(loadManifestContractSnapshot({ env })).toEqual({
      index: snapshot.index,
      plugins: snapshot.plugins,
    });

    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith({
      config: undefined,
      env,
      allowWorkspaceScopedCurrent: true,
    });
    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: undefined,
      env,
      allowWorkspaceScopedCurrent: true,
    });
  });

  it("falls back to the shared metadata snapshot loader", () => {
    const env = { HOME: "/home/fallback" } as NodeJS.ProcessEnv;
    const snapshot = {
      index: { plugins: [{ pluginId: "demo" }] },
      plugins: [{ id: "demo" }],
    };
    mocks.loadPluginMetadataSnapshot.mockReturnValue(snapshot);

    expect(loadManifestContractSnapshot({ config: {}, env })).toEqual({
      index: snapshot.index,
      plugins: snapshot.plugins,
    });

    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env,
      allowWorkspaceScopedCurrent: true,
    });
  });
});
