import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";

const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn((params: { config: unknown }) => ({
    config: params.config,
    changes: [] as string[],
    autoEnabledReasons: {} as Record<string, string[]>,
  })),
);
const initSubagentRegistry = vi.hoisted(() => vi.fn());
const loadGatewayStartupPlugins = vi.hoisted(() =>
  vi.fn((_params: unknown) => ({
    pluginRegistry: { diagnostics: [], gatewayHandlers: {}, plugins: [] },
    gatewayMethods: ["ping"],
  })),
);
const prepareBundledPluginRuntimeLoadRoot = vi.hoisted(() => vi.fn((params: unknown) => params));
const registerBundledRuntimeDependencyJitiAliases = vi.hoisted(() => vi.fn());
const isSourceCheckoutRoot = vi.hoisted(() => vi.fn((_packageRoot: string) => false));
const pruneUnknownBundledRuntimeDepsRoots = vi.hoisted(() =>
  vi.fn((_params: unknown) => ({ scanned: 0, removed: 0, skippedLocked: 0 })),
);
const repairBundledRuntimeDepsPackagePlanAsync = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => ({ repairedSpecs: ["grammy@1.37.0"] })),
);
const pluginManifestRegistry = vi.hoisted(
  (): PluginManifestRegistry => ({
    plugins: [
      {
        id: "telegram",
        origin: "bundled",
        rootDir: "/package/dist/extensions/telegram",
        source: "/package/dist/extensions/telegram/index.js",
        manifestPath: "/package/dist/extensions/telegram/package.json",
        channels: ["telegram"],
        providers: [],
        cliBackends: [],
        skills: [],
        hooks: [],
      },
    ],
    diagnostics: [],
  }),
);
const pluginMetadataSnapshot = vi.hoisted(
  (): PluginMetadataSnapshot => ({
    policyHash: "policy",
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "policy",
      generatedAtMs: 0,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: pluginManifestRegistry,
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
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
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
  }),
);
const pluginLookUpTableMetrics = vi.hoisted(() => ({
  registrySnapshotMs: 0,
  manifestRegistryMs: 0,
  startupPlanMs: 0,
  ownerMapsMs: 0,
  totalMs: 0,
  indexPluginCount: 0,
  manifestPluginCount: 0,
  startupPluginCount: 1,
  deferredChannelPluginCount: 0,
}));
const loadPluginLookUpTable = vi.hoisted(() =>
  vi.fn((_params: unknown) => ({
    manifestRegistry: pluginManifestRegistry,
    startup: {
      configuredDeferredChannelPluginIds: [],
      pluginIds: ["telegram"],
    },
    metrics: pluginLookUpTableMetrics,
  })),
);
const resolveOpenClawPackageRootSync = vi.hoisted(() => vi.fn((_params: unknown) => "/package"));
const runChannelPluginStartupMaintenance = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => undefined),
);
const runStartupSessionMigration = vi.hoisted(() => vi.fn(async (_params: unknown) => undefined));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/workspace",
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../agents/subagent-registry.js", () => ({
  initSubagentRegistry: () => initSubagentRegistry(),
}));

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance: (params: unknown) =>
    runChannelPluginStartupMaintenance(params),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (params: { config: unknown }) => applyPluginAutoEnable(params),
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: (params: unknown) => resolveOpenClawPackageRootSync(params),
}));

vi.mock("../plugins/bundled-runtime-deps.js", () => ({
  repairBundledRuntimeDepsPackagePlanAsync: (params: unknown) =>
    repairBundledRuntimeDepsPackagePlanAsync(params),
}));

vi.mock("../plugins/bundled-runtime-deps-roots.js", () => ({
  isSourceCheckoutRoot: (packageRoot: string) => isSourceCheckoutRoot(packageRoot),
  pruneUnknownBundledRuntimeDepsRoots: (params: unknown) =>
    pruneUnknownBundledRuntimeDepsRoots(params),
}));

vi.mock("../plugins/bundled-runtime-deps-jiti-aliases.js", () => ({
  registerBundledRuntimeDependencyJitiAliases: (rootDir: string) =>
    registerBundledRuntimeDependencyJitiAliases(rootDir),
}));

vi.mock("../plugins/bundled-runtime-root.js", () => ({
  prepareBundledPluginRuntimeLoadRoot: (params: unknown) =>
    prepareBundledPluginRuntimeLoadRoot(params),
}));

vi.mock("../plugins/plugin-lookup-table.js", () => ({
  loadPluginLookUpTable: (params: unknown) => loadPluginLookUpTable(params),
}));

vi.mock("../plugins/registry.js", () => ({
  createEmptyPluginRegistry: () => ({ diagnostics: [], gatewayHandlers: {}, plugins: [] }),
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => undefined,
  setActivePluginRegistry: vi.fn(),
}));

vi.mock("./server-methods-list.js", () => ({
  listGatewayMethods: () => ["ping"],
}));

vi.mock("./server-methods.js", () => ({
  coreGatewayHandlers: {},
}));

vi.mock("./server-plugin-bootstrap.js", () => ({
  loadGatewayStartupPlugins: (params: unknown) => loadGatewayStartupPlugins(params),
}));

vi.mock("./server-startup-session-migration.js", () => ({
  runStartupSessionMigration: (params: unknown) => runStartupSessionMigration(params),
}));

function createLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("prepareGatewayPluginBootstrap runtime-deps staging", () => {
  beforeEach(() => {
    applyPluginAutoEnable.mockClear();
    initSubagentRegistry.mockClear();
    loadGatewayStartupPlugins.mockClear();
    prepareBundledPluginRuntimeLoadRoot.mockReset().mockImplementation((params: unknown) => params);
    registerBundledRuntimeDependencyJitiAliases.mockClear();
    isSourceCheckoutRoot.mockClear().mockReturnValue(false);
    pruneUnknownBundledRuntimeDepsRoots.mockClear().mockReturnValue({
      scanned: 0,
      removed: 0,
      skippedLocked: 0,
    });
    repairBundledRuntimeDepsPackagePlanAsync.mockReset().mockResolvedValue({
      repairedSpecs: ["grammy@1.37.0"],
    });
    loadPluginLookUpTable.mockClear().mockReturnValue({
      manifestRegistry: pluginManifestRegistry,
      startup: {
        configuredDeferredChannelPluginIds: [],
        pluginIds: ["telegram"],
      },
      metrics: pluginLookUpTableMetrics,
    });
    resolveOpenClawPackageRootSync.mockClear().mockReturnValue("/package");
    runChannelPluginStartupMaintenance.mockClear();
    runStartupSessionMigration.mockClear();
  });

  it("loads startup plugins in verify-only mode after failed pre-start staging", async () => {
    repairBundledRuntimeDepsPackagePlanAsync.mockRejectedValueOnce(new Error("offline registry"));
    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await expect(
      prepareGatewayPluginBootstrap({
        cfgAtStart: {},
        startupRuntimeConfig: {},
        minimalTestGateway: false,
        log,
      }),
    ).resolves.toMatchObject({
      baseGatewayMethods: ["ping"],
      startupPluginIds: ["telegram"],
      pluginLookUpTable: expect.objectContaining({
        manifestRegistry: pluginManifestRegistry,
      }),
    });

    expect(loadGatewayStartupPlugins).toHaveBeenCalledOnce();
    expect(loadPluginLookUpTable).toHaveBeenCalledOnce();
    expect(loadGatewayStartupPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginLookUpTable: expect.objectContaining({
          manifestRegistry: pluginManifestRegistry,
        }),
        installBundledRuntimeDeps: false,
      }),
    );
    expect(repairBundledRuntimeDepsPackagePlanAsync).toHaveBeenCalledOnce();
    expect(prepareBundledPluginRuntimeLoadRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "telegram",
        installMissingDeps: false,
        previousRepairError: expect.any(Error),
      }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("plugin load will verify without synchronous repair"),
    );
    expect(loadGatewayStartupPlugins.mock.calls[0]?.[0]).not.toHaveProperty(
      "bundledRuntimeDepsInstaller",
    );
    expect(loadGatewayStartupPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        bundledRuntimeDepsRepairError: expect.any(Error),
      }),
    );
  });

  it("prepares the full startup plugin runtime set", async () => {
    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await prepareGatewayPluginBootstrap({
      cfgAtStart: {},
      startupRuntimeConfig: {},
      minimalTestGateway: false,
      log,
    });

    expect(repairBundledRuntimeDepsPackagePlanAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        packageRoot: "/package",
        exactPluginIds: ["telegram"],
      }),
    );
    expect(prepareBundledPluginRuntimeLoadRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "telegram",
        pluginRoot: "/package/dist/extensions/telegram",
        modulePath: "/package/dist/extensions/telegram/index.js",
        installMissingDeps: false,
        memoizePreparedRoot: true,
      }),
    );
    expect(loadGatewayStartupPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ installBundledRuntimeDeps: false }),
    );
  });

  it("allows the loader to verify already staged deps during warm gateway starts", async () => {
    repairBundledRuntimeDepsPackagePlanAsync.mockResolvedValueOnce({
      repairedSpecs: [],
    });
    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await prepareGatewayPluginBootstrap({
      cfgAtStart: {},
      startupRuntimeConfig: {},
      minimalTestGateway: false,
      log,
    });

    expect(repairBundledRuntimeDepsPackagePlanAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        packageRoot: "/package",
        exactPluginIds: ["telegram"],
      }),
    );
    expect(loadGatewayStartupPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ installBundledRuntimeDeps: false }),
    );
  });

  it("repairs source-checkout startup plugin deps before verify-only load", async () => {
    repairBundledRuntimeDepsPackagePlanAsync.mockResolvedValueOnce({
      repairedSpecs: [],
    });
    isSourceCheckoutRoot.mockReturnValueOnce(true);
    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await prepareGatewayPluginBootstrap({
      cfgAtStart: {},
      startupRuntimeConfig: {},
      minimalTestGateway: false,
      log,
    });

    expect(isSourceCheckoutRoot).toHaveBeenCalledWith("/package");
    expect(prepareBundledPluginRuntimeLoadRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "telegram",
        installMissingDeps: true,
        memoizePreparedRoot: true,
        logInstalled: expect.any(Function),
      }),
    );
    expect(loadGatewayStartupPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ installBundledRuntimeDeps: false }),
    );
  });

  it("can defer runtime-deps staging and startup plugin loading until after HTTP bind", async () => {
    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await expect(
      prepareGatewayPluginBootstrap({
        cfgAtStart: {},
        startupRuntimeConfig: {},
        minimalTestGateway: false,
        log,
        loadRuntimePlugins: false,
      }),
    ).resolves.toMatchObject({
      baseGatewayMethods: ["ping"],
      startupPluginIds: ["telegram"],
      runtimePluginsLoaded: false,
    });

    expect(loadPluginLookUpTable).toHaveBeenCalledOnce();
    expect(repairBundledRuntimeDepsPackagePlanAsync).not.toHaveBeenCalled();
    expect(prepareBundledPluginRuntimeLoadRoot).not.toHaveBeenCalled();
    expect(loadGatewayStartupPlugins).not.toHaveBeenCalled();
  });

  it("derives startup activation from source config instead of runtime plugin defaults", async () => {
    const sourceConfig = {
      channels: {
        telegram: {
          botToken: "token",
        },
      },
      plugins: {
        allow: ["bench-plugin"],
      },
    } as OpenClawConfig;
    const activationConfig = {
      channels: {
        telegram: {
          botToken: "token",
          enabled: true,
        },
      },
      plugins: {
        allow: ["bench-plugin"],
        entries: {
          "bench-plugin": {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      channels: {
        telegram: {
          botToken: "token",
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
        },
      },
      plugins: {
        allow: ["bench-plugin", "memory-core"],
        entries: {
          "bench-plugin": {
            config: {
              runtimeDefault: true,
            },
          },
          "memory-core": {
            config: {
              dreaming: {
                enabled: false,
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    applyPluginAutoEnable.mockReturnValueOnce({
      config: activationConfig,
      changes: [],
      autoEnabledReasons: {},
    });
    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await prepareGatewayPluginBootstrap({
      cfgAtStart: runtimeConfig,
      activationSourceConfig: sourceConfig,
      startupRuntimeConfig: runtimeConfig,
      pluginMetadataSnapshot,
      minimalTestGateway: false,
      log,
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: sourceConfig,
      env: process.env,
      manifestRegistry: pluginManifestRegistry,
    });
    expect(loadPluginLookUpTable).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: sourceConfig,
        metadataSnapshot: pluginMetadataSnapshot,
        config: expect.objectContaining({
          channels: expect.objectContaining({
            telegram: expect.objectContaining({
              enabled: true,
              dmPolicy: "pairing",
              groupPolicy: "allowlist",
            }),
          }),
          plugins: expect.objectContaining({
            allow: ["bench-plugin"],
            entries: expect.objectContaining({
              "bench-plugin": expect.objectContaining({
                enabled: true,
                config: {
                  runtimeDefault: true,
                },
              }),
              "memory-core": {
                config: {
                  dreaming: {
                    enabled: false,
                  },
                },
              },
            }),
          }),
        }),
      }),
    );
    expect(loadGatewayStartupPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: sourceConfig,
        cfg: expect.objectContaining({
          channels: expect.objectContaining({
            telegram: expect.objectContaining({
              enabled: true,
              dmPolicy: "pairing",
              groupPolicy: "allowlist",
            }),
          }),
          plugins: expect.objectContaining({
            allow: ["bench-plugin"],
            entries: expect.objectContaining({
              "bench-plugin": expect.objectContaining({
                enabled: true,
                config: {
                  runtimeDefault: true,
                },
              }),
              "memory-core": {
                config: {
                  dreaming: {
                    enabled: false,
                  },
                },
              },
            }),
          }),
        }),
      }),
    );
  });

  it("keeps startup plugin loading verify-only after failed pre-start scan", async () => {
    repairBundledRuntimeDepsPackagePlanAsync.mockRejectedValueOnce(
      new Error("unsupported runtime dependency spec"),
    );
    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await expect(
      prepareGatewayPluginBootstrap({
        cfgAtStart: {},
        startupRuntimeConfig: {},
        minimalTestGateway: false,
        log,
      }),
    ).resolves.toMatchObject({
      baseGatewayMethods: ["ping"],
      startupPluginIds: ["telegram"],
      pluginLookUpTable: expect.objectContaining({
        manifestRegistry: pluginManifestRegistry,
      }),
    });

    expect(loadGatewayStartupPlugins).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("unsupported runtime dependency spec"),
    );
    expect(loadGatewayStartupPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ installBundledRuntimeDeps: false }),
    );
    expect(loadGatewayStartupPlugins.mock.calls[0]?.[0]).not.toHaveProperty(
      "bundledRuntimeDepsInstaller",
    );
  });

  it("bypasses plugin lookup and runtime-deps staging when plugins are globally disabled", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "token",
        },
      },
      plugins: {
        enabled: false,
        allow: ["telegram"],
        entries: {
          telegram: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await expect(
      prepareGatewayPluginBootstrap({
        cfgAtStart: cfg,
        startupRuntimeConfig: cfg,
        minimalTestGateway: false,
        log,
      }),
    ).resolves.toMatchObject({
      startupPluginIds: [],
      deferredConfiguredChannelPluginIds: [],
      pluginLookUpTable: undefined,
      baseGatewayMethods: ["ping"],
    });

    expect(loadPluginLookUpTable).not.toHaveBeenCalled();
    expect(prepareBundledPluginRuntimeLoadRoot).not.toHaveBeenCalled();
    expect(loadGatewayStartupPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        pluginIds: [],
        pluginLookUpTable: undefined,
        preferSetupRuntimeForChannelPlugins: false,
        suppressPluginInfoLogs: false,
      }),
    );
  });
});
