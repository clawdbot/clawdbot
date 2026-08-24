// Stores active plugin channel registry state for the current runtime.
import type { ActivePluginChannelRegistry } from "./channel-registry-state.types.js";
import { PLUGIN_REGISTRY_STATE } from "./runtime-state-key.js";

type GlobalChannelRegistryState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: {
    activeVersion?: number;
    activeRegistry?: ActivePluginChannelRegistry | null;
  };
};

type GlobalChannelRegistryRuntimeState = GlobalChannelRegistryState[typeof PLUGIN_REGISTRY_STATE];

export type ActivePluginChannelRegistrySnapshot = {
  registry: ActivePluginChannelRegistry | null;
  version: number;
};

let activePluginChannelRegistrySnapshot: ActivePluginChannelRegistrySnapshot | undefined;

/** Returns a snapshot of the process-root plugin registry. */
export function getActivePluginChannelRegistrySnapshotFromState(): ActivePluginChannelRegistrySnapshot {
  const state: GlobalChannelRegistryRuntimeState = (globalThis as GlobalChannelRegistryState)[
    PLUGIN_REGISTRY_STATE
  ];
  const registry = state?.activeRegistry ?? null;
  const version = state?.activeVersion ?? 0;
  const cached = activePluginChannelRegistrySnapshot;
  if (cached && cached.registry === registry && cached.version === version) {
    return cached;
  }
  const snapshot = { registry, version };
  activePluginChannelRegistrySnapshot = snapshot;
  return snapshot;
}

/** Returns the active plugin channel registry from global runtime state. */
export function getActivePluginChannelRegistryFromState(): ActivePluginChannelRegistry | null {
  return getActivePluginChannelRegistrySnapshotFromState().registry;
}

/** Returns the active plugin channel registry version from global runtime state. */
export function getActivePluginChannelRegistryVersionFromState(): number {
  return getActivePluginChannelRegistrySnapshotFromState().version;
}
