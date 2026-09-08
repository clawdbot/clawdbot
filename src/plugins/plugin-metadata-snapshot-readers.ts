// Shares the canonical metadata owner functions across source and built module graphs.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type CurrentSnapshotModule = Pick<
  typeof import("./current-plugin-metadata-snapshot.js"),
  "adoptCurrentPluginMetadataSnapshotIfAbsent" | "getCurrentPluginMetadataSnapshot"
>;
export type SnapshotLoaderModule = Pick<
  typeof import("./plugin-metadata-snapshot.js"),
  "resolvePluginMetadataSnapshot" | "loadPluginMetadataSnapshot"
>;

type SnapshotReaderSlot = {
  adoptCurrentPluginMetadataSnapshotIfAbsent?: CurrentSnapshotModule["adoptCurrentPluginMetadataSnapshotIfAbsent"];
  getCurrentPluginMetadataSnapshot?: CurrentSnapshotModule["getCurrentPluginMetadataSnapshot"];
  resolvePluginMetadataSnapshot?: SnapshotLoaderModule["resolvePluginMetadataSnapshot"];
  loadPluginMetadataSnapshot?: SnapshotLoaderModule["loadPluginMetadataSnapshot"];
};

// globalThis-keyed so a require-loaded second module instance shares the slot.
export const snapshotReaderSlot = resolveGlobalSingleton<SnapshotReaderSlot>(
  Symbol.for("openclaw.pluginMetadataSnapshotReaders"),
  () => ({}),
);

/** Called by the snapshot modules at eval time; last registration wins. */
export function registerPluginMetadataSnapshotReaders(readers: SnapshotReaderSlot): void {
  Object.assign(snapshotReaderSlot, readers);
}
