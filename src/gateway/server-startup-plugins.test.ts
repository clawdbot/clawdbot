import { beforeEach, describe, expect, it, vi } from "vitest";

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
const repairBundledRuntimeDepsInstallRootAsync = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => ({})),
);
const resolveBundledRuntimeDependencyPackageInstallRoot = vi.hoisted(() =>
  vi.fn((_packageRoot: string, _params: unknown) => "/runtime"),
);
const pluginManifestRegistry = vi.hoisted(() => ({ plugins: [], diagnostics: [] }));
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
const scanBundledPluginRuntimeDeps = vi.hoisted(() =>
  vi.fn((_params: unknown) => ({
    deps: [{ name: "grammy", version: "1.37.0", pluginIds: ["telegram"] }],
    missing: [{ name: "grammy", version: "1.37.0", pluginIds: ["telegram"] }],
    conflicts: [],
  })),
);

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
  repairBundledRuntimeDepsInstallRootAsync: (params: unknown) =>
    repairBundledRuntimeDepsInstallRootAsync(params),
  resolveBundledRuntimeDependencyPackageInstallRoot: (packageRoot: string, params: unknown) =>
    resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot, params),
  scanBundledPluginRuntimeDeps: (params: unknown) => scanBundledPluginRuntimeDeps(params),
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
    repairBundledRuntimeDepsInstallRootAsync.mockReset().mockResolvedValue({});
    resolveBundledRuntimeDependencyPackageInstallRoot.mockClear();
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
    scanBundledPluginRuntimeDeps.mockClear().mockReturnValue({
      deps: [{ name: "grammy", version: "1.37.0", pluginIds: ["telegram"] }],
      missing: [{ name: "grammy", version: "1.37.0", pluginIds: ["telegram"] }],
      conflicts: [],
    });
  });

  it("falls back to per-plugin runtime-deps installs after failed pre-start staging", async () => {
    const installError = new Error("offline registry");
    repairBundledRuntimeDepsInstallRootAsync.mockRejectedValueOnce(installError);
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
      }),
    );
    expect(scanBundledPluginRuntimeDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedPluginIds: ["telegram"],
      }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "gateway startup will continue with per-plugin runtime-deps installs",
      ),
    );
    expect(loadGatewayStartupPlugins.mock.calls[0]?.[0]).not.toHaveProperty(
      "bundledRuntimeDepsInstaller",
    );
  });

  it("falls back to per-plugin runtime-deps installs after failed pre-start scan", async () => {
    scanBundledPluginRuntimeDeps.mockImplementationOnce(() => {
      throw new Error("unsupported runtime dependency spec");
    });
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

    expect(repairBundledRuntimeDepsInstallRootAsync).not.toHaveBeenCalled();
    expect(loadGatewayStartupPlugins).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "failed to scan bundled runtime deps before gateway startup; gateway startup will continue with per-plugin runtime-deps installs",
      ),
    );
    expect(loadGatewayStartupPlugins.mock.calls[0]?.[0]).not.toHaveProperty(
      "bundledRuntimeDepsInstaller",
    );
  });
});
