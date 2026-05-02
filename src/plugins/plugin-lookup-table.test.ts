import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRegistrySnapshot } from "./plugin-registry.js";

const listPotentialConfiguredChannelIds = vi.hoisted(() => vi.fn());
const listExplicitlyDisabledChannelIdsForConfig = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryForInstalledIndex = vi.hoisted(() => vi.fn());

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
  params: { policyHash?: string } = {},
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
      enabled: true,
      ...(plugin.enabledByDefault !== undefined
        ? { enabledByDefault: plugin.enabledByDefault }
        : {}),
      startup: {
        sidecar: false,
        memory: false,
        deferConfiguredChannelFullLoadUntilAfterListen: Boolean(
          plugin.startupDeferConfiguredChannelFullLoadUntilAfterListen,
        ),
        agentHarnesses: [],
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
        providers: ["openai", "openai-codex"],
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
        cliBackends: ["codex-cli"],
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
    expect(table.metrics).toMatchObject({
      registrySnapshotMs: expect.any(Number),
      manifestRegistryMs: expect.any(Number),
      startupPlanMs: expect.any(Number),
      ownerMapsMs: expect.any(Number),
      totalMs: expect.any(Number),
      indexPluginCount: 2,
      manifestPluginCount: 2,
      startupPluginCount: 1,
      deferredChannelPluginCount: 0,
    });
    expect(table.byPluginId.get("telegram")?.id).toBe("telegram");
    expect(table.normalizePluginId("openai-codex")).toBe("openai");
    expect(table.owners.channels.get("telegram")).toEqual(["telegram"]);
    expect(table.owners.channelConfigs.get("telegram")).toEqual(["telegram"]);
    expect(table.owners.providers.get("openai")).toEqual(["openai"]);
    expect(table.owners.modelCatalogProviders.get("openai")).toEqual(["openai"]);
    expect(table.owners.modelCatalogProviders.get("azure-openai-responses")).toEqual(["openai"]);
    expect(table.owners.cliBackends.get("codex-cli")).toEqual(["openai"]);
    expect(table.owners.setupProviders.get("openai")).toEqual(["openai"]);
    expect(table.owners.commandAliases.get("telegram-send")).toEqual(["telegram"]);
    expect(table.owners.contracts.get("tools")).toEqual(["telegram"]);
    expect(table.startup.channelPluginIds).toEqual(["telegram"]);
    expect(table.startup.configuredDeferredChannelPluginIds).toEqual([]);
    expect(table.startup.pluginIds).toEqual(["telegram"]);
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

  it("rebuilds when a provided metadata snapshot has a stale plugin policy", async () => {
    const plugins = [
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
      }),
    ];
    const snapshotConfig = {
      plugins: {
        allow: ["telegram"],
      },
    } as OpenClawConfig;
    const requestedConfig = {
      plugins: {
        allow: ["other-plugin"],
      },
    } as OpenClawConfig;
    const snapshotIndex = createIndex(plugins, {
      policyHash: resolveInstalledPluginIndexPolicyHash(snapshotConfig),
    });
    const requestedIndex = createIndex(plugins, {
      policyHash: resolveInstalledPluginIndexPolicyHash(requestedConfig),
    });
    const manifestRegistry: PluginManifestRegistry = {
      plugins,
      diagnostics: [],
    };
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(manifestRegistry);
    const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

    const metadataSnapshot = loadPluginMetadataSnapshot({
      config: snapshotConfig,
      env: {},
      index: snapshotIndex,
    });
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    loadPluginLookUpTable({
      config: requestedConfig,
      env: {},
      index: requestedIndex,
      metadataSnapshot,
    });

    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        index: requestedIndex,
        config: requestedConfig,
      }),
    );
  });

  it("rebuilds when a provided metadata snapshot has stale plugin load paths", async () => {
    const plugins = [
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
      }),
    ];
    const snapshotConfig = {
      plugins: {
        load: { paths: ["/plugins/one"] },
      },
    } as OpenClawConfig;
    const requestedConfig = {
      plugins: {
        load: { paths: ["/plugins/two"] },
      },
    } as OpenClawConfig;
    const policyHash = resolveInstalledPluginIndexPolicyHash(snapshotConfig);
    const index = createIndex(plugins, { policyHash });
    const manifestRegistry: PluginManifestRegistry = {
      plugins,
      diagnostics: [],
    };
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(manifestRegistry);
    const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

    const metadataSnapshot = loadPluginMetadataSnapshot({
      config: snapshotConfig,
      env: {},
      index,
    });
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    loadPluginLookUpTable({
      config: requestedConfig,
      env: {},
      index,
      metadataSnapshot,
    });

    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        index,
        config: requestedConfig,
      }),
    );
  });

  it("rebuilds when a provided metadata snapshot has stale env-resolved plugin load paths", async () => {
    const plugins = [
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
      }),
    ];
    const config = {
      plugins: {
        load: { paths: ["~/plugins"] },
      },
    } as OpenClawConfig;
    const snapshotEnv = {
      HOME: "/home/snapshot",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    const requestedEnv = {
      HOME: "/home/requested",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    const policyHash = resolveInstalledPluginIndexPolicyHash(config);
    const index = createIndex(plugins, { policyHash });
    const manifestRegistry: PluginManifestRegistry = {
      plugins,
      diagnostics: [],
    };
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(manifestRegistry);
    const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

    const metadataSnapshot = loadPluginMetadataSnapshot({
      config,
      env: snapshotEnv,
      index,
    });
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    loadPluginLookUpTable({
      config,
      env: requestedEnv,
      index,
      metadataSnapshot,
    });

    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        index,
        config,
        env: requestedEnv,
      }),
    );
  });

  it("rebuilds when a provided metadata snapshot has stale env-resolved plugin roots", async () => {
    const plugins = [
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
      }),
    ];
    const config = {} as OpenClawConfig;
    const snapshotEnv = {
      HOME: "/home/snapshot",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    const requestedEnv = {
      HOME: "/home/requested",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    const policyHash = resolveInstalledPluginIndexPolicyHash(config);
    const index = createIndex(plugins, { policyHash });
    const manifestRegistry: PluginManifestRegistry = {
      plugins,
      diagnostics: [],
    };
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(manifestRegistry);
    const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

    const metadataSnapshot = loadPluginMetadataSnapshot({
      config,
      env: snapshotEnv,
      index,
    });
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    loadPluginLookUpTable({
      config,
      env: requestedEnv,
      index,
      metadataSnapshot,
    });

    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        index,
        config,
        env: requestedEnv,
      }),
    );
  });

  it("rebuilds when a provided metadata snapshot has stale plugin inventory", async () => {
    const snapshotPlugins = [
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
      }),
    ];
    const requestedPlugins = [
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
    const config = {
      channels: {
        telegram: { token: "configured" },
      },
    } as OpenClawConfig;
    const policyHash = resolveInstalledPluginIndexPolicyHash(config);
    const snapshotIndex = createIndex(snapshotPlugins, { policyHash });
    const requestedIndex = createIndex(requestedPlugins, { policyHash });
    const snapshotRegistry: PluginManifestRegistry = {
      plugins: snapshotPlugins,
      diagnostics: [],
    };
    const requestedRegistry: PluginManifestRegistry = {
      plugins: requestedPlugins,
      diagnostics: [],
    };
    loadPluginManifestRegistryForInstalledIndex
      .mockReturnValueOnce(snapshotRegistry)
      .mockReturnValueOnce(requestedRegistry);
    const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

    const metadataSnapshot = loadPluginMetadataSnapshot({
      config,
      env: {},
      index: snapshotIndex,
    });
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    const table = loadPluginLookUpTable({
      config,
      env: {},
      index: requestedIndex,
      metadataSnapshot,
    });

    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        index: requestedIndex,
        config,
      }),
    );
    expect(table.manifestRegistry).toBe(requestedRegistry);
  });

  it("rebuilds when a provided metadata snapshot has stale plugin paths", async () => {
    const snapshotPlugins = [
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
      }),
    ];
    const requestedPlugins = [
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
        rootDir: "/plugins-moved/telegram",
        source: "/plugins-moved/telegram/index.js",
        manifestPath: "/plugins-moved/telegram/openclaw.plugin.json",
      }),
    ];
    const config = {
      channels: {
        telegram: { token: "configured" },
      },
    } as OpenClawConfig;
    const policyHash = resolveInstalledPluginIndexPolicyHash(config);
    const snapshotIndex = createIndex(snapshotPlugins, { policyHash });
    const requestedIndex = createIndex(requestedPlugins, { policyHash });
    const snapshotRegistry: PluginManifestRegistry = {
      plugins: snapshotPlugins,
      diagnostics: [],
    };
    const requestedRegistry: PluginManifestRegistry = {
      plugins: requestedPlugins,
      diagnostics: [],
    };
    loadPluginManifestRegistryForInstalledIndex
      .mockReturnValueOnce(snapshotRegistry)
      .mockReturnValueOnce(requestedRegistry);
    const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

    const metadataSnapshot = loadPluginMetadataSnapshot({
      config,
      env: {},
      index: snapshotIndex,
    });
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    const table = loadPluginLookUpTable({
      config,
      env: {},
      index: requestedIndex,
      metadataSnapshot,
    });

    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        index: requestedIndex,
        config,
      }),
    );
    expect(table.manifestRegistry).toBe(requestedRegistry);
  });
});
