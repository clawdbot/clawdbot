// Holds current plugin metadata snapshots for process-scoped consumers.
import {
  setCurrentManifestModelIdNormalizationRecords,
  type ManifestModelIdNormalizationRecord,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";

let currentPluginMetadataSnapshot: unknown;
let currentPluginMetadataSnapshotConfigFingerprint: string | undefined;
let currentPluginMetadataSnapshotCompatiblePolicyHashes: readonly string[] | undefined;
let currentPluginMetadataSnapshotCompatibleConfigFingerprints: readonly string[] | undefined;
let currentManifestModelIdNormalizationRecords:
  | readonly ManifestModelIdNormalizationRecord[]
  | undefined;
// Temporary snapshot owners compare this publication token before restoring;
// lifecycle clears and newer publications must always win.
let currentPluginMetadataSnapshotRevision = Symbol("plugin-metadata-snapshot");
let currentPluginMetadataConfigIdentities = new WeakSet<OpenClawConfig>();

export type CurrentPluginMetadataSnapshotRevision = typeof currentPluginMetadataSnapshotRevision;

/** Owns config identity reuse for the current immutable metadata snapshot. */
export const currentPluginMetadataConfigIdentityCache = {
  add(config: OpenClawConfig): void {
    currentPluginMetadataConfigIdentities.add(config);
  },
  capture(): WeakSet<OpenClawConfig> {
    return currentPluginMetadataConfigIdentities;
  },
  clear(): void {
    currentPluginMetadataConfigIdentities = new WeakSet();
  },
  has(config: OpenClawConfig): boolean {
    return currentPluginMetadataConfigIdentities.has(config);
  },
  restore(identities: WeakSet<OpenClawConfig>): void {
    currentPluginMetadataConfigIdentities = identities;
  },
};

/** Stores the process-current plugin metadata snapshot and compatible config fingerprints. */
export function setCurrentPluginMetadataSnapshotState(
  snapshot: unknown,
  configFingerprint: string | undefined,
  compatiblePolicyHashes?: readonly string[],
  compatibleConfigFingerprints?: readonly string[],
  manifestModelIdNormalizationRecords?: readonly ManifestModelIdNormalizationRecord[],
): CurrentPluginMetadataSnapshotRevision {
  currentPluginMetadataSnapshot = snapshot;
  currentPluginMetadataSnapshotConfigFingerprint = snapshot ? configFingerprint : undefined;
  currentPluginMetadataSnapshotCompatiblePolicyHashes = snapshot
    ? compatiblePolicyHashes
    : undefined;
  currentPluginMetadataSnapshotCompatibleConfigFingerprints = snapshot
    ? compatibleConfigFingerprints
    : undefined;
  currentManifestModelIdNormalizationRecords = snapshot
    ? manifestModelIdNormalizationRecords
    : undefined;
  setCurrentManifestModelIdNormalizationRecords(currentManifestModelIdNormalizationRecords);
  currentPluginMetadataSnapshotRevision = Symbol("plugin-metadata-snapshot");
  return currentPluginMetadataSnapshotRevision;
}

/** Clears the process-current plugin metadata snapshot. */
function clearCurrentPluginMetadataSnapshotState(): CurrentPluginMetadataSnapshotRevision {
  currentPluginMetadataSnapshot = undefined;
  currentPluginMetadataSnapshotConfigFingerprint = undefined;
  currentPluginMetadataSnapshotCompatiblePolicyHashes = undefined;
  currentPluginMetadataSnapshotCompatibleConfigFingerprints = undefined;
  currentManifestModelIdNormalizationRecords = undefined;
  setCurrentManifestModelIdNormalizationRecords(undefined);
  currentPluginMetadataSnapshotRevision = Symbol("plugin-metadata-snapshot");
  return currentPluginMetadataSnapshotRevision;
}

/** Clears the snapshot, its identity cache, and process-wide model normalization. */
export function clearCurrentPluginMetadataSnapshot(): void {
  currentPluginMetadataConfigIdentityCache.clear();
  clearCurrentPluginMetadataSnapshotState();
}

/** Returns the process-current plugin metadata snapshot state. */
export function getCurrentPluginMetadataSnapshotState(): {
  snapshot: unknown;
  configFingerprint: string | undefined;
  compatiblePolicyHashes: readonly string[] | undefined;
  compatibleConfigFingerprints: readonly string[] | undefined;
  manifestModelIdNormalizationRecords: readonly ManifestModelIdNormalizationRecord[] | undefined;
  revision: CurrentPluginMetadataSnapshotRevision;
} {
  return {
    snapshot: currentPluginMetadataSnapshot,
    configFingerprint: currentPluginMetadataSnapshotConfigFingerprint,
    compatiblePolicyHashes: currentPluginMetadataSnapshotCompatiblePolicyHashes,
    compatibleConfigFingerprints: currentPluginMetadataSnapshotCompatibleConfigFingerprints,
    manifestModelIdNormalizationRecords: currentManifestModelIdNormalizationRecords,
    revision: currentPluginMetadataSnapshotRevision,
  };
}
