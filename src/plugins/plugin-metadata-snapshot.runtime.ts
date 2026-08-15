/**
 * Lazy bridge for plugin metadata snapshot reads. The snapshot modules pull
 * the control-plane context (installed-plugin index/kysely), which light
 * shared modules and doctor closures must not cold-load at import time.
 *
 * The snapshot module registers its reader here at eval time, so any process
 * that published or scoped a snapshot serves reads through the registered
 * instance. The require fallback only covers cold processes that never loaded
 * the metadata system (built code loads .js; source/jiti paths resolve .ts).
 */
import { createRequire } from "node:module";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type CurrentSnapshotModule = Pick<
  typeof import("./current-plugin-metadata-snapshot.js"),
  "getCurrentPluginMetadataSnapshot"
>;
type SnapshotLoaderModule = Pick<
  typeof import("./plugin-metadata-snapshot.js"),
  "resolvePluginMetadataSnapshot"
>;

type SnapshotReaderSlot = {
  getCurrentPluginMetadataSnapshot?: CurrentSnapshotModule["getCurrentPluginMetadataSnapshot"];
  resolvePluginMetadataSnapshot?: SnapshotLoaderModule["resolvePluginMetadataSnapshot"];
};

// globalThis-keyed so a require-loaded second module instance shares the slot.
const snapshotReaderSlot = resolveGlobalSingleton<SnapshotReaderSlot>(
  Symbol.for("openclaw.pluginMetadataSnapshotReaders"),
  () => ({}),
);

/** Called by the snapshot modules at eval time; last registration wins. */
export function registerPluginMetadataSnapshotReaders(readers: SnapshotReaderSlot): void {
  Object.assign(snapshotReaderSlot, readers);
}

const require = createRequire(import.meta.url);

function createModuleLoader(candidates: readonly string[]): () => unknown {
  let loaded: unknown;
  let attempted = false;
  return () => {
    if (loaded) {
      return loaded;
    }
    if (attempted) {
      return null;
    }
    attempted = true;
    for (const candidate of candidates) {
      try {
        loaded = require(candidate);
        return loaded;
      } catch {
        // Try source/runtime candidates in order.
      }
    }
    return null;
  };
}

const loadCurrentSnapshotModule = createModuleLoader([
  "./current-plugin-metadata-snapshot.js",
  "./current-plugin-metadata-snapshot.ts",
]) as () => CurrentSnapshotModule | null;
const loadSnapshotLoaderModule = createModuleLoader([
  "./plugin-metadata-snapshot.js",
  "./plugin-metadata-snapshot.ts",
]) as () => SnapshotLoaderModule | null;

/** Reads the current plugin metadata snapshot, loading the snapshot graph lazily. */
export function getCurrentPluginMetadataSnapshotRuntime(
  params: Parameters<CurrentSnapshotModule["getCurrentPluginMetadataSnapshot"]>[0],
): ReturnType<CurrentSnapshotModule["getCurrentPluginMetadataSnapshot"]> {
  const reader =
    snapshotReaderSlot.getCurrentPluginMetadataSnapshot ??
    loadCurrentSnapshotModule()?.getCurrentPluginMetadataSnapshot;
  return reader?.(params) ?? undefined;
}

/**
 * Resolves a plugin metadata snapshot, or undefined when the metadata system
 * is unavailable (cold test workers without a CJS TS hook); callers treat that
 * as "no manifest policies exist".
 */
export function resolvePluginMetadataSnapshotRuntime(
  params: Parameters<SnapshotLoaderModule["resolvePluginMetadataSnapshot"]>[0],
): ReturnType<SnapshotLoaderModule["resolvePluginMetadataSnapshot"]> | undefined {
  const resolver =
    snapshotReaderSlot.resolvePluginMetadataSnapshot ??
    loadSnapshotLoaderModule()?.resolvePluginMetadataSnapshot;
  return resolver?.(params);
}
