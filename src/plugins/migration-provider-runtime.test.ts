// Covers migration provider runtime hooks supplied by plugins.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

type MockManifestRegistry = {
  plugins: Array<Record<string, unknown>>;
  diagnostics: unknown[];
};

type MockPluginIndex = {
  plugins: Array<{
    pluginId: string;
    origin: string;
    enabled: boolean;
    enabledByDefault?: boolean;
  }>;
  diagnostics: unknown[];
};

type MockPluginSnapshotLoadParams = {
  index?: MockPluginIndex;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

function createEmptyMockManifestRegistry(): MockManifestRegistry {
  return { plugins: [], diagnostics: [] };
}

function createMockPluginIndex(plugins: MockPluginIndex["plugins"]): MockPluginIndex {
  return { plugins, diagnostics: [] };
}

const mocks = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn<(params?: unknown) => PluginRegistry | undefined>(
    () => undefined,
  ),
  loadPluginManifestRegistry: vi.fn<(params?: Record<string, unknown>) => MockManifestRegistry>(
    () => createEmptyMockManifestRegistry(),
  ),
  loadPluginRegistrySnapshot: vi.fn<(_params?: unknown) => MockPluginIndex>(() =>
    createMockPluginIndex([]),
  ),
  loadPluginRegistrySnapshotWithMetadata: vi.fn((params?: MockPluginSnapshotLoadParams) => ({
    source: params?.index ? "provided" : "derived",
    snapshot: params?.index ?? createMockPluginIndex([]),
    diagnostics: [],
  })),
  loadPluginRegistryHandle: vi.fn(),
  listBundledPluginMetadata: vi.fn(() => []),
}));

vi.mock("./loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./loader.js")>()),
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
  loadPluginRegistryHandle: mocks.loadPluginRegistryHandle,
}));

vi.mock("./active-runtime-registry.js", () => ({
  getLoadedRuntimePluginRegistry: (params?: { requiredPluginIds?: string[] }) => {
    if (params === undefined) {
      return mocks.resolveRuntimePluginRegistry();
    }
    return mocks.resolveRuntimePluginRegistry({
      onlyPluginIds: params.requiredPluginIds,
    });
  },
}));

vi.mock("./plugin-registry-snapshot.js", () => ({
  loadPluginRegistrySnapshot: mocks.loadPluginRegistrySnapshot,
  loadPluginRegistrySnapshotWithMetadata: mocks.loadPluginRegistrySnapshotWithMetadata,
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (params: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv }) => {
    const loaded = mocks.loadPluginRegistrySnapshotWithMetadata(params);
    const manifestRegistry = mocks.loadPluginManifestRegistry({
      index: loaded.snapshot,
      config: params.config,
      env: params.env,
      includeDisabled: true,
    });
    return {
      index: loaded.snapshot,
      plugins: manifestRegistry.plugins,
    };
  },
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: mocks.loadPluginManifestRegistry,
  resolveInstalledManifestRegistryIndexFingerprint: () => "test-installed-index",
}));

vi.mock("./bundled-plugin-metadata.js", () => ({
  listBundledPluginMetadata: mocks.listBundledPluginMetadata,
}));

let ensureStandaloneMigrationProviderRegistryLoaded: typeof import("./migration-provider-runtime.js").ensureStandaloneMigrationProviderRegistryLoaded;
let resolvePluginMigrationProvider: typeof import("./migration-provider-runtime.js").resolvePluginMigrationProvider;
let resolvePluginMigrationProviders: typeof import("./migration-provider-runtime.js").resolvePluginMigrationProviders;

function createMigrationProvider(id: string) {
  return {
    id,
    label: id,
    plan: vi.fn(),
    apply: vi.fn(),
  };
}

function requireMockCallArg(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
  index = 0,
): Record<string, unknown> {
  const arg = mockFn.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return arg;
}

describe("migration provider runtime", () => {
  beforeEach(async () => {
    clearPluginMetadataLifecycleCaches();
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(createEmptyPluginRegistry());
    mocks.loadPluginManifestRegistry.mockReturnValue(createEmptyMockManifestRegistry());
    mocks.loadPluginRegistrySnapshot.mockReturnValue(createMockPluginIndex([]));
    mocks.loadPluginRegistryHandle.mockReturnValue(createEmptyPluginRegistry());
    mocks.listBundledPluginMetadata.mockReturnValue([]);
    mocks.loadPluginRegistrySnapshotWithMetadata.mockImplementation(
      (params?: MockPluginSnapshotLoadParams) => ({
        source: params?.index ? "provided" : "derived",
        snapshot: params?.index ?? mocks.loadPluginRegistrySnapshot(),
        diagnostics: [],
      }),
    );
    const runtime = await import("./migration-provider-runtime.js");
    ensureStandaloneMigrationProviderRegistryLoaded =
      runtime.ensureStandaloneMigrationProviderRegistryLoaded;
    resolvePluginMigrationProvider = runtime.resolvePluginMigrationProvider;
    resolvePluginMigrationProviders = runtime.resolvePluginMigrationProviders;
  });

  it("standalone-loads bundled migration providers through compat config", () => {
    mocks.loadPluginRegistrySnapshot.mockReturnValue(
      createMockPluginIndex([
        {
          pluginId: "migrate-hermes",
          origin: "bundled",
          enabled: true,
        },
      ]),
    );
    mocks.loadPluginManifestRegistry.mockImplementation(() => ({
      diagnostics: [],
      plugins: [
        {
          id: "migrate-hermes",
          origin: "bundled",
          contracts: { migrationProviders: ["hermes"] },
        },
      ],
    }));

    ensureStandaloneMigrationProviderRegistryLoaded({
      cfg: { plugins: { enabled: false } } as OpenClawConfig,
    });

    const standaloneParams = requireMockCallArg(
      mocks.loadPluginRegistryHandle,
      "loadPluginRegistryHandle",
    ) as {
      activate?: unknown;
      onlyPluginIds?: unknown;
      config?: OpenClawConfig;
    };
    expect(standaloneParams.activate).toBe(false);
    expect(standaloneParams.onlyPluginIds).toEqual(["migrate-hermes"]);
    expect(standaloneParams.config?.plugins?.enabled).toBe(true);
    expect(standaloneParams.config?.plugins?.entries).toEqual({
      "migrate-hermes": { enabled: true },
    });
  });

  it("discovers bundled migration contracts missing from a pruned persisted index", () => {
    mocks.listBundledPluginMetadata.mockReturnValue([
      {
        manifest: {
          id: "migrate-hermes",
          contracts: { migrationProviders: ["hermes"] },
        },
      },
    ] as never);

    ensureStandaloneMigrationProviderRegistryLoaded({ providerId: "hermes" });

    const standaloneParams = requireMockCallArg(
      mocks.loadPluginRegistryHandle,
      "loadPluginRegistryHandle",
    );
    expect(standaloneParams.onlyPluginIds).toEqual(["migrate-hermes"]);
  });

  it("loads configured external migration-provider plugins from manifest contracts", async () => {
    const cfg = {
      plugins: {
        entries: {
          "external-migration": { enabled: true },
          "disabled-external-migration": { enabled: false },
        },
      },
    } as OpenClawConfig;
    const provider = createMigrationProvider("external-import");
    const active = createEmptyPluginRegistry();
    const loaded = createEmptyPluginRegistry();
    loaded.migrationProviders.push({
      pluginId: "external-migration",
      pluginName: "External Migration",
      source: "test",
      provider,
    } as never);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );
    mocks.loadPluginRegistrySnapshot.mockReturnValue(
      createMockPluginIndex([
        {
          pluginId: "external-migration",
          origin: "installed",
          enabled: true,
        },
        {
          pluginId: "disabled-external-migration",
          origin: "installed",
          enabled: false,
        },
      ]),
    );
    mocks.loadPluginManifestRegistry.mockImplementation((params?: Record<string, unknown>) => ({
      diagnostics: [],
      plugins: params?.includeDisabled
        ? [
            {
              id: "external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
            {
              id: "disabled-external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
          ]
        : [
            {
              id: "external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
          ],
    }));

    const resolved = resolvePluginMigrationProvider({ providerId: "external-import", cfg });

    expect(resolved).not.toBe(provider);
    provider.plan.mockImplementationOnce(() => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(loaded);
      return {} as never;
    });
    await resolved?.plan({} as never);
    expect(mocks.loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
    });
    const manifestParams = requireMockCallArg(
      mocks.loadPluginManifestRegistry,
      "loadPluginManifestRegistry",
    ) as {
      index?: MockPluginIndex;
      config?: OpenClawConfig;
      env?: NodeJS.ProcessEnv;
      includeDisabled?: unknown;
    };
    expect(manifestParams.index?.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "external-migration",
      "disabled-external-migration",
    ]);
    expect(manifestParams.config).toBe(cfg);
    expect(manifestParams.env).toBe(process.env);
    expect(manifestParams.includeDisabled).toBe(true);
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenNthCalledWith(1);
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      onlyPluginIds: ["external-migration"],
    });
  });

  it("discovers newly bundled migration providers from current metadata", () => {
    const provider = createMigrationProvider("hermes");
    const active = createEmptyPluginRegistry();
    const loaded = createEmptyPluginRegistry();
    loaded.migrationProviders.push({
      pluginId: "migrate-hermes",
      pluginName: "Hermes Migration",
      source: "test",
      provider,
    } as never);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );
    mocks.listBundledPluginMetadata.mockReturnValue([
      {
        manifest: {
          id: "migrate-hermes",
          contracts: { migrationProviders: ["hermes"] },
        },
      },
    ] as never);

    const resolved = resolvePluginMigrationProvider({ providerId: "hermes" });

    expect(resolved).not.toBe(provider);
    expect(mocks.listBundledPluginMetadata).toHaveBeenCalledWith({
      includeChannelConfigs: false,
    });
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      onlyPluginIds: ["migrate-hermes"],
    });
  });

  it.each(["owner", "retired"])(
    "does not reuse a standalone handle after %s changes",
    async (change) => {
      mocks.resolveRuntimePluginRegistry.mockReturnValue(undefined);
      const cfgA = { plugins: { allow: ["migration-a"] } } as OpenClawConfig;
      const cfgB = { plugins: { allow: ["migration-b"] } } as OpenClawConfig;
      const provider = createMigrationProvider("shared-import");
      const loadedA = createEmptyPluginRegistry();
      loadedA.migrationProviders.push({
        pluginId: "migration-a",
        pluginName: "Migration A",
        source: "test",
        provider,
      } as never);
      mocks.loadPluginRegistryHandle.mockReturnValue(loadedA);
      mocks.listBundledPluginMetadata.mockReturnValue([
        {
          manifest: {
            id: "migration-a",
            contracts: { migrationProviders: ["shared-import"] },
          },
        },
      ] as never);

      ensureStandaloneMigrationProviderRegistryLoaded({
        cfg: cfgA,
        providerId: "shared-import",
      });
      expect(
        resolvePluginMigrationProvider({ providerId: "shared-import", cfg: cfgA }),
      ).toBeDefined();
      if (change === "retired") {
        const { markPluginRegistryRetired } = await import("./registry-lifecycle.js");
        markPluginRegistryRetired(loadedA);
        expect(
          resolvePluginMigrationProvider({ providerId: "shared-import", cfg: cfgA }),
        ).toBeUndefined();
        expect(resolvePluginMigrationProviders({ cfg: cfgA })).toEqual([]);
        return;
      }
      mocks.listBundledPluginMetadata.mockReturnValue([
        {
          manifest: {
            id: "migration-b",
            contracts: { migrationProviders: ["shared-import"] },
          },
        },
      ] as never);

      expect(
        resolvePluginMigrationProvider({ providerId: "shared-import", cfg: cfgB }),
      ).toBeUndefined();
    },
  );

  it("lists configured external migration providers alongside active providers", () => {
    const activeProvider = createMigrationProvider("active-import");
    const externalProvider = createMigrationProvider("external-import");
    const active = createEmptyPluginRegistry();
    active.migrationProviders.push({
      pluginId: "active-migration",
      pluginName: "Active Migration",
      source: "test",
      provider: activeProvider,
    } as never);
    const loaded = createEmptyPluginRegistry();
    loaded.migrationProviders.push({
      pluginId: "external-migration",
      pluginName: "External Migration",
      source: "test",
      provider: externalProvider,
    } as never);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );
    mocks.loadPluginRegistrySnapshot.mockReturnValue(
      createMockPluginIndex([
        {
          pluginId: "external-migration",
          origin: "installed",
          enabled: true,
        },
      ]),
    );
    mocks.loadPluginManifestRegistry.mockImplementation((params?: Record<string, unknown>) => ({
      diagnostics: [],
      plugins: params?.includeDisabled
        ? [
            {
              id: "external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
          ]
        : [
            {
              id: "external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
          ],
    }));

    expect(resolvePluginMigrationProviders().map((provider) => provider.id)).toEqual([
      "active-import",
      "external-import",
    ]);
  });
});
