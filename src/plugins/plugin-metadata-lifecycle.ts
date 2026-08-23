/** Coordinates plugin metadata snapshot and process memo cache lifecycle resets. */
import { clearCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";

const pluginMetadataProcessMemoClears = new Set<() => void>();

/** Registers a process-local plugin metadata memo clear hook. */
export function registerPluginMetadataProcessMemoLifecycleClear(
  clearProcessMemo: () => void,
): void {
  pluginMetadataProcessMemoClears.add(clearProcessMemo);
}

/** Clears plugin metadata snapshots and registered process memo caches. */
export function clearPluginMetadataLifecycleCaches(): void {
  clearCurrentPluginMetadataSnapshot();
  for (const clearProcessMemo of pluginMetadataProcessMemoClears) {
    clearProcessMemo();
  }
}
