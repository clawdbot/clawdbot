// Verifies current plugin registry contribution snapshots.
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import {
  loadPluginManifestRegistryForPluginRegistry,
  resolveManifestContractOwnerPluginId,
  resolveManifestContractPluginIds,
} from "./plugin-registry-contributions.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-snapshot.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
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
    contracts: { webSearchProviders: [`${id}-search`] },
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
    registryIndex: index,
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
      modelIdNormalizationPolicies: new Map(),
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
  it("reuses an allowlisted published snapshot for configless manifest reads", () => {
    const config: OpenClawConfig = { plugins: { allow: ["enabled"] } };
    const env = {
      HOME: "/tmp/openclaw-test-home",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const workspaceDir = "/workspace";
    const snapshot = createSnapshot({ config, workspaceDir });
    setCurrentPluginMetadataSnapshot(snapshot, { config, env, workspaceDir });
    const readDirectory = vi.spyOn(fs, "readdirSync");
    const readFile = vi.spyOn(fs, "readFileSync");

    expect(loadManifestMetadataSnapshot({ env })).toBe(snapshot);
    expect(readDirectory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("projects supplied contract manifests without dropping disabled owners", () => {
    const config: OpenClawConfig = { plugins: { allow: ["enabled"] } };
    const env = {
      HOME: "/tmp/openclaw-test-home",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const workspaceDir = "/workspace";
    const snapshot = createSnapshot({ config, workspaceDir });
    setCurrentPluginMetadataSnapshot(snapshot, { config, env, workspaceDir });
    const readDirectory = vi.spyOn(fs, "readdirSync");
    const readFile = vi.spyOn(fs, "readFileSync");

    expect(
      resolveManifestContractPluginIds({
        contract: "webSearchProviders",
        config,
        env,
        workspaceDir,
      }),
    ).toEqual(["disabled", "enabled"]);
    expect(
      resolveManifestContractOwnerPluginId({
        contract: "webSearchProviders",
        value: " DISABLED-SEARCH ",
        config,
        env,
        workspaceDir,
      }),
    ).toBe("disabled");
    expect(
      resolveManifestContractPluginIds({
        contract: "webSearchProviders",
        config: { plugins: { allow: ["incompatible-policy"] } },
        env,
        manifestRecords: snapshot.plugins,
        onlyPluginIds: ["disabled"],
      }),
    ).toEqual(["disabled"]);
    expect(
      resolveManifestContractOwnerPluginId({
        contract: "webSearchProviders",
        value: "disabled-search",
        config: { plugins: { allow: ["incompatible-policy"] } },
        env,
        manifestRecords: snapshot.plugins,
      }),
    ).toBe("disabled");
    expect(readDirectory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

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
    expect(loadPluginManifestRegistryForPluginRegistry({ config, env }).plugins).toEqual([]);
  });

  it("keeps explicit registry inputs authoritative and reuses current diagnostics", () => {
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

    clearPluginMetadataLifecycleCaches();
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
    const readDirectory = vi.spyOn(fs, "readdirSync");
    const readFile = vi.spyOn(fs, "readFileSync");
    const statFile = vi.spyOn(fs, "statSync");

    expect(
      loadPluginManifestRegistryForPluginRegistry({ config, env, workspaceDir }).plugins.map(
        (plugin) => plugin.id,
      ),
    ).toEqual(["enabled"]);
    expect(
      loadPluginRegistrySnapshotWithMetadata({ config, env, workspaceDir }).diagnostics,
    ).toEqual([
      {
        level: "info",
        code: "persisted-registry-missing",
        message: "missing",
      },
    ]);
    expect(readDirectory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(statFile).not.toHaveBeenCalled();
  });
});
