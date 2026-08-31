/**
 * Gateway startup plugin bootstrap tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import "./server-startup-bootstrap.test-support.js";

const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn((params: { config: unknown }) => ({
    config: params.config,
    changes: [] as string[],
    autoEnabledReasons: {} as Record<string, string[]>,
  })),
);
const initSubagentRegistry = vi.hoisted(() => vi.fn());
const getActivePluginRegistry = vi.hoisted(() => vi.fn<() => PluginRegistry | undefined>());
const setActivePluginRegistry = vi.hoisted(() => vi.fn());
const loadGatewayStartupPlugins = vi.hoisted(() =>
  vi.fn((_params: unknown) => ({
    pluginRegistry: { diagnostics: [], gatewayHandlers: {}, plugins: [] },
    gatewayMethods: ["ping"],
  })),
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
const pluginMetadataSnapshot = vi.hoisted((): PluginMetadataSnapshot => {
  const index: PluginMetadataSnapshot["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "policy",
    generatedAtMs: 0,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  };
  return {
    policyHash: "policy",
    index,
    registryIndex: index,
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
  };
});
const pluginLookUpTableMetrics = vi.hoisted(() => ({
  registrySnapshotMs: 0,
  manifestRegistryMs: 0,
  startupPlanMs: 0,
  ownerMapsMs: 0,
  totalMs: 0,
  indexPluginCount: 0,
  manifestPluginCount: 0,
  startupPluginCount: 1,
}));
const loadPluginLookUpTable = vi.hoisted(() =>
  vi.fn((_params: unknown) => ({
    manifestRegistry: pluginManifestRegistry,
    startup: {
      pluginIds: ["telegram"] as string[],
      channelPluginIds: ["telegram"] as string[],
    },
    metrics: pluginLookUpTableMetrics,
  })),
);
const resolveOpenClawPackageRootSync = vi.hoisted(() => vi.fn((_params: unknown) => "/package"));
const runChannelPluginStartupMaintenance = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => undefined),
);
const listAmbientOnlyConfiguredChannelIds = vi.hoisted(() =>
  vi.fn((_params: unknown) => [] as string[]),
);
const runStartupSessionMigration = vi.hoisted(() => vi.fn(async (_params: unknown) => undefined));
const migrateLegacyDevicePairingStore = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => undefined),
);
const migrateLegacyNodePairingStore = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => undefined),
);
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/workspace",
  resolveDefaultAgentId: () => "default",
  tryResolveConfiguredAgentWorkspaceDir: () => "/workspace",
  tryResolveSystemAgentWorkspaceDir: () => "/workspace",
}));

vi.mock("../agents/workspace-state-dirs.js", () => ({
  assertConfiguredWorkspaceStateReady: () => {},
}));

vi.mock("../agents/subagents/registry/subagent-registry.js", () => ({
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

vi.mock("../infra/device-pairing-migration.js", () => ({
  migrateLegacyDevicePairingStore: (params: unknown) => migrateLegacyDevicePairingStore(params),
}));

vi.mock("../infra/node-pairing-migration.js", () => ({
  migrateLegacyNodePairingStore: (params: unknown) => migrateLegacyNodePairingStore(params),
}));

vi.mock("../plugins/channel-presence-policy.js", () => ({
  listAmbientOnlyConfiguredChannelIds: (params: unknown) =>
    listAmbientOnlyConfiguredChannelIds(params),
}));

vi.mock("../plugins/plugin-lookup-table.js", () => ({
  loadPluginLookUpTable: (params: unknown) => loadPluginLookUpTable(params),
}));

vi.mock("../plugins/registry.js", () => import("../plugins/registry-empty.js"));

vi.mock("../plugins/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/runtime.js")>()),
  getActivePluginRegistry,
  setActivePluginRegistry,
}));

vi.mock("./server-methods-list.js", () => ({
  listGatewayMethods: () => ["ping"],
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

function firstCallArg<T>(mock: { mock: { calls: unknown[][] } }, _type?: (value: T) => T): T {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected first mock call");
  }
  return call[0] as T;
}

function slackConfig(): OpenClawConfig {
  return {
    channels: {
      slack: { enabled: true, token: "token" },
    },
  } as OpenClawConfig;
}

async function prepareBootstrapWithRuntimeConfig(
  cfg: OpenClawConfig,
  options: {
    minimalTestGateway?: boolean;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    workerProviderIds?: readonly string[];
  } = {},
) {
  const log = createLog();
  const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

  return await prepareGatewayPluginBootstrap({
    cfgAtStart: cfg,
    minimalTestGateway: false,
    log,
    ...options,
  });
}

describe("runGatewayStartupMaintenance", () => {
  beforeEach(() => {
    runChannelPluginStartupMaintenance.mockClear();
    runStartupSessionMigration.mockClear();
    migrateLegacyDevicePairingStore.mockClear();
    migrateLegacyNodePairingStore.mockClear();
  });

  it("runs channel, session, and ordered pairing maintenance for a normal gateway", async () => {
    const log = createLog();
    const { runGatewayStartupMaintenance } = await import("./server-startup-plugins.js");

    await runGatewayStartupMaintenance({
      cfgAtStart: {},
      startupRuntimeConfig: {},
      minimalTestGateway: false,
      log,
    });

    expect(runChannelPluginStartupMaintenance).toHaveBeenCalledWith({
      cfg: {},
      env: process.env,
      log,
    });
    expect(runStartupSessionMigration).toHaveBeenCalledWith({
      cfg: {},
      env: process.env,
      log,
    });
    expect(migrateLegacyDevicePairingStore).toHaveBeenCalledWith({ log });
    expect(migrateLegacyNodePairingStore).toHaveBeenCalledWith({ log });
    const deviceMigrationOrder = migrateLegacyDevicePairingStore.mock.invocationCallOrder[0];
    const nodeMigrationOrder = migrateLegacyNodePairingStore.mock.invocationCallOrder[0];
    expect(deviceMigrationOrder).toBeDefined();
    expect(nodeMigrationOrder).toBeDefined();
    expect(deviceMigrationOrder!).toBeLessThan(nodeMigrationOrder!);
  });

  it("skips maintenance for a minimal gateway without channel config", async () => {
    const { runGatewayStartupMaintenance } = await import("./server-startup-plugins.js");

    await runGatewayStartupMaintenance({
      cfgAtStart: {},
      startupRuntimeConfig: {},
      minimalTestGateway: true,
      log: createLog(),
    });

    expect(runChannelPluginStartupMaintenance).not.toHaveBeenCalled();
    expect(runStartupSessionMigration).not.toHaveBeenCalled();
    expect(migrateLegacyDevicePairingStore).not.toHaveBeenCalled();
    expect(migrateLegacyNodePairingStore).not.toHaveBeenCalled();
  });

  it("runs only channel maintenance for a minimal gateway with recovered channel config", async () => {
    const log = createLog();
    const recoveredConfig = slackConfig();
    const { runGatewayStartupMaintenance } = await import("./server-startup-plugins.js");

    await runGatewayStartupMaintenance({
      cfgAtStart: {},
      startupRuntimeConfig: recoveredConfig,
      minimalTestGateway: true,
      log,
    });

    expect(runChannelPluginStartupMaintenance).toHaveBeenCalledWith({
      cfg: recoveredConfig,
      env: process.env,
      log,
    });
    expect(runStartupSessionMigration).not.toHaveBeenCalled();
    expect(migrateLegacyDevicePairingStore).not.toHaveBeenCalled();
    expect(migrateLegacyNodePairingStore).not.toHaveBeenCalled();
  });
});

describe("prepareGatewayPluginBootstrap startup plugins", () => {
  beforeEach(() => {
    getActivePluginRegistry.mockReset();
    setActivePluginRegistry.mockClear();
    applyPluginAutoEnable.mockClear();
    initSubagentRegistry.mockClear();
    loadGatewayStartupPlugins.mockClear();
    listAmbientOnlyConfiguredChannelIds.mockClear().mockReturnValue([]);
    loadPluginLookUpTable.mockClear().mockReturnValue({
      manifestRegistry: pluginManifestRegistry,
      startup: {
        pluginIds: ["telegram"] as string[],
        channelPluginIds: ["telegram"] as string[],
      },
      metrics: pluginLookUpTableMetrics,
    });
    resolveOpenClawPackageRootSync.mockClear().mockReturnValue("/package");
    runChannelPluginStartupMaintenance.mockClear();
    runStartupSessionMigration.mockClear();
    migrateLegacyDevicePairingStore.mockClear();
    migrateLegacyNodePairingStore.mockClear();
  });
  it("does not run startup maintenance", async () => {
    await prepareBootstrapWithRuntimeConfig({});

    expect(runChannelPluginStartupMaintenance).not.toHaveBeenCalled();
    expect(runStartupSessionMigration).not.toHaveBeenCalled();
    expect(migrateLegacyDevicePairingStore).not.toHaveBeenCalled();
    expect(migrateLegacyNodePairingStore).not.toHaveBeenCalled();
  });

  it("hydrates the subagent registry before plugin bootstrap", async () => {
    await prepareBootstrapWithRuntimeConfig({});

    expect(initSubagentRegistry).toHaveBeenCalledOnce();
    expect(initSubagentRegistry.mock.invocationCallOrder[0]).toBeLessThan(
      loadPluginLookUpTable.mock.invocationCallOrder[0]!,
    );
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
      pluginMetadataSnapshot,
      minimalTestGateway: false,
      log,
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: sourceConfig,
      env: process.env,
      manifestRegistry: pluginManifestRegistry,
    });
    const lookupInput = firstCallArg<{
      activationSourceConfig?: OpenClawConfig;
      metadataSnapshot?: PluginMetadataSnapshot;
      config?: OpenClawConfig;
    }>(loadPluginLookUpTable);
    expect(lookupInput.activationSourceConfig).toBe(sourceConfig);
    expect(lookupInput.metadataSnapshot).toBe(pluginMetadataSnapshot);
    expect(lookupInput.config?.channels?.telegram?.enabled).toBe(true);
    expect(lookupInput.config?.channels?.telegram?.dmPolicy).toBe("pairing");
    expect(lookupInput.config?.channels?.telegram?.groupPolicy).toBe("allowlist");
    expect(lookupInput.config?.plugins?.allow).toEqual(["bench-plugin"]);
    expect(lookupInput.config?.plugins?.entries?.["bench-plugin"]?.enabled).toBe(true);
    expect(lookupInput.config?.plugins?.entries?.["bench-plugin"]?.config).toEqual({
      runtimeDefault: true,
    });
    expect(lookupInput.config?.plugins?.entries?.["memory-core"]?.config).toEqual({
      dreaming: { enabled: false },
    });

    expect(loadGatewayStartupPlugins).not.toHaveBeenCalled();
  });

  it.each([
    { minimalTestGateway: false, pluginsEnabled: true, reuseAmbientRegistry: false },
    { minimalTestGateway: true, pluginsEnabled: undefined, reuseAmbientRegistry: true },
    { minimalTestGateway: true, pluginsEnabled: true, reuseAmbientRegistry: true },
    { minimalTestGateway: true, pluginsEnabled: false, reuseAmbientRegistry: false },
  ])(
    "publishes the startup registry without runtime loading (minimal=$minimalTestGateway, enabled=$pluginsEnabled)",
    async ({ minimalTestGateway, pluginsEnabled, reuseAmbientRegistry }) => {
      const ambientRegistry = createEmptyPluginRegistry();
      ambientRegistry.gatewayHandlers.fixture = vi.fn();
      getActivePluginRegistry.mockReturnValue(ambientRegistry);

      const result = await prepareBootstrapWithRuntimeConfig(
        { ...slackConfig(), plugins: { enabled: pluginsEnabled } },
        { minimalTestGateway },
      );

      if (reuseAmbientRegistry) {
        expect(result.pluginRegistry).toBe(ambientRegistry);
      } else {
        expect(result.pluginRegistry.gatewayHandlers).toEqual({});
      }
      expect(setActivePluginRegistry).toHaveBeenCalledWith(result.pluginRegistry);
      expect(loadGatewayStartupPlugins).not.toHaveBeenCalled();
    },
  );

  it("threads durable worker provider ids into startup lookup planning", async () => {
    await prepareBootstrapWithRuntimeConfig({ channels: {} } as OpenClawConfig, {
      workerProviderIds: ["static-ssh"],
    });

    const lookupInput = firstCallArg<{ workerProviderIds?: readonly string[] }>(
      loadPluginLookUpTable,
    );
    expect(lookupInput.workerProviderIds).toEqual(["static-ssh"]);
  });

  it("preserves an explicitly empty manifest snapshot for ambient channel planning", async () => {
    const emptyManifestRegistry: PluginManifestRegistry = { plugins: [], diagnostics: [] };
    loadPluginLookUpTable.mockReturnValueOnce({
      manifestRegistry: emptyManifestRegistry,
      startup: {
        pluginIds: [],
        channelPluginIds: [],
      },
      metrics: pluginLookUpTableMetrics,
    });

    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");
    const result = await prepareGatewayPluginBootstrap({
      cfgAtStart: { channels: {} },
      minimalTestGateway: false,
      ambientEnvTriggers: "suppress",
      log,
    });

    expect(result.pluginManifestRecords).toBe(emptyManifestRegistry.plugins);
    const ambientInput = firstCallArg<{ manifestRecords?: readonly unknown[] }>(
      listAmbientOnlyConfiguredChannelIds,
    );
    expect(ambientInput.manifestRecords).toBe(emptyManifestRegistry.plugins);
  });

  it("bypasses plugin lookup when plugins are globally disabled", async () => {
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

    const result = await prepareBootstrapWithRuntimeConfig(cfg, {
      pluginMetadataSnapshot,
      workerProviderIds: ["static-ssh"],
    });
    expect(result.startupPluginIds).toEqual([]);
    expect(result.pluginMetadataSnapshot).toBe(pluginMetadataSnapshot);
    expect(result.pluginLookUpTable).toBeUndefined();
    expect(result.baseGatewayMethods).toEqual(["ping"]);

    expect(loadPluginLookUpTable).not.toHaveBeenCalled();
    expect(loadGatewayStartupPlugins).not.toHaveBeenCalled();
  });
});

describe("loadGatewayStartupPluginRuntime", () => {
  beforeEach(() => {
    loadGatewayStartupPlugins.mockClear().mockReturnValue({
      pluginRegistry: { diagnostics: [], gatewayHandlers: {}, plugins: [] },
      gatewayMethods: ["ping"],
    });
  });

  it("warns after a full startup runtime load when configured memory embedding providers stay unregistered", async () => {
    const log = createLog();
    const { loadGatewayStartupPluginRuntime } = await import("./server-startup-plugins.js");

    await loadGatewayStartupPluginRuntime({
      cfg: {
        memory: {
          search: {
            provider: "voyage",
          },
        },

        agents: {
          defaults: {},
        },
      } as OpenClawConfig,
      workspaceDir: "/workspace",
      log,
      baseMethods: ["ping"],
      startupPluginIds: ["voyage"],
    });

    const startupInput = firstCallArg<{ channelPluginLoadIntent?: "full" | "setup" }>(
      loadGatewayStartupPlugins,
    );
    expect(startupInput.channelPluginLoadIntent).toBe("full");
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('memory.search.provider="voyage"'),
    );
  });
});

describe("warnUnregisteredConfiguredMemoryEmbeddingProviders", () => {
  function registry(providerIds: string[], options: { embeddingProviderIds?: string[] } = {}) {
    return {
      embeddingProviders: [...providerIds, ...(options.embeddingProviderIds ?? [])].map((id) => ({
        provider: { id },
      })),
    } as never;
  }

  it("warns when a configured memory embedding provider is not registered", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        memory: { search: { provider: "openai" } },

        agents: { defaults: {} },
      } as OpenClawConfig,
      pluginRegistry: registry([]),
      log,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('memory.search.provider="openai"');
  });

  it("does not warn when the configured memory embedding provider is registered", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        memory: { search: { provider: "openai" } },

        agents: { defaults: {} },
      } as OpenClawConfig,
      pluginRegistry: registry(["openai"]),
      log,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns when a configured memory embedding fallback is not registered", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        memory: { search: { provider: "openai", fallback: "ollama" } },

        agents: { defaults: {} },
      } as OpenClawConfig,
      pluginRegistry: registry(["openai"]),
      log,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('memory.search.fallback="ollama"');
  });

  it("does not warn when the configured memory embedding fallback is registered", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        memory: { search: { provider: "openai", fallback: "ollama" } },

        agents: { defaults: {} },
      } as OpenClawConfig,
      pluginRegistry: registry(["openai", "ollama"]),
      log,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not warn when a generic embedding provider can serve configured memory search", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        memory: { search: { provider: "generic-embed" } },

        agents: { defaults: {} },
      } as OpenClawConfig,
      pluginRegistry: registry([], { embeddingProviderIds: ["generic-embed"] }),
      log,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not warn for core generic memory embedding providers", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        memory: { search: { provider: "openai-compatible" } },

        agents: { defaults: {} },
      } as OpenClawConfig,
      pluginRegistry: registry([]),
      log,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not warn for custom providers backed by core generic embeddings", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        memory: { search: { provider: "tenant-embeddings" } },

        agents: { defaults: {} },
        models: {
          providers: {
            "tenant-embeddings": {
              api: "openai-responses",
              baseUrl: "http://127.0.0.1:11434/v1",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      pluginRegistry: registry([]),
      log,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not warn for memory embedding fallbacks when primary provider is fts-only", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        memory: { search: { provider: "none", fallback: "openai" } },

        agents: { defaults: {} },
      } as OpenClawConfig,
      pluginRegistry: registry([]),
      log,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not warn for memory embedding providers when the memory slot is disabled", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        memory: { search: { provider: "openai", fallback: "ollama" } },

        agents: { defaults: {} },
        plugins: { slots: { memory: "none" } },
      } as OpenClawConfig,
      pluginRegistry: registry([]),
      log,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  function customOllamaConfig(source: "provider" | "fallback" = "provider"): OpenClawConfig {
    const memorySearch =
      source === "provider"
        ? { provider: "ollama-5080" }
        : { provider: "openai", fallback: "ollama-5080" };
    return {
      memory: { search: memorySearch },
      models: {
        providers: {
          "ollama-5080": {
            api: "ollama",
            baseUrl: "http://gpu-box.local:11435",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
  }

  it.each([
    ["provider", "memorySearch.provider"] as const,
    ["fallback", "memorySearch.fallback"] as const,
  ])(
    "does not warn for custom %s entries whose api-owner plugin is registered",
    async (source, _path) => {
      const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
        await import("./server-startup-plugins.js");
      const log = createLog();
      warnUnregisteredConfiguredMemoryEmbeddingProviders({
        config: customOllamaConfig(source),
        pluginRegistry: registry(["openai", "ollama"]),
        log,
      });
      expect(log.warn).not.toHaveBeenCalled();
    },
  );

  it("warns for custom providers whose api-owner plugin is not registered", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: customOllamaConfig(),
      pluginRegistry: registry([]),
      log,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('memory.search.provider="ollama-5080"');
  });

  it("warns for custom fallbacks whose api-owner plugin is not registered", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: customOllamaConfig("fallback"),
      pluginRegistry: registry(["openai"]),
      log,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('memory.search.fallback="ollama-5080"');
  });

  it("warns for local memory search when the llama.cpp provider is not registered", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        memory: { search: { provider: "local", fallback: "auto" } },

        agents: {
          defaults: {},
          list: [
            {
              id: "muted",
              memory: { search: { enabled: false, provider: "openai", fallback: "ollama" } },
            },
          ],
        },
      } as OpenClawConfig,
      pluginRegistry: registry([]),
      log,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('memory.search.provider="local"');
  });

  it("does not warn for disabled memory search providers", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        agents: {
          list: [
            {
              id: "muted",
              memory: { search: { enabled: false, provider: "openai", fallback: "ollama" } },
            },
          ],
        },
      } as OpenClawConfig,
      pluginRegistry: registry([]),
      log,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });
});
