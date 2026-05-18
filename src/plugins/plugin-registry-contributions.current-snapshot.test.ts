import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry-contributions.js";

afterEach(() => {
  clearCurrentPluginMetadataSnapshot();
});

function createPluginRecord(id: string, enabled: boolean): InstalledPluginIndex["plugins"][number] {
  return {
    pluginId: id,
    manifestPath: `/plugins/${id}/openclaw.plugin.json`,
    manifestHash: id,
    rootDir: `/plugins/${id}`,
    origin: "global",
    enabled,
    startup: {
      sidecar: false,
      memory: false,
      deferConfiguredChannelFullLoadUntilAfterListen: false,
      agentHarnesses: [],
    },
    compat: [],
  } as unknown as InstalledPluginIndex["plugins"][number];
}

function createManifest(id: string): PluginManifestRecord {
  return {
    id,
    origin: "global",
    providers: [],
    channels: [],
    channelConfigs: {},
    cliBackends: [],
    contracts: {},
  } as unknown as PluginManifestRecord;
}

function createSnapshot(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  registryDiagnostics?: PluginMetadataSnapshot["registryDiagnostics"];
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  const index: InstalledPluginIndex = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 0,
    installRecords: {},
    plugins: [createPluginRecord("enabled", true), createPluginRecord("disabled", false)],
    diagnostics: [],
  };
  const plugins = [createManifest("enabled"), createManifest("disabled")];
  return {
    policyHash,
    workspaceDir: params.workspaceDir,
    configFingerprint: "",
    index,
    registryDiagnostics: params.registryDiagnostics ?? [],
    manifestRegistry: { plugins, diagnostics: [] },
    plugins,
    diagnostics: [],
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (pluginId: string) => pluginId,
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
      indexPluginCount: index.plugins.length,
      manifestPluginCount: plugins.length,
    },
  };
}

describe("loadPluginManifestRegistryForPluginRegistry current snapshot", () => {
  it("reuses compatible current manifest metadata", () => {
    const config: OpenClawConfig = {};
    const env = {
      HOME: "/tmp/openclaw-test-home",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const workspaceDir = "/workspace";
    setCurrentPluginMetadataSnapshot(createSnapshot({ config, workspaceDir }), {
      config,
      env,
      workspaceDir,
    });

    expect(
      loadPluginManifestRegistryForPluginRegistry({ config, env, workspaceDir }).plugins.map(
        (plugin) => plugin.id,
      ),
    ).toEqual(["enabled"]);
    expect(
      loadPluginManifestRegistryForPluginRegistry({
        config,
        env,
        workspaceDir,
        includeDisabled: true,
      }).plugins.map((plugin) => plugin.id),
    ).toEqual(["enabled", "disabled"]);
    expect(
      loadPluginManifestRegistryForPluginRegistry({
        config,
        env,
        workspaceDir,
        includeDisabled: true,
        pluginIds: [],
      }).plugins.map((plugin) => plugin.id),
    ).toEqual([]);
    expect(
      loadPluginManifestRegistryForPluginRegistry({
        config,
        env,
        workspaceDir,
        includeDisabled: true,
        pluginIds: ["disabled"],
      }).plugins.map((plugin) => plugin.id),
    ).toEqual(["disabled"]);
  });

  it("does not reuse current metadata for explicit registry inputs or diagnostics", () => {
    const config: OpenClawConfig = {};
    const env = {
      HOME: "/tmp/openclaw-test-home",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const workspaceDir = "/workspace";
    setCurrentPluginMetadataSnapshot(createSnapshot({ config, workspaceDir }), {
      config,
      env,
      workspaceDir,
    });
    const emptyIndex: InstalledPluginIndex = {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: resolveInstalledPluginIndexPolicyHash(config),
      generatedAtMs: 0,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    };

    expect(
      loadPluginManifestRegistryForPluginRegistry({
        config,
        env,
        workspaceDir,
        index: emptyIndex,
        includeDisabled: true,
      }).plugins,
    ).toEqual([]);

    clearCurrentPluginMetadataSnapshot();
    setCurrentPluginMetadataSnapshot(
      createSnapshot({
        config,
        workspaceDir,
        registryDiagnostics: [
          {
            level: "info",
            code: "persisted-registry-missing",
            message: "missing",
          },
        ],
      }),
      { config, env, workspaceDir },
    );

    expect(
      loadPluginManifestRegistryForPluginRegistry({ config, env, workspaceDir }).plugins.map(
        (plugin) => plugin.id,
      ),
    ).toEqual([]);
  });
});
