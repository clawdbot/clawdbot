/** Tests plugin lookup table indexing for manifest-owned contribution ids. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRegistrySnapshot } from "./plugin-registry.js";

const {
  listPotentialConfiguredChannelIds,
  listExplicitlyDisabledChannelIdsForConfig,
  loadPluginManifestRegistryForInstalledIndex,
} = vi.hoisted(() => {
  // Shared plugin workers must load the lookup graph under this file's manifest mocks.
  vi.resetModules();
  return {
    listPotentialConfiguredChannelIds: vi.fn(),
    listExplicitlyDisabledChannelIdsForConfig: vi.fn(),
    loadPluginManifestRegistryForInstalledIndex: vi.fn(),
  };
});

vi.mock("../channels/config-presence.js", () => ({
  hasMeaningfulChannelConfig: (value: unknown) =>
    Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).some((key) => key !== "enabled"),
    ),
  listPotentialConfiguredChannelIds: (
    config: OpenClawConfig,
    env: NodeJS.ProcessEnv,
    options?: { includePersistedAuthState?: boolean },
  ) => listPotentialConfiguredChannelIds(config, env, options),
  listPotentialConfiguredChannelPresenceSignals: (
    config: OpenClawConfig,
    env: NodeJS.ProcessEnv,
    options?: { includePersistedAuthState?: boolean },
  ) =>
    listPotentialConfiguredChannelIds(config, env, options).map((channelId: string) => ({
      channelId,
      source: "env" as const,
    })),
  listExplicitlyDisabledChannelIdsForConfig: (config: OpenClawConfig) =>
    listExplicitlyDisabledChannelIdsForConfig(config),
}));

vi.mock("./manifest-registry-installed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry-installed.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForInstalledIndex: (params: unknown) =>
      loadPluginManifestRegistryForInstalledIndex(params),
  };
});

function createManifestRecord(
  plugin: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id" | "origin">,
): PluginManifestRecord {
  return {
    name: plugin.id,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    rootDir: `/plugins/${plugin.id}`,
    source: `/plugins/${plugin.id}/index.js`,
    manifestPath: `/plugins/${plugin.id}/openclaw.plugin.json`,
    ...plugin,
  };
}

function createIndex(
  plugins: readonly PluginManifestRecord[],
  params: { policyHash?: string; enabled?: boolean } = {},
): PluginRegistrySnapshot {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: params.policyHash ?? "policy",
    generatedAtMs: 1,
    installRecords: {},
    diagnostics: [],
    plugins: plugins.map((plugin) => ({
      pluginId: plugin.id,
      manifestPath: plugin.manifestPath,
      manifestHash: `${plugin.id}-hash`,
      rootDir: plugin.rootDir,
      origin: plugin.origin,
      enabled: params.enabled ?? true,
      ...(plugin.enabledByDefault !== undefined
        ? { enabledByDefault: plugin.enabledByDefault }
        : {}),
      startup: {
        sidecar: false,
        memory: false,
        agentHarnesses: [],
        configPaths: plugin.activation?.onConfigPaths ?? [],
      },
      compat: [],
    })),
  };
}

const indexDiagnostic = {
  level: "warn",
  source: "/plugins/demo/openclaw.plugin.json",
  message: "indexed warning",
} as const;

const manifestDiagnostic = {
  level: "warn",
  source: "/plugins/demo/openclaw.plugin.json",
  message: "manifest warning",
} as const;

describe("loadPluginLookUpTable", () => {
  beforeEach(() => {
    listPotentialConfiguredChannelIds
      .mockReset()
      .mockImplementation((config: OpenClawConfig) => Object.keys(config.channels ?? {}));
    listExplicitlyDisabledChannelIdsForConfig.mockReset().mockReturnValue([]);
    loadPluginManifestRegistryForInstalledIndex.mockReset();
  });

  it("builds owner maps and startup ids from one installed manifest registry", async () => {
    const plugins = [
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
        channelConfigs: {
          telegram: {
            schema: { type: "object" },
          },
        },
        commandAliases: [{ name: "telegram-send" }],
        contracts: {
          tools: ["telegram.send"],
        },
      }),
      createManifestRecord({
        id: "openai",
        origin: "bundled",
        providers: ["openai"],
        providerAuthAliases: {
          openai: "openai",
        },
        modelCatalog: {
          aliases: {
            "azure-openai-responses": {
              provider: "openai",
            },
          },
          providers: {
            openai: {
              models: [{ id: "gpt-test" }],
            },
          },
        },
        cliBackends: [],
        setup: {
          providers: [{ id: "openai" }],
        },
      }),
    ];
    const index = {
      ...createIndex(plugins),
      diagnostics: [indexDiagnostic],
    };
    const manifestRegistry: PluginManifestRegistry = {
      plugins,
      diagnostics: [indexDiagnostic, manifestDiagnostic],
    };
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(manifestRegistry);
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

    const table = loadPluginLookUpTable({
      config: {
        channels: {
          telegram: { token: "configured" },
        },
        plugins: {
          slots: { memory: "none" },
        },
      } as OpenClawConfig,
      env: {},
      index,
    });

    expect(table.manifestRegistry).toBe(manifestRegistry);
    expect(table.diagnostics).toEqual([indexDiagnostic, manifestDiagnostic]);
    expect(table.metrics.indexPluginCount).toBe(2);
    expect(table.metrics.manifestPluginCount).toBe(2);
    expect(table.metrics.startupPluginCount).toBe(1);
    for (const metricName of [
      "registrySnapshotMs",
      "manifestRegistryMs",
      "startupPlanMs",
      "ownerMapsMs",
      "totalMs",
    ] as const) {
      expect(table.metrics[metricName]).toBeGreaterThanOrEqual(0);
    }
    expect(table.byPluginId.get("telegram")?.id).toBe("telegram");
    expect(table.normalizePluginId("openai")).toBe("openai");
    expect(table.owners.channels.get("telegram")).toEqual(["telegram"]);
    expect(table.owners.channelConfigs.get("telegram")).toEqual(["telegram"]);
    expect(table.owners.providers.get("openai")).toEqual(["openai"]);
    expect(table.owners.modelCatalogProviders.get("openai")).toEqual(["openai"]);
    expect(table.owners.modelCatalogProviders.get("azure-openai-responses")).toEqual(["openai"]);
    expect(table.owners.cliBackends.get("codex-cli")).toBeUndefined();
    expect(table.owners.setupProviders.get("openai")).toEqual(["openai"]);
    expect(table.owners.commandAliases.get("telegram-send")).toEqual(["telegram"]);
    expect(table.owners.contracts.get("tools")).toEqual(["telegram"]);
    expect(table.startup.channelPluginIds).toEqual(["telegram"]);
    expect(table.startup.pluginIds).toEqual(["telegram"]);
  });

  it("projects ambient activation policy from prepared lookup metadata", async () => {
    const plugins = [
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
      }),
    ];
    const config = {
      plugins: { slots: { memory: "none" } },
    } as OpenClawConfig;
    const env = { TELEGRAM_FAKE_TEST_TRIGGER: "configured" } as NodeJS.ProcessEnv;
    const index = createIndex(plugins, {
      policyHash: resolveInstalledPluginIndexPolicyHash(config),
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins,
      diagnostics: [],
    });
    listPotentialConfiguredChannelIds.mockImplementation(
      (
        _config: OpenClawConfig,
        _env: NodeJS.ProcessEnv,
        options?: { ambientEnvTriggers?: string },
      ) => (options?.ambientEnvTriggers === "suppress" ? [] : ["telegram"]),
    );
    const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");
    const metadataSnapshot = loadPluginMetadataSnapshot({ config, env, index });

    const ambient = loadPluginLookUpTable({ config, env, index, metadataSnapshot });
    const suppressed = loadPluginLookUpTable({
      config,
      env,
      index,
      metadataSnapshot,
      ambientEnvTriggers: "suppress",
    });
    expect(ambient.startup.pluginIds).toEqual(["telegram"]);
    expect(suppressed.startup.pluginIds).toStrictEqual([]);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
  });

  it("excludes ambient-only channels from the suppressed gateway startup plan", async () => {
    const plugins = [
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
      }),
    ];
    const index = createIndex(plugins);
    const manifestRegistry: PluginManifestRegistry = { plugins, diagnostics: [] };
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(manifestRegistry);
    listPotentialConfiguredChannelIds.mockImplementation(
      (
        _config: OpenClawConfig,
        _env: NodeJS.ProcessEnv,
        options?: { ambientEnvTriggers?: string },
      ) => (options?.ambientEnvTriggers === "suppress" ? [] : ["telegram"]),
    );
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");
    const config = { plugins: { slots: { memory: "none" } } } as OpenClawConfig;
    const env = { TELEGRAM_FAKE_TEST_TRIGGER: "configured" } as NodeJS.ProcessEnv;

    expect(loadPluginLookUpTable({ config, env, index }).startup.pluginIds).toEqual(["telegram"]);
    expect(
      loadPluginLookUpTable({
        config,
        env,
        index,
        ambientEnvTriggers: "suppress",
      }).startup.pluginIds,
    ).toStrictEqual([]);
    expect(
      loadPluginLookUpTable({
        config: {
          ...config,
          channels: { telegram: { enabled: true } },
        } as OpenClawConfig,
        env,
        index,
        ambientEnvTriggers: "suppress",
      }).startup.pluginIds,
    ).toEqual(["telegram"]);
  });

  it("projects restrictive startup allowlists from one complete inventory", async () => {
    const plugins = [
      createManifestRecord({
        id: "openai",
        origin: "bundled",
        enabledByDefault: true,
        providers: ["openai"],
        activation: {
          onStartup: true,
        },
      }),
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
      }),
      createManifestRecord({
        id: "discord",
        origin: "bundled",
        channels: ["discord"],
      }),
    ];
    const index = createIndex(plugins);
    loadPluginManifestRegistryForInstalledIndex.mockImplementation(
      (params: { pluginIds?: readonly string[] }) => ({
        plugins: params.pluginIds
          ? plugins.filter((plugin) => params.pluginIds?.includes(plugin.id))
          : plugins,
        diagnostics: [],
      }),
    );
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

    const params = {
      config: {
        plugins: {
          allow: ["openai"],
          slots: { memory: "none" },
        },
      } as OpenClawConfig,
      env: {},
      index,
    };
    const table = loadPluginLookUpTable(params);
    const repeated = loadPluginLookUpTable(params);
    expect(repeated.manifestRegistry).toBe(table.manifestRegistry);

    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
    expect(loadPluginManifestRegistryForInstalledIndex.mock.calls[0]?.[0]).toMatchObject({
      index,
      config: {
        plugins: {
          allow: ["openai"],
          slots: { memory: "none" },
        },
      },
      env: {},
      includeDisabled: true,
    });
    expect(loadPluginManifestRegistryForInstalledIndex.mock.calls[0]?.[0]).not.toHaveProperty(
      "pluginIds",
    );
    expect(table.pluginIds).toEqual(["openai"]);
    expect(table.metrics.indexPluginCount).toBe(3);
    expect(table.metrics.manifestPluginCount).toBe(1);
    expect(table.byPluginId.has("telegram")).toBe(false);
    expect(table.startup.pluginIds).toEqual(["openai"]);
  });

  it("keeps config-path activation owners when projecting one complete inventory", async () => {
    const plugins = [
      createManifestRecord({
        id: "openai",
        origin: "bundled",
        enabledByDefault: true,
        providers: ["openai"],
        activation: {
          onStartup: true,
        },
      }),
      createManifestRecord({
        id: "browser",
        origin: "bundled",
        enabledByDefault: true,
        activation: {
          onStartup: true,
          onConfigPaths: ["browser"],
        },
      }),
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
      }),
    ];
    const index = createIndex(plugins);
    loadPluginManifestRegistryForInstalledIndex.mockImplementation(
      (params: { pluginIds?: readonly string[] }) => ({
        plugins: params.pluginIds
          ? plugins.filter((plugin) => params.pluginIds?.includes(plugin.id))
          : plugins,
        diagnostics: [],
      }),
    );
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

    const params = {
      config: {
        browser: {
          enabled: true,
        },
        plugins: {
          allow: ["openai"],
          slots: { memory: "none" },
        },
      } as OpenClawConfig,
      env: {},
      index,
    };
    const table = loadPluginLookUpTable(params);
    const repeated = loadPluginLookUpTable(params);
    expect(repeated.manifestRegistry).toBe(table.manifestRegistry);

    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
    expect(loadPluginManifestRegistryForInstalledIndex.mock.calls[0]?.[0]).toMatchObject({
      index,
      config: params.config,
      env: {},
      includeDisabled: true,
    });
    expect(loadPluginManifestRegistryForInstalledIndex.mock.calls[0]?.[0]).not.toHaveProperty(
      "pluginIds",
    );
    expect(table.pluginIds).toEqual(["browser", "openai"]);
    expect(table.metrics.indexPluginCount).toBe(3);
    expect(table.metrics.manifestPluginCount).toBe(2);
    expect(table.byPluginId.has("telegram")).toBe(false);
    expect(table.startup.pluginIds).toEqual(["openai", "browser"]);
  });

  it("selects restrictive startup activation without narrowing the prepared inventory", async () => {
    const plugins = [
      createManifestRecord({
        id: "openai",
        origin: "bundled",
        enabledByDefault: true,
        providers: ["openai"],
        activation: {
          onStartup: true,
        },
      }),
      createManifestRecord({
        id: "browser",
        origin: "bundled",
        enabledByDefault: true,
        activation: {
          onStartup: true,
          onConfigPaths: ["browser"],
        },
      }),
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
      }),
    ];
    const config = {
      browser: {
        enabled: true,
      },
      plugins: {
        allow: ["openai"],
        slots: { memory: "none" },
      },
    } as OpenClawConfig;
    const index = createIndex(plugins, {
      policyHash: resolveInstalledPluginIndexPolicyHash(config),
    });
    loadPluginManifestRegistryForInstalledIndex.mockImplementation(
      (params: { pluginIds?: readonly string[] }) => ({
        plugins: params.pluginIds
          ? plugins.filter((plugin) => params.pluginIds?.includes(plugin.id))
          : plugins,
        diagnostics: [],
      }),
    );
    const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

    const metadataSnapshot = loadPluginMetadataSnapshot({
      config,
      env: {},
      index,
    });
    expect(metadataSnapshot.pluginIds).toBeUndefined();
    expect(metadataSnapshot.metrics.manifestPluginCount).toBe(3);
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    const table = loadPluginLookUpTable({
      config,
      env: {},
      index,
      metadataSnapshot,
    });

    expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
    expect(table.manifestRegistry).toBe(metadataSnapshot.manifestRegistry);
    expect(table.pluginIds).toBeUndefined();
    expect(table.metrics.indexPluginCount).toBe(3);
    expect(table.metrics.manifestPluginCount).toBe(3);
    expect(table.byPluginId.has("telegram")).toBe(true);
    expect(table.startup.pluginIds).toEqual(["openai", "browser"]);
  });

  it("reuses a scoped provided metadata snapshot when it covers the startup scope", async () => {
    const plugins = [
      createManifestRecord({
        id: "openai",
        origin: "bundled",
        enabledByDefault: true,
        providers: ["openai"],
        activation: {
          onStartup: true,
        },
      }),
      createManifestRecord({
        id: "browser",
        origin: "bundled",
        enabledByDefault: true,
        activation: {
          onStartup: true,
          onConfigPaths: ["browser"],
        },
      }),
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
      }),
    ];
    const config = {
      browser: {
        enabled: false,
      },
      plugins: {
        allow: ["openai"],
        entries: {
          browser: { enabled: false },
          openai: { enabled: true },
        },
        slots: { memory: "none" },
      },
    } as OpenClawConfig;
    const index = createIndex(plugins, {
      policyHash: resolveInstalledPluginIndexPolicyHash(config),
    });
    loadPluginManifestRegistryForInstalledIndex.mockImplementation(
      (params: { pluginIds?: readonly string[] }) => ({
        plugins: params.pluginIds
          ? plugins.filter((plugin) => params.pluginIds?.includes(plugin.id))
          : plugins,
        diagnostics: [],
      }),
    );
    const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

    const metadataSnapshot = loadPluginMetadataSnapshot({
      config,
      env: {},
      index,
      pluginIds: ["browser", "openai"],
    });
    expect(metadataSnapshot.pluginIds).toEqual(["browser", "openai"]);
    expect(metadataSnapshot.metrics.manifestPluginCount).toBe(2);
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    const table = loadPluginLookUpTable({
      config,
      env: {},
      index,
      metadataSnapshot,
    });

    expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
    expect(table.pluginIds).toEqual(["browser", "openai"]);
    expect(table.metrics.indexPluginCount).toBe(3);
    expect(table.metrics.manifestPluginCount).toBe(2);
    expect(table.byPluginId.has("telegram")).toBe(false);
    expect(table.startup.pluginIds).toEqual(["openai"]);
  });

  it("keeps prepared metadata when all runtime activation is disabled", async () => {
    const plugins = [
      createManifestRecord({
        id: "openai",
        origin: "bundled",
        enabledByDefault: true,
        providers: ["openai"],
        activation: {
          onStartup: true,
        },
      }),
    ];
    const config = {
      plugins: {
        enabled: false,
      },
    } as OpenClawConfig;
    const index = createIndex(plugins, {
      policyHash: resolveInstalledPluginIndexPolicyHash(config),
    });
    loadPluginManifestRegistryForInstalledIndex.mockImplementation(
      (params: { pluginIds?: readonly string[] }) => ({
        plugins: params.pluginIds
          ? plugins.filter((plugin) => params.pluginIds?.includes(plugin.id))
          : plugins,
        diagnostics: [],
      }),
    );
    const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

    const metadataSnapshot = loadPluginMetadataSnapshot({
      config,
      env: {},
      index,
      pluginIds: ["openai"],
    });
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    const table = loadPluginLookUpTable({
      config,
      env: {},
      index,
      metadataSnapshot,
    });

    expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
    expect(table.manifestRegistry).toBe(metadataSnapshot.manifestRegistry);
    expect(table.pluginIds).toEqual(["openai"]);
    expect(table.metrics.manifestPluginCount).toBe(1);
    expect(table.startup.pluginIds).toEqual([]);
  });

  it("derives startup ids from a provided metadata snapshot without reloading manifests", async () => {
    const plugins = [
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
      }),
    ];
    const index = createIndex(plugins);
    const config = {
      channels: {
        telegram: { token: "configured" },
      },
    } as OpenClawConfig;
    const compatibleIndex = {
      ...index,
      policyHash: resolveInstalledPluginIndexPolicyHash(config),
    };
    const manifestRegistry: PluginManifestRegistry = {
      plugins,
      diagnostics: [],
    };
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(manifestRegistry);
    const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

    const metadataSnapshot = loadPluginMetadataSnapshot({
      config,
      env: {},
      index: compatibleIndex,
    });
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    const table = loadPluginLookUpTable({
      config,
      env: {},
      metadataSnapshot,
    });

    expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
    expect(table.manifestRegistry).toBe(manifestRegistry);
    expect(table.startup.pluginIds).toEqual(["telegram"]);
    expect(table.metrics.indexPluginCount).toBe(1);
    expect(table.metrics.manifestPluginCount).toBe(1);
    expect(table.metrics.totalMs).toBe(
      metadataSnapshot.metrics.totalMs + table.metrics.startupPlanMs,
    );
  });

  it("applies current activation policy without replacing the startup inventory", async () => {
    const plugins = [
      createManifestRecord({
        id: "demo",
        origin: "bundled",
        enabledByDefault: true,
        activation: { onStartup: true },
      }),
    ];
    const startupConfig: OpenClawConfig = {
      plugins: {
        entries: { demo: { enabled: false } },
        load: { paths: ["/plugins/startup"] },
        slots: { memory: "none" },
      },
    };
    const index = createIndex(plugins, {
      policyHash: resolveInstalledPluginIndexPolicyHash(startupConfig),
      enabled: false,
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue({ plugins, diagnostics: [] });
    const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");
    const metadataSnapshot = loadPluginMetadataSnapshot({
      config: startupConfig,
      env: {},
      workspaceDir: "/workspace/startup",
      index,
    });
    loadPluginManifestRegistryForInstalledIndex.mockClear();
    const enabledConfig: OpenClawConfig = {
      plugins: { load: { paths: ["/plugins/next-boot"] }, slots: { memory: "none" } },
    };
    const replacementIndex = createIndex([
      ...plugins,
      createManifestRecord({
        id: "next-boot",
        origin: "bundled",
        enabledByDefault: true,
        activation: { onStartup: true },
      }),
    ]);

    for (const [config, expectedPluginIds] of [
      [startupConfig, []],
      [enabledConfig, ["demo"]],
      [{ ...enabledConfig, plugins: { ...enabledConfig.plugins, deny: ["demo"] } }, []],
    ] satisfies Array<[OpenClawConfig, string[]]>) {
      const table = loadPluginLookUpTable({
        config,
        env: { HOME: "/home/next-boot" },
        workspaceDir: "/workspace/next-boot",
        index: replacementIndex,
        metadataSnapshot,
      });
      expect(table.startup.pluginIds).toEqual(expectedPluginIds);
      expect(table.manifestRegistry).toBe(metadataSnapshot.manifestRegistry);
      expect(table.index).toBe(metadataSnapshot.index);
      expect([...table.byPluginId.keys()]).toEqual(["demo"]);
    }
    expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
  });
});
