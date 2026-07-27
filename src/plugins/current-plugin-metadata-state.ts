// Holds current plugin metadata snapshots for process-scoped consumers.
import { setCurrentManifestModelIdNormalizationRecords } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";

let currentPluginMetadataSnapshot: unknown;
let currentPluginMetadataSnapshotConfigFingerprint: string | undefined;
let currentPluginMetadataSnapshotCompatiblePolicyHashes: readonly string[] | undefined;
let currentPluginMetadataSnapshotCompatibleConfigFingerprints: readonly string[] | undefined;
let currentPluginMetadataConfigIdentities = new WeakSet<OpenClawConfig>();

/** Owns config identity reuse for the current immutable metadata snapshot. */
export const currentPluginMetadataConfigIdentityCache = {
  add(config: OpenClawConfig): void {
    currentPluginMetadataConfigIdentities.add(config);
  },
  clear(): void {
    currentPluginMetadataConfigIdentities = new WeakSet();
  },
  has(config: OpenClawConfig): boolean {
    return currentPluginMetadataConfigIdentities.has(config);
  },
};

/** Stores the process-current plugin metadata snapshot and compatible config fingerprints. */
export function setCurrentPluginMetadataSnapshotState(
  snapshot: unknown,
  configFingerprint: string | undefined,
  compatiblePolicyHashes?: readonly string[],
  compatibleConfigFingerprints?: readonly string[],
): void {
  currentPluginMetadataSnapshot = snapshot;
  currentPluginMetadataSnapshotConfigFingerprint = snapshot ? configFingerprint : undefined;
  currentPluginMetadataSnapshotCompatiblePolicyHashes = snapshot
    ? compatiblePolicyHashes
    : undefined;
  currentPluginMetadataSnapshotCompatibleConfigFingerprints = snapshot
    ? compatibleConfigFingerprints
    : undefined;
}

/** Clears the process-current plugin metadata snapshot. */
function clearCurrentPluginMetadataSnapshotState(): void {
  currentPluginMetadataSnapshot = undefined;
  currentPluginMetadataSnapshotConfigFingerprint = undefined;
  currentPluginMetadataSnapshotCompatiblePolicyHashes = undefined;
  currentPluginMetadataSnapshotCompatibleConfigFingerprints = undefined;
}

/** Clears the snapshot, its identity cache, and process-wide model normalization. */
export function clearCurrentPluginMetadataSnapshot(): void {
  currentPluginMetadataConfigIdentityCache.clear();
  setCurrentManifestModelIdNormalizationRecords(undefined);
  clearCurrentPluginMetadataSnapshotState();
}

/** Returns the process-current plugin metadata snapshot state. */
export function getCurrentPluginMetadataSnapshotState(): {
  snapshot: unknown;
  configFingerprint: string | undefined;
  compatiblePolicyHashes: readonly string[] | undefined;
  compatibleConfigFingerprints: readonly string[] | undefined;
} {
  return {
    snapshot: currentPluginMetadataSnapshot,
    configFingerprint: currentPluginMetadataSnapshotConfigFingerprint,
    compatiblePolicyHashes: currentPluginMetadataSnapshotCompatiblePolicyHashes,
    compatibleConfigFingerprints: currentPluginMetadataSnapshotCompatibleConfigFingerprints,
  };
}
