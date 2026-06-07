/**
 * Gateway startup plugin bootstrap tests.
 */
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
      configuredDeferredChannelPluginIds: [] as string[],
      pluginIds: ["telegram"] as string[],
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

vi.mock("./methods/core-descriptors.js", () => ({
  listCoreGatewayMethodNames: () => ["ping", "config.openFile"],
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

function firstCallArg<T>(mock: { mock: { calls: unknown[][] } }, _type?: (value: T) => T): T {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected first mock call");
  }
  return call[0] as T;
}

function mockDeferredSlackStartupPlugins(): void {
  loadPluginLookUpTable.mockReturnValueOnce({
    manifestRegistry: pluginManifestRegistry,
    startup: {
      configuredDeferredChannelPluginIds: ["slack"] as string[],
      pluginIds: ["slack", "memory-core"] as string[],
    },
    metrics: {
      ...pluginLookUpTableMetrics,
      startupPluginCount: 2,
      deferredChannelPluginCount: 1,
    },
  });
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
    loadRuntimePlugins?: boolean;
    loadSetupRuntimePlugins?: boolean;
  } = {},
) {
  const log = createLog();
  const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

  return await prepareGatewayPluginBootstrap({
    cfgAtStart: cfg,
    startupRuntimeConfig: cfg,
    minimalTestGateway: false,
    log,
    ...options,
  });
}

function expectStartupPluginLoad(params: {
  pluginIds: string[];
  preferSetupRuntimeForChannelPlugins: boolean;
  suppressPluginInfoLogs: boolean;
}): void {
  const startupInput = firstCallArg<{
    pluginIds?: string[];
    preferSetupRuntimeForChannelPlugins?: boolean;
    suppressPluginInfoLogs?: boolean;
  }>(loadGatewayStartupPlugins);
  expect(startupInput.pluginIds).toEqual(params.pluginIds);
  expect(startupInput.preferSetupRuntimeForChannelPlugins).toBe(
    params.preferSetupRuntimeForChannelPlugins,
  );
  expect(startupInput.suppressPluginInfoLogs).toBe(params.suppressPluginInfoLogs);
}

describe("prepareGatewayPluginBootstrap startup plugins", () => {
  beforeEach(() => {
    applyPluginAutoEnable.mockClear();
    initSubagentRegistry.mockClear();
    loadGatewayStartupPlugins.mockClear();
    loadPluginLookUpTable.mockClear().mockReturnValue({
      manifestRegistry: pluginManifestRegistry,
      startup: {
        configuredDeferredChannelPluginIds: [] as string[],
        pluginIds: ["telegram"] as string[],
      },
      metrics: pluginLookUpTableMetrics,
    });
    resolveOpenClawPackageRootSync.mockClear().mockReturnValue("/package");
    runChannelPluginStartupMaintenance.mockClear();
    runStartupSessionMigration.mockClear();
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

    const startupInput = firstCallArg<{
      activationSourceConfig?: OpenClawConfig;
      cfg?: OpenClawConfig;
      baseMethods?: string[];
      coreGatewayMethodNames?: string[];
    }>(loadGatewayStartupPlugins);
    expect(startupInput.activationSourceConfig).toBe(sourceConfig);
    expect(startupInput.baseMethods).toEqual(["ping"]);
    expect(startupInput.coreGatewayMethodNames).toEqual(["ping", "config.openFile"]);
    expect(startupInput.cfg?.channels?.telegram?.enabled).toBe(true);
    expect(startupInput.cfg?.channels?.telegram?.dmPolicy).toBe("pairing");
    expect(startupInput.cfg?.channels?.telegram?.groupPolicy).toBe("allowlist");
    expect(startupInput.cfg?.plugins?.allow).toEqual(["bench-plugin"]);
    expect(startupInput.cfg?.plugins?.entries?.["bench-plugin"]?.enabled).toBe(true);
    expect(startupInput.cfg?.plugins?.entries?.["bench-plugin"]?.config).toEqual({
      runtimeDefault: true,
    });
    expect(startupInput.cfg?.plugins?.entries?.["memory-core"]?.config).toEqual({
      dreaming: { enabled: false },
    });
  });

  it("loads only deferred setup-runtime plugins during pre-bind bootstrap", async () => {
    mockDeferredSlackStartupPlugins();

    const result = await prepareBootstrapWithRuntimeConfig(slackConfig(), {
      loadRuntimePlugins: false,
      loadSetupRuntimePlugins: true,
    });

    expect(result.runtimePluginsLoaded).toBe(false);
    expectStartupPluginLoad({
      pluginIds: ["slack"],
      preferSetupRuntimeForChannelPlugins: true,
      suppressPluginInfoLogs: true,
    });
  });

  it("does not use setup-runtime preference for full bootstrap loads", async () => {
    mockDeferredSlackStartupPlugins();

    const result = await prepareBootstrapWithRuntimeConfig(slackConfig());

    expect(result.runtimePluginsLoaded).toBe(true);
    expectStartupPluginLoad({
      pluginIds: ["slack", "memory-core"],
      preferSetupRuntimeForChannelPlugins: false,
      suppressPluginInfoLogs: false,
    });
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

    const result = await prepareBootstrapWithRuntimeConfig(cfg);
    expect(result.startupPluginIds).toEqual([]);
    expect(result.deferredConfiguredChannelPluginIds).toEqual([]);
    expect(result.pluginLookUpTable).toBeUndefined();
    expect(result.baseGatewayMethods).toEqual(["ping"]);

    expect(loadPluginLookUpTable).not.toHaveBeenCalled();
    const startupInput = firstCallArg<{
      cfg?: OpenClawConfig;
      pluginIds?: string[];
      pluginLookUpTable?: unknown;
      preferSetupRuntimeForChannelPlugins?: boolean;
      suppressPluginInfoLogs?: boolean;
    }>(loadGatewayStartupPlugins);
    expect(startupInput.cfg).toStrictEqual(cfg);
    expect(startupInput.pluginIds).toEqual([]);
    expect(startupInput.pluginLookUpTable).toBeUndefined();
    expect(startupInput.preferSetupRuntimeForChannelPlugins).toBe(false);
    expect(startupInput.suppressPluginInfoLogs).toBe(false);
  });
});

describe("loadGatewayStartupPluginRuntime memory provider diagnostics", () => {
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
        agents: {
          defaults: {
            memorySearch: {
              provider: "voyage",
            },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/workspace",
      log,
      baseMethods: ["ping"],
      startupPluginIds: ["voyage"],
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('memorySearch.provider="voyage"'),
    );
  });

  it("does not warn during setup-runtime pre-bind loads", async () => {
    const log = createLog();
    const { loadGatewayStartupPluginRuntime } = await import("./server-startup-plugins.js");

    await loadGatewayStartupPluginRuntime({
      cfg: {
        agents: {
          defaults: {
            memorySearch: {
              provider: "voyage",
            },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/workspace",
      log,
      baseMethods: ["ping"],
      startupPluginIds: ["telegram"],
      preferSetupRuntimeForChannelPlugins: true,
    });

    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("warnUnregisteredConfiguredMemoryEmbeddingProviders", () => {
  function registry(providerIds: string[], options: { embeddingProviderIds?: string[] } = {}) {
    return {
      memoryEmbeddingProviders: providerIds.map((id) => ({ provider: { id } })),
      embeddingProviders: (options.embeddingProviderIds ?? []).map((id) => ({ provider: { id } })),
    } as never;
  }

  it("warns when a configured memory embedding provider is not registered", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        agents: { defaults: { memorySearch: { provider: "openai" } } },
      } as OpenClawConfig,
      pluginRegistry: registry([]),
      log,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('memorySearch.provider="openai"');
  });

  it("does not warn when the configured memory embedding provider is registered", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        agents: { defaults: { memorySearch: { provider: "openai" } } },
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
        agents: { defaults: { memorySearch: { provider: "openai", fallback: "ollama" } } },
      } as OpenClawConfig,
      pluginRegistry: registry(["openai"]),
      log,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('memorySearch.fallback="ollama"');
  });

  it("does not warn when the configured memory embedding fallback is registered", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        agents: { defaults: { memorySearch: { provider: "openai", fallback: "ollama" } } },
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
        agents: { defaults: { memorySearch: { provider: "generic-embed" } } },
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
        agents: { defaults: { memorySearch: { provider: "openai-compatible" } } },
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
        agents: { defaults: { memorySearch: { provider: "tenant-embeddings" } } },
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
        agents: { defaults: { memorySearch: { provider: "none", fallback: "openai" } } },
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
        agents: { defaults: { memorySearch: { provider: "openai", fallback: "ollama" } } },
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
      agents: { defaults: { memorySearch } },
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
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('memorySearch.provider="ollama-5080"');
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
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('memorySearch.fallback="ollama-5080"');
  });

  it("does not warn for sentinel or disabled memory search providers", async () => {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: {
        agents: {
          defaults: { memorySearch: { provider: "local", fallback: "auto" } },
          list: [
            {
              id: "muted",
              memorySearch: { enabled: false, provider: "openai", fallback: "ollama" },
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
