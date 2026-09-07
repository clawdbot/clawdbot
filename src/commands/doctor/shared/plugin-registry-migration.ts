// Doctor migration from legacy shipped plugin install config into persisted install registry.
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { ConfigMutationConflictError } from "../../../config/mutation-conflict.js";
import { inspectShippedPluginInstallConfigRecords } from "../../../config/plugin-install-config-migration.js";
import {
  copyPluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "../../../config/plugin-install-record-map.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { inspectPersistedInstalledPluginIndexInstallRecordsSync } from "../../../plugins/installed-plugin-index-record-state.js";
import {
  loadInstalledPluginIndexInstallRecords,
  readPersistedInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
} from "../../../plugins/installed-plugin-index-records.js";
import { writePersistedInstalledPluginIndex } from "../../../plugins/installed-plugin-index-store-write.js";
import {
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "../../../plugins/installed-plugin-index-store.js";
import {
  loadInstalledPluginIndex,
  type InstalledPluginIndex,
  type LoadInstalledPluginIndexParams,
} from "../../../plugins/installed-plugin-index.js";
import {
  isTrustedOfficialPluginInstallRecord,
  resolveTrustedOfficialClawHubPackageName,
  resolveTrustedSourceLinkedOfficialClawHubInstall,
} from "../../../plugins/official-external-install-records.js";

/** Backfill shipped ClawHub authority only from a catalog-bound legacy install record. */
export function migrateOfficialPluginInstallProvenance(
  records: Record<string, PluginInstallRecord>,
): Record<string, PluginInstallRecord> {
  const migrated = copyPluginInstallRecordMap(records);
  for (const [pluginId, record] of Object.entries(records)) {
    // Partial or conflicting authority is not a legacy shape. Local sources must
    // be reinstalled; package metadata cannot establish the missing source fact.
    if (
      record.source !== "clawhub" ||
      record.clawhubUrl !== undefined ||
      record.clawhubChannel !== undefined ||
      record.sourcePath !== undefined ||
      !resolveTrustedSourceLinkedOfficialClawHubInstall({ pluginId, record })
    ) {
      continue;
    }
    const normalized: PluginInstallRecord = {
      ...record,
      clawhubUrl: "https://clawhub.ai",
      clawhubChannel: "official",
    };
    const packageName = resolveTrustedOfficialClawHubPackageName(normalized);
    if (isTrustedOfficialPluginInstallRecord({ pluginId, packageName, record: normalized })) {
      setPluginInstallRecordMapEntry(migrated, pluginId, normalized);
    }
  }
  return migrated;
}

type PluginRegistryDoctorMigrationPreflight =
  | {
      /** Migration action selected before reading or writing registry state. */
      action: "skip-existing";
      /** Persisted plugin index path that migration will inspect or write. */
      filePath: string;
      /** Authoritative pre-repair generation used to detect a real inventory change. */
      current: InstalledPluginIndex;
    }
  | {
      action: "initialize" | "migrate";
      filePath: string;
    };

type PluginRegistryDoctorMigrationResult =
  | {
      status: "skip-existing" | "dry-run";
      migrated: false;
      preflight: PluginRegistryDoctorMigrationPreflight;
    }
  | {
      status: "migrated";
      migrated: true;
      preflight: PluginRegistryDoctorMigrationPreflight;
      current: InstalledPluginIndex;
    };

export class InvalidPluginInstallRecordStateError extends Error {}

function invalidPersistedInstallRecordMessage(filePath: string): string {
  return [
    `Persisted plugin install records are invalid at ${filePath}.`,
    "Stop the Gateway, back up this database, delete only the config_machine_state row with state_key='plugins.installedIndex' using SQLite tooling, then rerun `openclaw doctor --fix` to rebuild it.",
  ].join(" ");
}

const INVALID_CONFIG_INSTALL_RECORD_MESSAGE =
  "plugins.installs contains invalid records. Back up openclaw.json, correct or remove the invalid retired plugins.installs record, then rerun `openclaw doctor --fix`.";

export type ShippedPluginInstallConfigImport = {
  source: Pick<ConfigFileSnapshot, "path" | "hash" | "sourceConfig">;
  databasePath: string;
  pluginInventoryChanged: boolean;
};

/** Check the accepted source again inside the config writer's lock. */
export function assertShippedPluginInstallConfigImportCurrent(
  snapshot: ConfigFileSnapshot,
  imported: ShippedPluginInstallConfigImport | undefined,
): void {
  const source = inspectShippedPluginInstallConfigRecords(snapshot.sourceConfig);
  if (source.status === "missing") {
    return;
  }
  if (source.status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(INVALID_CONFIG_INSTALL_RECORD_MESSAGE);
  }
  if (
    !imported ||
    imported.databasePath !== resolveInstalledPluginIndexStorePath() ||
    !isDeepStrictEqual(imported.source, {
      path: snapshot.path,
      hash: snapshot.hash,
      sourceConfig: snapshot.sourceConfig,
    })
  ) {
    throw new ConfigMutationConflictError("config changed after plugin install migration");
  }
}

/** Preserve retired source records before Doctor can restore or rewrite their config. */
export async function importShippedPluginInstallConfigForDoctor(
  snapshot: ConfigFileSnapshot,
): Promise<ShippedPluginInstallConfigImport | undefined> {
  const source = inspectShippedPluginInstallConfigRecords(snapshot.sourceConfig);
  if (source.status === "missing") {
    return undefined;
  }
  if (source.status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(INVALID_CONFIG_INSTALL_RECORD_MESSAGE);
  }
  const { readConfigFileSnapshotForWrite, withConfigMutationExclusive } =
    await import("../../../config/config.js");
  const sourceIdentity = {
    path: snapshot.path,
    hash: snapshot.hash,
    sourceConfig: snapshot.sourceConfig,
  };
  const receipt = (databasePath: string, pluginInventoryChanged: boolean) => ({
    source: structuredClone(sourceIdentity),
    databasePath,
    pluginInventoryChanged,
  });
  if (Object.keys(source.records).length === 0) {
    return receipt(resolveInstalledPluginIndexStorePath(), false);
  }
  const { commitPluginInstallRecordsOnly } =
    await import("../../../plugins/install-record-commit.js");
  const { withPluginLifecycleLease } = await import("../../../plugins/plugin-lifecycle-lease.js");
  // Installers take the plugin lease before the config lock; retain that order here.
  return await withPluginLifecycleLease({}, async (lease) =>
    withConfigMutationExclusive(async () => {
      const prepared = await readConfigFileSnapshotForWrite();
      if (
        prepared.snapshot.path !== snapshot.path ||
        prepared.snapshot.hash !== snapshot.hash ||
        !isDeepStrictEqual(prepared.snapshot.sourceConfig, snapshot.sourceConfig)
      ) {
        throw new ConfigMutationConflictError("config changed before plugin install migration");
      }
      const storeOptions = { filePath: lease.databasePath };
      const previousInstallRecords = await loadInstalledPluginIndexInstallRecords(storeOptions);
      const persisted = await readPersistedInstalledPluginIndexInstallRecords(storeOptions);
      let nextInstallRecords = copyPluginInstallRecordMap(previousInstallRecords);
      for (const [pluginId, record] of Object.entries(source.records)) {
        // Authored provenance outranks disk recovery, but never an existing ledger owner.
        if (!persisted || !Object.hasOwn(persisted, pluginId)) {
          setPluginInstallRecordMapEntry(nextInstallRecords, pluginId, record);
        }
      }
      nextInstallRecords = migrateOfficialPluginInstallProvenance(nextInstallRecords);
      if (isDeepStrictEqual(nextInstallRecords, persisted)) {
        return receipt(lease.databasePath, false);
      }
      await commitPluginInstallRecordsOnly({
        previousInstallRecords,
        nextInstallRecords,
        nextConfig: withoutPluginInstallRecords(snapshot.sourceConfig),
        verifyConfigFresh: async () => {
          prepared.writeOptions.assertConfigPathForWrite?.();
          const current = await readConfigFileSnapshotForWrite();
          // Includes can change without changing the root hash; retain the whole write ownership.
          if (
            current.snapshot.path !== prepared.snapshot.path ||
            current.snapshot.hash !== prepared.snapshot.hash ||
            !isDeepStrictEqual(
              current.writeOptions.includeFileHashesForWrite,
              prepared.writeOptions.includeFileHashesForWrite,
            ) ||
            !isDeepStrictEqual(
              current.writeOptions.includeFileTargetsForWrite,
              prepared.writeOptions.includeFileTargetsForWrite,
            )
          ) {
            throw new ConfigMutationConflictError("config changed during plugin install migration");
          }
        },
      });
      return receipt(lease.databasePath, true);
    }),
  );
}

export type PluginRegistryDoctorMigrationParams = LoadInstalledPluginIndexParams &
  InstalledPluginIndexStoreOptions & {
    dryRun?: boolean;
    existsSync?: (path: string) => boolean;
    readConfig?: () => Promise<OpenClawConfig> | OpenClawConfig;
  };

/** Decide whether Doctor should migrate the plugin registry in this environment. */
export function preflightPluginRegistryDoctorMigration(
  params: PluginRegistryDoctorMigrationParams = {},
): PluginRegistryDoctorMigrationPreflight {
  const filePath = resolveInstalledPluginIndexStorePath(params);
  const persistedState = inspectPersistedInstalledPluginIndexInstallRecordsSync(params);
  if (persistedState.status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(invalidPersistedInstallRecordMessage(filePath));
  }
  const configInstallState = params.config
    ? inspectShippedPluginInstallConfigRecords(params.config)
    : undefined;
  if (configInstallState?.status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(INVALID_CONFIG_INSTALL_RECORD_MESSAGE);
  }
  const pathExists = params.existsSync ?? fs.existsSync;
  if (pathExists(filePath)) {
    const currentRegistry = readPersistedInstalledPluginIndexSync(params);
    if (currentRegistry) {
      return {
        action: "skip-existing",
        filePath,
        current: currentRegistry,
      };
    }
    // Install records without a readable index is a half-written registry, not a fresh root:
    // report it as a migration so doctor keeps warning and rebuilds from what survived.
    if (persistedState.status !== "missing") {
      return { action: "migrate", filePath };
    }
  }
  const hasConfigInstallRecords =
    configInstallState?.status === "valid" && Object.keys(configInstallState.records).length > 0;
  // Only a caller that supplied config can prove nothing is left to migrate. Without config, or with
  // retired plugins.installs records still present, stay on "migrate" so the warning is not lost.
  return {
    action: params.config && !hasConfigInstallRecords ? "initialize" : "migrate",
    filePath,
  };
}

async function readMigrationConfig(
  params: PluginRegistryDoctorMigrationParams,
): Promise<OpenClawConfig> {
  if (params.config) {
    return params.config;
  }
  if (params.readConfig) {
    return await params.readConfig();
  }
  const configModule = await import("../../../config/config.js");
  return await configModule.readBestEffortConfig();
}

/** Rebuild Doctor's plugin registry from canonical install records when needed. */
export async function migratePluginRegistryForDoctor(
  params: PluginRegistryDoctorMigrationParams = {},
): Promise<PluginRegistryDoctorMigrationResult> {
  const preflight = preflightPluginRegistryDoctorMigration(params);
  if (preflight.action === "skip-existing") {
    return { status: "skip-existing", migrated: false, preflight };
  }
  if (params.dryRun) {
    return { status: "dry-run", migrated: false, preflight };
  }

  const rawConfig = await readMigrationConfig(params);
  if (inspectShippedPluginInstallConfigRecords(rawConfig).status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(INVALID_CONFIG_INSTALL_RECORD_MESSAGE);
  }
  const config = withoutPluginInstallRecords(rawConfig);
  const installRecords = migrateOfficialPluginInstallProvenance(
    params.installRecords ?? (await loadInstalledPluginIndexInstallRecords(params)),
  );
  const migrationParams = {
    ...params,
    config,
    installRecords,
  };
  const candidateIndex = loadInstalledPluginIndex({
    ...migrationParams,
  });
  const current: InstalledPluginIndex = {
    ...candidateIndex,
    refreshReason: "migration",
  };
  await writePersistedInstalledPluginIndex(current, params);
  return {
    status: "migrated",
    migrated: true,
    preflight,
    current,
  };
}
