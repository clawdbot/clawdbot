import type { ManifestModelIdNormalizationRecord } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import type { BundledStaticCatalogState } from "../agents/embedded-agent-runner/model.static-catalog.types.js";
import type { BundledChannelCatalogEntry } from "../channels/bundled-channel-catalog.types.js";
import type { ManifestChannelPlugin } from "../channels/plugins/manifest-channel-plugin.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginDiscoveryResult } from "./discovery.types.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import type { ManifestModelSuppressionResolver } from "./manifest-model-suppression.types.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

type CurrentPluginMetadataCacheState = {
  snapshot: unknown;
  owner: "gateway" | "operation";
  configFingerprint: string | undefined;
  compatiblePolicyHashes: readonly string[] | undefined;
  compatibleConfigFingerprints: readonly string[] | undefined;
  manifestModelIdNormalizationRecords: readonly ManifestModelIdNormalizationRecord[] | undefined;
  revision: symbol;
  configIdentities: WeakSet<OpenClawConfig>;
};

export type PluginCacheMetadata = {
  metadata: {
    bundledDiscoveryMode?: { value: "compat" | "allowlist" | undefined };
    current: CurrentPluginMetadataCacheState;
    snapshots: Map<string, PluginMetadataSnapshot>;
    discovery: Map<string, PluginDiscoveryResult>;
    discoveryMountPoints?: ReadonlySet<string>;
    projections: WeakMap<PluginMetadataSnapshot, Map<string, PluginMetadataSnapshot>>;
    projectionSources: WeakMap<PluginMetadataSnapshot, PluginMetadataSnapshot>;
    completions: WeakMap<PluginMetadataSnapshot, PluginMetadataSnapshot>;
    indexFingerprints: WeakMap<InstalledPluginIndex, string>;
    channelAdapters: WeakMap<PluginManifestRecord, Map<string, ManifestChannelPlugin | undefined>>;
    bundledChannelCatalogs: Map<string, BundledChannelCatalogEntry[]>;
    staticCatalogStates: WeakMap<object, WeakMap<OpenClawConfig, BundledStaticCatalogState>>;
    modelSuppressionResolvers: WeakMap<
      PluginMetadataSnapshot,
      {
        unconfigured?: ManifestModelSuppressionResolver;
        byConfig: WeakMap<OpenClawConfig, ManifestModelSuppressionResolver>;
      }
    >;
  };
};

export function createPluginCacheMetadata(): PluginCacheMetadata {
  return {
    metadata: {
      current: {
        snapshot: undefined,
        owner: "operation",
        configFingerprint: undefined,
        compatiblePolicyHashes: undefined,
        compatibleConfigFingerprints: undefined,
        manifestModelIdNormalizationRecords: undefined,
        revision: Symbol("plugin-metadata-snapshot"),
        configIdentities: new WeakSet(),
      },
      snapshots: new Map(),
      discovery: new Map(),
      projections: new WeakMap(),
      projectionSources: new WeakMap(),
      completions: new WeakMap(),
      indexFingerprints: new WeakMap(),
      channelAdapters: new WeakMap(),
      bundledChannelCatalogs: new Map(),
      staticCatalogStates: new WeakMap(),
      modelSuppressionResolvers: new WeakMap(),
    },
  };
}
