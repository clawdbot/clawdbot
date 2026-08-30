// Holds current plugin metadata snapshots for process-scoped consumers.
import {
  setCurrentManifestModelIdNormalizationRecords,
  type ManifestModelIdNormalizationRecord,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getPluginCache,
  getProcessPluginCache,
  getScopedPluginMetadataCollection,
  type PluginCache,
} from "./plugin-cache.js";
import type { PluginMetadataOwner } from "./plugin-metadata-collection.types.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

export type CurrentPluginMetadataSnapshotRevision = symbol;

export function getCurrentPluginMetadataOwner(): PluginMetadataOwner | undefined {
  return getPluginCache().metadata.collectionOwner;
}

export function getCurrentPluginChannelCatalog() {
  return (
    getScopedPluginMetadataCollection()?.channelCatalog ??
    getCurrentPluginMetadataOwner()?.getActive()?.channelCatalog
  );
}

/** Owns config identity reuse for the current immutable metadata snapshot. */
export const currentPluginMetadataConfigIdentityCache = {
  add(config: OpenClawConfig): void {
    getProcessPluginCache().metadata.current.configIdentities.add(config);
  },
  capture(): WeakSet<OpenClawConfig> {
    return getProcessPluginCache().metadata.current.configIdentities;
  },
  clear(): void {
    getProcessPluginCache().metadata.current.configIdentities = new WeakSet();
  },
  has(config: OpenClawConfig): boolean {
    return getProcessPluginCache().metadata.current.configIdentities.has(config);
  },
  restore(identities: WeakSet<OpenClawConfig>): void {
    getProcessPluginCache().metadata.current.configIdentities = identities;
  },
};

/** Stores the process-current plugin metadata snapshot and compatible config fingerprints. */
export function setCurrentPluginMetadataSnapshotState(
  snapshot: unknown,
  configFingerprint: string | undefined,
  compatiblePolicyHashes?: readonly string[],
  compatibleConfigFingerprints?: readonly string[],
  manifestModelIdNormalizationRecords?: readonly ManifestModelIdNormalizationRecord[],
  owner: "gateway" | "operation" = "operation",
  envFingerprint?: string,
  defaultDiscoveryCompatible = false,
): CurrentPluginMetadataSnapshotRevision {
  const state = getProcessPluginCache().metadata.current;
  state.snapshot = snapshot;
  state.owner = owner;
  state.configFingerprint = snapshot ? configFingerprint : undefined;
  state.envFingerprint = snapshot ? envFingerprint : undefined;
  state.defaultDiscoveryCompatible = Boolean(snapshot && defaultDiscoveryCompatible);
  state.compatiblePolicyHashes = snapshot ? compatiblePolicyHashes : undefined;
  state.compatibleConfigFingerprints = snapshot ? compatibleConfigFingerprints : undefined;
  state.manifestModelIdNormalizationRecords = snapshot
    ? manifestModelIdNormalizationRecords
    : undefined;
  setCurrentManifestModelIdNormalizationRecords(state.manifestModelIdNormalizationRecords);
  state.revision = Symbol("plugin-metadata-snapshot");
  return state.revision;
}

/** Clears the snapshot, its identity cache, and process-wide model normalization. */
export function clearCurrentPluginMetadataSnapshot(): void {
  currentPluginMetadataConfigIdentityCache.clear();
  setCurrentPluginMetadataSnapshotState(undefined, undefined);
}

/** Install-ledger writes cannot retire metadata owned by a running Gateway. */
export function isGatewayPluginMetadataSnapshotActive(): boolean {
  const state = getProcessPluginCache().metadata.current;
  return state.owner === "gateway" && state.snapshot !== undefined;
}

/** Reads the boot inventory without importing discovery into lightweight consumers. */
export function getGatewayPluginMetadataSnapshot(): PluginMetadataSnapshot | undefined {
  const cache = getPluginCache();
  if (cache.kind === "process" && cache.metadata.current.owner === "gateway") {
    // SAFETY: Gateway publication stores the complete typed snapshot in its owning generation.
    return cache.metadata.current.snapshot as PluginMetadataSnapshot | undefined;
  }
  return undefined;
}

/** Management compares a fresh candidate with boot state without making boot its read context. */
export function getProcessGatewayPluginMetadataSnapshot(): PluginMetadataSnapshot | undefined {
  if (isGatewayPluginMetadataSnapshotActive()) {
    // SAFETY: Production Gateway publication accepts only a complete typed snapshot.
    return getProcessPluginCache().metadata.current.snapshot as PluginMetadataSnapshot;
  }
  return undefined;
}

/** Returns the process-current plugin metadata snapshot state. */
export function getCurrentPluginMetadataSnapshotState(): Omit<
  PluginCache["metadata"]["current"],
  "configIdentities"
> {
  const { configIdentities: _configIdentities, ...state } =
    getProcessPluginCache().metadata.current;
  return state;
}
