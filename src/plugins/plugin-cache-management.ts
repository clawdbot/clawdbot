import type { PluginInstallRecordMapState } from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import type { HostedOfficialExternalPluginCatalogLoadResult } from "./official-external-plugin-catalog.types.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import type { PluginDependencyStatus } from "./status-dependencies-core.js";

export type PersistedInstalledPluginIndexCacheEntry = {
  state: { status: "missing" | "invalid" } | { status: "present"; value: unknown };
  records?: PluginInstallRecordMapState;
  index?: InstalledPluginIndex | null;
};

export type PluginCacheManagement<TCache> = {
  installRecords: Map<string, Record<string, PluginInstallRecord>>;
  persistedInstalledIndex: Map<string, PersistedInstalledPluginIndexCacheEntry>;
  desiredMetadata?: {
    boot: PluginMetadataSnapshot;
    cache: TCache;
    snapshot: PluginMetadataSnapshot;
  };
  dependencyStatus: WeakMap<PluginManifestRecord, PluginDependencyStatus>;
  officialCatalog?: Promise<HostedOfficialExternalPluginCatalogLoadResult>;
};

export function createPluginCacheManagement<TCache>(): PluginCacheManagement<TCache> {
  return {
    installRecords: new Map(),
    persistedInstalledIndex: new Map(),
    dependencyStatus: new WeakMap(),
  };
}
