import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";

export type PluginMetadataSnapshotOwnerMaps = {
  channels: ReadonlyMap<string, readonly string[]>;
  channelConfigs: ReadonlyMap<string, readonly string[]>;
  providers: ReadonlyMap<string, readonly string[]>;
  modelCatalogProviders: ReadonlyMap<string, readonly string[]>;
  cliBackends: ReadonlyMap<string, readonly string[]>;
  setupProviders: ReadonlyMap<string, readonly string[]>;
  commandAliases: ReadonlyMap<string, readonly string[]>;
  contracts: ReadonlyMap<string, readonly string[]>;
};

export type PluginMetadataSnapshotMetrics = {
  registrySnapshotMs: number;
  manifestRegistryMs: number;
  ownerMapsMs: number;
  totalMs: number;
  indexPluginCount: number;
  manifestPluginCount: number;
};

export type PluginMetadataSnapshotRegistryDiagnostic = {
  level: "info" | "warn";
  code:
    | "persisted-registry-disabled"
    | "persisted-registry-missing"
    | "persisted-registry-stale-policy"
    | "persisted-registry-stale-source";
  message: string;
};

export type PluginMetadataSnapshot = {
  policyHash: string;
  configFingerprint?: string;
  workspaceDir?: string;
  index: InstalledPluginIndex;
  registryDiagnostics: readonly PluginMetadataSnapshotRegistryDiagnostic[];
  manifestRegistry: PluginManifestRegistry;
  plugins: readonly PluginManifestRecord[];
  diagnostics: readonly PluginDiagnostic[];
  byPluginId: ReadonlyMap<string, PluginManifestRecord>;
  normalizePluginId: (pluginId: string) => string;
  owners: PluginMetadataSnapshotOwnerMaps;
  metrics: PluginMetadataSnapshotMetrics;
};

export type PluginMetadataRegistryView = Pick<PluginMetadataSnapshot, "index" | "manifestRegistry">;

export type PluginMetadataManifestView = Pick<PluginMetadataSnapshot, "index" | "plugins">;

export type LoadPluginMetadataSnapshotParams = {
  config: OpenClawConfig;
  workspaceDir?: string;
  stateDir?: string;
  env: NodeJS.ProcessEnv;
  index?: InstalledPluginIndex;
  preferPersisted?: boolean;
};
