import {
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
  type ConfigSnapshotReadMeasure,
} from "../config/io.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { StartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import type {
  PluginMetadataOwner,
  PreparedPluginMetadata,
} from "../plugins/plugin-metadata-collection.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { addDoctorLegacyIssues } from "./doctor/shared/legacy-config-issues.js";

const loadInstalledPluginIndexStoreWrite = createLazyRuntimeModule(
  () => import("../plugins/installed-plugin-index-store-write.js"),
);

export type DoctorConfigPreflightPluginSnapshotRead = {
  snapshot: ConfigFileSnapshot;
  pluginMigrationFingerprint: string | null;
  pluginMetadata?: PreparedPluginMetadata;
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
  pluginMetadataOwner: PluginMetadataOwner;
  skipPluginValidation: boolean;
}): Promise<DoctorConfigPreflightPluginSnapshotRead> {
  const sharedOptions = {
    pluginMetadataOwner: params.pluginMetadataOwner,
    ...(params.observe === false ? { observe: false } : {}),
    ...(params.measure ? { measure: params.measure } : {}),
    ...(params.allowCurrentPluginMetadata ? {} : { allowCurrentPluginMetadata: false }),
  };
  if (params.includePluginMetadata && !params.skipPluginValidation) {
    const result = await readConfigFileSnapshotWithPluginMetadata(sharedOptions);
    const pluginMetadata = result.pluginMetadata;
    return {
      snapshot: addDoctorLegacyIssues(result.snapshot, pluginMetadata),
      pluginMigrationFingerprint:
        pluginMetadata?.selectedSnapshot.configFingerprint?.trim() || null,
      ...(pluginMetadata ? { pluginMetadata } : {}),
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
  return snapshotRead.pluginMetadata?.selectedSnapshot.registrySource === "derived";
}

export async function persistRefreshedPluginIndex(params: {
  env: NodeJS.ProcessEnv;
  measure: MeasurePreflightStep;
  readPersistedSnapshot: () => Promise<DoctorConfigPreflightPluginSnapshotRead>;
  snapshotRead: DoctorConfigPreflightPluginSnapshotRead;
  lease: StartupMigrationLease | undefined;
}): Promise<DoctorConfigPreflightPluginSnapshotRead> {
  const derivedPluginMetadataSnapshot = params.snapshotRead.pluginMetadata?.selectedSnapshot;
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
  // Persist the selected workspace index; the validation union cannot pass scoped freshness checks.
  await params.measure("plugin-index-persistence", () =>
    writePersistedInstalledPluginIndexWithLeaseSync(derivedPluginMetadataSnapshot.index, {
      env: params.env,
      lease,
    }),
  );
  const persistedSnapshotRead = await params.readPersistedSnapshot();
  const persistedPluginMetadataSnapshot = persistedSnapshotRead.pluginMetadata?.selectedSnapshot;
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
