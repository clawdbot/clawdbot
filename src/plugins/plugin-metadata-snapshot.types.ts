import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginDiscoveryResult } from "./discovery.types.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.types.js";
import type {
  PluginDiagnostic,
  PluginManifestModelIdNormalizationProvider,
  PluginManifestProviderEndpoint,
  PluginManifestProviderRequestProvider,
} from "./manifest-types.js";
import type {
  PluginRegistrySnapshotDiagnostic,
  PluginRegistrySnapshotSource,
} from "./plugin-registry-snapshot.types.js";

export type PluginMetadataSnapshotPluginIdScope = {
  resolve: (params: { index: InstalledPluginIndex }) => readonly string[] | undefined;
};

export type PluginProviderAuthAliasCandidate = {
  plugin: PluginManifestRecord;
  target: string;
  /** First eligible declaration owns public map order, even if a later candidate wins. */
  order: number;
};

export type PluginMetadataSnapshotOwnerMaps = {
  channels: ReadonlyMap<string, readonly string[]>;
  channelConfigs: ReadonlyMap<string, readonly string[]>;
  providers: ReadonlyMap<string, readonly string[]>;
  modelCatalogProviders: ReadonlyMap<string, readonly string[]>;
  cliBackends: ReadonlyMap<string, readonly string[]>;
  setupProviders: ReadonlyMap<string, readonly string[]>;
  commandAliases: ReadonlyMap<string, readonly string[]>;
  contracts: ReadonlyMap<string, readonly string[]>;
  /** Empty views must not fall through to process-current model normalization policies. */
  modelIdNormalizationPolicies: ReadonlyMap<string, PluginManifestModelIdNormalizationProvider>;
  providerAuthAliases?: ReadonlyMap<string, readonly PluginProviderAuthAliasCandidate[]>;
  providerEndpoints?: readonly PluginManifestProviderEndpoint[];
  providerRequests?: ReadonlyMap<string, PluginManifestProviderRequestProvider>;
};

type PluginMetadataSnapshotMetrics = {
  registrySnapshotMs: number;
  manifestRegistryMs: number;
  ownerMapsMs: number;
  totalMs: number;
  indexPluginCount: number;
  manifestPluginCount: number;
};

export type PluginMetadataSnapshot = {
  policyHash: string;
  configFingerprint?: string;
  pluginIds?: readonly string[];
  registrySource?: PluginRegistrySnapshotSource;
  workspaceDir?: string;
  index: InstalledPluginIndex;
  /** The original workspace-scoped index described by registrySource, before runtime unions. */
  registryIndex: InstalledPluginIndex;
  registryDiagnostics: readonly PluginRegistrySnapshotDiagnostic[];
  manifestRegistry: PluginManifestRegistry;
  /** Independently validated bundled owners, including packages shadowed by active plugins. */
  bundledManifestRegistry?: PluginManifestRegistry;
  plugins: readonly PluginManifestRecord[];
  diagnostics: readonly PluginDiagnostic[];
  byPluginId: ReadonlyMap<string, PluginManifestRecord>;
  normalizePluginId: (pluginId: string) => string;
  owners: PluginMetadataSnapshotOwnerMaps;
  metrics: PluginMetadataSnapshotMetrics;
  discovery?: PluginDiscoveryResult;
};

export type PluginMetadataRegistryView = Pick<
  PluginMetadataSnapshot,
  "index" | "manifestRegistry" | "discovery"
>;

export type PluginMetadataManifestView = Pick<PluginMetadataSnapshot, "index" | "plugins">;

export type LoadPluginMetadataSnapshotParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  index?: InstalledPluginIndex;
  pluginIds?: readonly string[];
  pluginIdScope?: PluginMetadataSnapshotPluginIdScope;
  preferPersisted?: boolean;
  allowCurrent?: boolean;
};

export type ResolvePluginMetadataSnapshotParams = LoadPluginMetadataSnapshotParams & {
  allowWorkspaceScopedCurrent?: boolean;
};
