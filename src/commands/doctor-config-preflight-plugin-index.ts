import { isDeepStrictEqual } from "node:util";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadInstalledPluginIndexStore = createLazyRuntimeModule(
  () => import("../plugins/installed-plugin-index-store.js"),
);

export type DoctorConfigPreflightPluginSnapshotRead = {
  snapshot: ConfigFileSnapshot;
  pluginMigrationFingerprint: string | null;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

type MeasurePreflightStep = <T>(name: string, run: () => T | Promise<T>) => Promise<T>;

function throwPluginRegistryPersistenceFailed(reason: string): never {
  throw new Error(
    `OpenClaw refreshed the plugin registry but could not verify the persisted replacement (${reason}); refusing to write the migration checkpoint. Run "openclaw doctor --fix" and retry.`,
  );
}

export function needsRefreshedPluginIndexPersistence(
  snapshotRead: DoctorConfigPreflightPluginSnapshotRead,
): boolean {
  return snapshotRead.pluginMetadataSnapshot?.registrySource === "derived";
}

export async function persistRefreshedPluginIndex(params: {
  env: NodeJS.ProcessEnv;
  measure: MeasurePreflightStep;
  readSnapshot: () => Promise<DoctorConfigPreflightPluginSnapshotRead>;
  snapshotRead: DoctorConfigPreflightPluginSnapshotRead;
}): Promise<DoctorConfigPreflightPluginSnapshotRead> {
  const derivedPluginMetadataSnapshot = params.snapshotRead.pluginMetadataSnapshot;
  if (!derivedPluginMetadataSnapshot || !params.snapshotRead.pluginMigrationFingerprint) {
    throwPluginRegistryPersistenceFailed("derived metadata was incomplete");
  }
  const { writePersistedInstalledPluginIndexSync } = await params.measure(
    "plugin-index-store-import",
    loadInstalledPluginIndexStore,
  );
  // The checkpoint certifies the persisted inventory, not a process-local replacement.
  // Write the exact derived index first, then prove a fresh reader can reuse it.
  await params.measure("plugin-index-persistence", () =>
    writePersistedInstalledPluginIndexSync(derivedPluginMetadataSnapshot.index, {
      env: params.env,
    }),
  );
  const persistedSnapshotRead = await params.readSnapshot();
  const persistedPluginMetadataSnapshot = persistedSnapshotRead.pluginMetadataSnapshot;
  if (
    persistedPluginMetadataSnapshot?.registrySource !== "persisted" ||
    !isDeepStrictEqual(persistedPluginMetadataSnapshot.index, derivedPluginMetadataSnapshot.index)
  ) {
    throwPluginRegistryPersistenceFailed(
      `reread source was ${persistedPluginMetadataSnapshot?.registrySource ?? "missing"} or the persisted plugin inventory changed`,
    );
  }
  return persistedSnapshotRead;
}
