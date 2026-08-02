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

/** Returns a snapshot of the process-root plugin registry. */
export function getActivePluginChannelRegistrySnapshotFromState(): ActivePluginChannelRegistrySnapshot {
  const state: GlobalChannelRegistryRuntimeState = (globalThis as GlobalChannelRegistryState)[
    PLUGIN_REGISTRY_STATE
  ];
  return {
    registry: state?.activeRegistry ?? null,
    version: state?.activeVersion ?? 0,
  };
}

/** Returns the active plugin channel registry from global runtime state. */
export function getActivePluginChannelRegistryFromState(): ActivePluginChannelRegistry | null {
  return getActivePluginChannelRegistrySnapshotFromState().registry;
}

/** Returns the active plugin channel registry version from global runtime state. */
export function getActivePluginChannelRegistryVersionFromState(): number {
  return getActivePluginChannelRegistrySnapshotFromState().version;
}
