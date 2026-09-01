// Holds current plugin metadata snapshots for process-scoped consumers.
import { setCurrentManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginCache, getProcessPluginCache } from "./plugin-cache.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

export type CurrentPluginMetadataSnapshotRevision = symbol;

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
  modelIdNormalizationPolicies?: PluginMetadataSnapshot["owners"]["modelIdNormalizationPolicies"],
  owner: "gateway" | "operation" = "operation",
): CurrentPluginMetadataSnapshotRevision {
  const state = getProcessPluginCache().metadata.current;
  state.snapshot = snapshot;
  state.owner = owner;
  state.configFingerprint = snapshot ? configFingerprint : undefined;
  state.compatiblePolicyHashes = snapshot ? compatiblePolicyHashes : undefined;
  state.compatibleConfigFingerprints = snapshot ? compatibleConfigFingerprints : undefined;
  state.modelIdNormalizationPolicies = snapshot ? modelIdNormalizationPolicies : undefined;
  setCurrentManifestModelIdNormalizationPolicies(state.modelIdNormalizationPolicies);
  state.revision = Symbol("plugin-metadata-snapshot");
  return state.revision;
}

/** Clears the process-current plugin metadata snapshot. */
function clearCurrentPluginMetadataSnapshotState(): CurrentPluginMetadataSnapshotRevision {
  const state = getProcessPluginCache().metadata.current;
  state.snapshot = undefined;
  state.owner = "operation";
  state.configFingerprint = undefined;
  state.compatiblePolicyHashes = undefined;
  state.compatibleConfigFingerprints = undefined;
  state.modelIdNormalizationPolicies = undefined;
  setCurrentManifestModelIdNormalizationPolicies(undefined);
  state.revision = Symbol("plugin-metadata-snapshot");
  return state.revision;
}

/** Clears the snapshot, its identity cache, and process-wide model normalization. */
export function clearCurrentPluginMetadataSnapshot(): void {
  currentPluginMetadataConfigIdentityCache.clear();
  clearCurrentPluginMetadataSnapshotState();
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

/** Captures the current snapshot and the policies eligible for process-wide publication. */
export function getCurrentPluginMetadataSnapshotState() {
  const state = getProcessPluginCache().metadata.current;
  return {
    snapshot: state.snapshot,
    owner: state.owner,
    configFingerprint: state.configFingerprint,
    compatiblePolicyHashes: state.compatiblePolicyHashes,
    compatibleConfigFingerprints: state.compatibleConfigFingerprints,
    modelIdNormalizationPolicies: state.modelIdNormalizationPolicies,
    revision: state.revision,
  };
}
