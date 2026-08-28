import {
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
  type ConfigSnapshotReadMeasure,
} from "../config/io.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { StartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { addDoctorLegacyIssues } from "./doctor/shared/legacy-config-issues.js";
import { completeDoctorPluginMetadataSnapshot } from "./doctor/shared/plugin-metadata-snapshot-scope.js";

const loadInstalledPluginIndexStoreWrite = createLazyRuntimeModule(
  () => import("../plugins/installed-plugin-index-store-write.js"),
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

export async function readDoctorConfigPreflightSnapshot(params: {
  allowCurrentPluginMetadata: boolean;
  includePluginMetadata: boolean;
  measure?: ConfigSnapshotReadMeasure;
  observe?: boolean;
  preparePluginMetadataSnapshot: boolean;
  skipPluginValidation: boolean;
}): Promise<DoctorConfigPreflightPluginSnapshotRead> {
  const sharedOptions = {
    ...(params.observe === false ? { observe: false } : {}),
    ...(params.measure ? { measure: params.measure } : {}),
    ...(params.allowCurrentPluginMetadata ? {} : { allowCurrentPluginMetadata: false }),
  };
  if (params.includePluginMetadata && !params.skipPluginValidation) {
    const result = await readConfigFileSnapshotWithPluginMetadata(sharedOptions);
    const pluginMetadataSnapshot = params.preparePluginMetadataSnapshot
      ? completeDoctorPluginMetadataSnapshot({
          snapshot: result.pluginMetadataSnapshot,
          config: result.snapshot.sourceConfig ?? result.snapshot.config ?? {},
        })
      : result.pluginMetadataSnapshot;
    return {
      snapshot: addDoctorLegacyIssues(result.snapshot, pluginMetadataSnapshot),
      pluginMigrationFingerprint: pluginMetadataSnapshot?.configFingerprint?.trim() || null,
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    };
  }
  return {
    snapshot: addDoctorLegacyIssues(
      await readConfigFileSnapshot({
        ...sharedOptions,
        skipPluginValidation: params.skipPluginValidation,
      }),
    ),
    pluginMigrationFingerprint: null,
  };
}

export function needsRefreshedPluginIndexPersistence(
  snapshotRead: DoctorConfigPreflightPluginSnapshotRead,
): boolean {
  return snapshotRead.pluginMetadataSnapshot?.registrySource === "derived";
}

export async function persistRefreshedPluginIndex(params: {
  env: NodeJS.ProcessEnv;
  measure: MeasurePreflightStep;
  readPersistedSnapshot: () => Promise<DoctorConfigPreflightPluginSnapshotRead>;
  snapshotRead: DoctorConfigPreflightPluginSnapshotRead;
  lease: StartupMigrationLease | undefined;
}): Promise<DoctorConfigPreflightPluginSnapshotRead> {
  const derivedPluginMetadataSnapshot = params.snapshotRead.pluginMetadataSnapshot;
  if (!derivedPluginMetadataSnapshot || !params.snapshotRead.pluginMigrationFingerprint) {
    throwPluginRegistryPersistenceFailed("derived metadata was incomplete");
  }
  const lease = params.lease;
  if (!lease) {
    throwPluginRegistryPersistenceFailed("startup migration lease was not acquired");
  }
  const { writePersistedInstalledPluginIndexWithLeaseSync } = await params.measure(
    "plugin-index-store-import",
    loadInstalledPluginIndexStoreWrite,
  );
  // The checkpoint certifies the persisted inventory, not a process-local replacement.
  // Write the exact derived index first, then prove a fresh reader can reuse it.
  await params.measure("plugin-index-persistence", () =>
    writePersistedInstalledPluginIndexWithLeaseSync(derivedPluginMetadataSnapshot.index, {
      env: params.env,
      lease,
    }),
  );
  const persistedSnapshotRead = await params.readPersistedSnapshot();
  const persistedPluginMetadataSnapshot = persistedSnapshotRead.pluginMetadataSnapshot;
  // The registry selector owns freshness and returns "persisted" only after accepting the
  // durable index. Persisted parsing intentionally canonicalizes non-runtime package metadata.
  if (persistedPluginMetadataSnapshot?.registrySource !== "persisted") {
    const diagnosticCodes = persistedPluginMetadataSnapshot?.registryDiagnostics.map(
      (diagnostic) => diagnostic.code,
    );
    throwPluginRegistryPersistenceFailed(
      `reread source was ${persistedPluginMetadataSnapshot?.registrySource ?? "missing"}${
        diagnosticCodes?.length ? `; diagnostics: ${diagnosticCodes.join(", ")}` : ""
      }`,
    );
  }
  return persistedSnapshotRead;
}
