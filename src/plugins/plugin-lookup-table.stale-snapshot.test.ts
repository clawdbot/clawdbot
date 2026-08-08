/** Tests stale plugin lookup table snapshot rebuild cases. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
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
      startup: {
        sidecar: false,
        memory: false,
        deferConfiguredChannelFullLoadUntilAfterListen: false,
        agentHarnesses: [],
        configPaths: plugin.activation?.onConfigPaths ?? [],
      },
      compat: [],
    })),
  };
}

async function expectStaleMetadataSnapshotRebuild(params: {
  config: OpenClawConfig;
  snapshotPlugins: readonly PluginManifestRecord[];
  requestedPlugins?: readonly PluginManifestRecord[];
  snapshotEnv?: NodeJS.ProcessEnv;
  requestedEnv?: NodeJS.ProcessEnv;
}) {
  const requestedPlugins = params.requestedPlugins ?? params.snapshotPlugins;
  const snapshotEnv = params.snapshotEnv ?? {};
  const requestedEnv = params.requestedEnv ?? {};
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  const snapshotIndex = createIndex(params.snapshotPlugins, { policyHash });
  const requestedIndex = createIndex(requestedPlugins, { policyHash });
  const snapshotRegistry: PluginManifestRegistry = {
    plugins: [...params.snapshotPlugins],
    diagnostics: [],
  };
  const requestedRegistry: PluginManifestRegistry = {
    plugins: [...requestedPlugins],
    diagnostics: [],
  };
  loadPluginManifestRegistryForInstalledIndex
    .mockReturnValueOnce(snapshotRegistry)
    .mockReturnValue(requestedRegistry);
  const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
  const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

  const metadataSnapshot = loadPluginMetadataSnapshot({
    config: params.config,
    env: snapshotEnv,
    index: snapshotIndex,
  });
  loadPluginManifestRegistryForInstalledIndex.mockClear();

  const table = loadPluginLookUpTable({
    config: params.config,
    env: requestedEnv,
    index: requestedIndex,
    metadataSnapshot,
  });

  expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
  expect(loadPluginManifestRegistryForInstalledIndex.mock.calls).toEqual([
    [
      {
        index: requestedIndex,
        config: params.config,
        workspaceDir: undefined,
        env: requestedEnv,
        includeDisabled: true,
      },
    ],
  ]);
  return { table, requestedRegistry };
}

describe("loadPluginLookUpTable stale metadata snapshots", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    listPotentialConfiguredChannelIds
      .mockReset()
      .mockImplementation((config: OpenClawConfig) => Object.keys(config.channels ?? {}));
    listExplicitlyDisabledChannelIdsForConfig.mockReset().mockReturnValue([]);
    loadPluginManifestRegistryForInstalledIndex.mockReset();
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
    await expectStaleMetadataSnapshotRebuild({
      config,
      snapshotPlugins: plugins,
      snapshotEnv,
      requestedEnv,
    });
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
    await expectStaleMetadataSnapshotRebuild({
      config,
      snapshotPlugins: plugins,
      snapshotEnv,
      requestedEnv,
    });
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
    const { table, requestedRegistry } = await expectStaleMetadataSnapshotRebuild({
      config,
      snapshotPlugins,
      requestedPlugins,
    });

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
    const { table, requestedRegistry } = await expectStaleMetadataSnapshotRebuild({
      config,
      snapshotPlugins,
      requestedPlugins,
    });

    expect(table.manifestRegistry).toBe(requestedRegistry);
  });
});
