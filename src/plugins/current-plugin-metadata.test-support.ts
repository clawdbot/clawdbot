import { adoptCurrentPluginMetadataSnapshotIfAbsent } from "./current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

/** Replaces a test fixture through the operation lifecycle's clear and adopt boundaries. */
export function setCurrentPluginMetadataSnapshot(
  snapshot: PluginMetadataSnapshot | undefined,
  options?: Parameters<typeof adoptCurrentPluginMetadataSnapshotIfAbsent>[1],
): void {
  clearCurrentPluginMetadataSnapshot();
  if (snapshot) {
    adoptCurrentPluginMetadataSnapshotIfAbsent(snapshot, options);
  }
}

export function makePluginMetadataIndex(pluginId = "demo"): InstalledPluginIndex {
  const rootDir = `/plugins/${pluginId}`;
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    installRecords: {},
    diagnostics: [],
    plugins: [
      {
        pluginId,
        manifestPath: `${rootDir}/openclaw.plugin.json`,
        manifestHash: `${pluginId}-manifest`,
        rootDir,
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
  };
}

export function makePluginMetadataManifestRegistry(pluginId = "demo"): PluginManifestRegistry {
  const plugin: PluginManifestRecord = {
    id: pluginId,
    name: pluginId,
    channels: [],
    providers: [pluginId],
    cliBackends: [],
    skills: [],
    hooks: [],
    commandAliases: [{ name: `${pluginId}-command` }],
    rootDir: `/plugins/${pluginId}`,
    source: `/plugins/${pluginId}/index.js`,
    manifestPath: `/plugins/${pluginId}/openclaw.plugin.json`,
    origin: "global",
  };
  return { plugins: [plugin], diagnostics: [] };
}
