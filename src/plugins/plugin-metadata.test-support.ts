import path from "node:path";
import { getInstalledPluginIndexInstallRecordsCacheGeneration } from "./installed-plugin-index-record-cache.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.types.js";
import type { PreparedPluginMetadata } from "./plugin-metadata-collection.types.js";
import { resolvePluginMetadataEnvFingerprint } from "./plugin-metadata-env.js";
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
  const snapshot: PluginMetadataSnapshot = {
    policyHash: "test-policy",
    index: {
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
    },
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

/** Keeps validation facts explicit while retaining separate executable workspace fixtures. */
export function createPreparedPluginMetadataFixture(params: {
  unionSnapshot: PluginMetadataSnapshot;
  selectedSnapshot?: PluginMetadataSnapshot;
  workspaces?: PreparedPluginMetadata["workspaces"];
  configWorkspaceDirs?: PreparedPluginMetadata["configWorkspaceDirs"];
  agentWorkspaceDirs?: PreparedPluginMetadata["agentWorkspaceDirs"];
  env?: NodeJS.ProcessEnv;
}): PreparedPluginMetadata {
  const { unionSnapshot } = params;
  const selectedSnapshot = params.selectedSnapshot ?? unionSnapshot;
  const workspaces =
    params.workspaces ?? new Map([[selectedSnapshot.workspaceDir, selectedSnapshot]]);
  return {
    unionSnapshot,
    selectedSnapshot,
    workspaces,
    configWorkspaceDirs: params.configWorkspaceDirs ?? [...workspaces.keys()],
    agentWorkspaceDirs: params.agentWorkspaceDirs ?? new Map(),
    installRecordsGeneration: getInstalledPluginIndexInstallRecordsCacheGeneration(),
    envFingerprint: resolvePluginMetadataEnvFingerprint(params.env),
    manifestRegistry: unionSnapshot.manifestRegistry,
    plugins: unionSnapshot.plugins,
    byPluginId: unionSnapshot.byPluginId,
    owners: unionSnapshot.owners,
    diagnostics: unionSnapshot.diagnostics,
    channelCatalog: { read: () => [] },
  };
}
