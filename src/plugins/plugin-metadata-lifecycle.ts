/** Coordinates plugin metadata snapshot and process memo cache lifecycle resets. */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  clearCurrentPluginMetadataSnapshot,
  isGatewayPluginMetadataSnapshotActive,
} from "./current-plugin-metadata-state.js";
import { resetPluginCache } from "./plugin-cache.js";

const pluginMetadataProcessMemoClears = new Set<() => void>();
const gatewayMetadataOwners = resolveGlobalSingleton<Set<symbol>>(
  Symbol.for("openclaw.gatewayPluginMetadataOwners"),
  () => new Set(),
);

/** Keeps shared boot metadata alive through every kernel's startup and shutdown. */
export function retainGatewayPluginMetadata(): () => void {
  const owner = Symbol("gateway-plugin-metadata-owner");
  gatewayMetadataOwners.add(owner);
  return () => {
    if (gatewayMetadataOwners.delete(owner) && gatewayMetadataOwners.size === 0) {
      clearPluginMetadataLifecycleCaches();
    }
  };
}

/** Registers a process-local plugin metadata memo clear hook. */
export function registerPluginMetadataProcessMemoLifecycleClear(
  clearProcessMemo: () => void,
): void {
  pluginMetadataProcessMemoClears.add(clearProcessMemo);
}

/** Clears plugin metadata snapshots and registered process memo caches. */
export function clearPluginMetadataLifecycleCaches(): void {
  // Installs and a sibling Gateway's teardown cannot retire a running inventory.
  // Pre-publication planning remains refreshable until boot metadata is pinned.
  if (gatewayMetadataOwners.size > 0 && isGatewayPluginMetadataSnapshotActive()) {
    return;
  }
  clearCurrentPluginMetadataSnapshot();
  resetPluginCache();
  for (const clearProcessMemo of pluginMetadataProcessMemoClears) {
    clearProcessMemo();
  }
}
