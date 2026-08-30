import { adoptCurrentPluginMetadataSnapshotIfAbsent } from "./current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

/** Replaces a test fixture through the operation lifecycle's clear and adopt boundaries. */
export function setCurrentPluginMetadataSnapshot(
  snapshot: PluginMetadataSnapshot | undefined,
  options?: Parameters<typeof adoptCurrentPluginMetadataSnapshotIfAbsent>[1],
): void {
  clearCurrentPluginMetadataSnapshot();
  if (snapshot) {
    adoptCurrentPluginMetadataSnapshotIfAbsent(snapshot, options);
  }
}
