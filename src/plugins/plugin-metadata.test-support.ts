import path from "node:path";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.types.js";
import { rebasePluginMetadataSnapshotManifestRegistry } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

export function createPluginManifestRecordFixture(
  overrides: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">,
): PluginManifestRecord {
  const rootDir = overrides.rootDir ?? path.resolve("/tmp", overrides.id);
  return {
    channels: [],
    cliBackends: [],
    hooks: [],
    manifestPath: path.join(rootDir, "openclaw.plugin.json"),
    origin: "bundled",
    providers: [],
    rootDir,
    skills: [],
    source: path.join(rootDir, "index.js"),
    ...overrides,
  };
}

/** Keeps fixture indexes and manifest-derived views on the same complete contract. */
export function createPluginMetadataSnapshotFixture(
  registry: {
    plugins: Array<Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">>;
    diagnostics?: PluginManifestRegistry["diagnostics"];
  } = { plugins: [] },
): PluginMetadataSnapshot {
  const plugins = registry.plugins.map(createPluginManifestRecordFixture);
  const manifestRegistry = { plugins, diagnostics: registry.diagnostics ?? [] };
  const index: PluginMetadataSnapshot["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test-policy",
    generatedAtMs: 0,
    installRecords: {},
    plugins: plugins.map((plugin) => ({
      pluginId: plugin.id,
      origin: plugin.origin,
      manifestPath: plugin.manifestPath,
      manifestHash: "test-manifest",
      rootDir: plugin.rootDir,
      source: plugin.source,
      enabled: true,
      enabledByDefault: plugin.enabledByDefault ?? true,
      startup: { sidecar: false, memory: false, agentHarnesses: [] },
      compat: [],
    })),
    diagnostics: manifestRegistry.diagnostics,
  };
  const snapshot: PluginMetadataSnapshot = {
    policyHash: "test-policy",
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry,
    plugins,
    diagnostics: manifestRegistry.diagnostics,
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (pluginId) => pluginId.trim().toLowerCase(),
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
      indexPluginCount: plugins.length,
      manifestPluginCount: plugins.length,
    },
  };
  return rebasePluginMetadataSnapshotManifestRegistry(snapshot, manifestRegistry);
}
