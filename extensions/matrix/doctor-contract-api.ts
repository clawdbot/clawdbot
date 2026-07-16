import type { Dirent } from "node:fs";
// Matrix API module exposes the plugin public contract.
import fs from "node:fs/promises";
import path from "node:path";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor";
import {
  hasMatrixSyncCacheStateInStore,
  openMatrixSyncCacheStoreOptions,
  readLegacyMatrixSyncCacheState,
  writeMatrixSyncCacheStateToStore,
  type MatrixSyncCacheRecord,
} from "./src/matrix/client/file-sync-store.js";
import {
  hasMatrixStorageMetaStateInStore,
  normalizeMatrixStorageMetadata,
  openMatrixStorageMetaStoreOptions,
  writeMatrixStorageMetaStateToStore,
  type MatrixStorageMetadata,
} from "./src/matrix/client/storage.js";
import {
  MATRIX_IDB_SNAPSHOT_FILENAME,
  MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
  MATRIX_RECOVERY_KEY_FILENAME,
  hasMatrixIdbSnapshotStateInStore,
  hasMatrixLegacyCryptoMigrationStateInStore,
  hasMatrixRecoveryKeyStateInStore,
  openMatrixIdbSnapshotStoreOptions,
  openMatrixLegacyCryptoMigrationStoreOptions,
  openMatrixRecoveryKeyStoreOptions,
  readLegacyMatrixLegacyCryptoMigrationState,
  readLegacyMatrixRecoveryKeyState,
  writeMatrixIdbSnapshotJsonToStore,
  writeMatrixLegacyCryptoMigrationStateToStore,
  writeMatrixRecoveryKeyStateToStore,
  type MatrixIdbSnapshotRecord,
  type MatrixLegacyCryptoMigrationState,
} from "./src/matrix/crypto-state-store.js";
import {
  collectMatrixInboundDedupeSources,
  importNewestInboundDedupeMarkers,
  MATRIX_LEGACY_INBOUND_DEDUPE_FILENAME,
  readLegacyInboundDedupeJsonSource,
  readLegacyInboundDedupeSqliteSource,
  retireLegacyInboundDedupeSqliteRows,
  type LegacyInboundDedupeMarker,
  type MatrixInboundDedupeMigrationIo,
} from "./src/matrix/monitor/inbound-dedupe-migration.js";
import { readLegacyMatrixIdbSnapshotState } from "./src/matrix/sdk/idb-persistence.js";
import type { MatrixStoredRecoveryKey } from "./src/matrix/sdk/types.js";

export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";

const MATRIX_SYNC_CACHE_FILENAME = "bot-storage.json";
const MATRIX_STORAGE_META_FILENAME = "storage-meta.json";

async function collectLegacyMatrixStateRoots(
  stateDir: string,
  filename: string,
): Promise<string[]> {
  const matrixRoot = path.join(stateDir, "matrix");
  const roots: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === filename) {
        roots.push(dir);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
      }
    }
  }
  await visit(matrixRoot);
  return roots.filter((root) => path.resolve(root) !== path.resolve(matrixRoot)).toSorted();
}

async function collectLegacySyncCacheRoots(stateDir: string): Promise<string[]> {
  return collectLegacyMatrixStateRoots(stateDir, MATRIX_SYNC_CACHE_FILENAME);
}

async function readLegacyMatrixStorageMetadata(
  storageRootDir: string,
): Promise<MatrixStorageMetadata | null> {
  try {
    return normalizeMatrixStorageMetadata(
      JSON.parse(
        await fs.readFile(path.join(storageRootDir, MATRIX_STORAGE_META_FILENAME), "utf8"),
      ),
    );
  } catch {
    return null;
  }
}

async function archiveLegacySyncCache(params: {
  storageRootDir: string;
  changes: string[];
  warnings: string[];
  notices?: string[];
  notice?: string;
}): Promise<void> {
  await archiveLegacyMatrixStateFile({
    ...params,
    filename: MATRIX_SYNC_CACHE_FILENAME,
    label: "Matrix sync cache",
  });
}

async function archiveLegacyMatrixStateFile(params: {
  storageRootDir: string;
  filename: string;
  label: string;
  changes: string[];
  warnings: string[];
  notices?: string[];
  notice?: string;
}): Promise<void> {
  const warningCount = params.warnings.length;
  await archiveLegacyStateSource({
    filePath: path.join(params.storageRootDir, params.filename),
    label: params.label,
    changes: params.changes,
    warnings: params.warnings,
  });
  if (params.notice && params.warnings.length === warningCount) {
    params.notices?.push(params.notice);
  }
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "matrix-inbound-dedupe-to-claimable-dedupe",
    label: "Matrix inbound dedupe markers",
    async detectLegacyState(params) {
      const io: MatrixInboundDedupeMigrationIo = { context: params.context, env: params.env };
      const preview: string[] = [];
      const sources = await collectMatrixInboundDedupeSources(params.stateDir);
      for (const storageRootDir of sources.sqliteRoots) {
        try {
          if (
            (await readLegacyInboundDedupeSqliteSource(io, storageRootDir)).legacyRowCount === 0
          ) {
            continue;
          }
        } catch {
          continue;
        }
        preview.push(
          `Matrix inbound dedupe rows can migrate to the claimable dedupe store: ${storageRootDir}`,
        );
      }
      for (const storageRootDir of sources.jsonRoots) {
        preview.push(
          `Matrix inbound dedupe JSON can migrate to the claimable dedupe store: ${path.join(storageRootDir, MATRIX_LEGACY_INBOUND_DEDUPE_FILENAME)}`,
        );
      }
      return preview.length > 0 ? { preview } : null;
    },
    async migrateLegacyState(params) {
      const io: MatrixInboundDedupeMigrationIo = { context: params.context, env: params.env };
      const changes: string[] = [];
      const warnings: string[] = [];
      const sources = await collectMatrixInboundDedupeSources(params.stateDir);

      // Gather every marker first so the capacity-aware import keeps the
      // globally newest ones instead of whichever storage root imports last.
      const gathered: LegacyInboundDedupeMarker[] = [];
      const sqliteRootsToRetire: string[] = [];
      for (const storageRootDir of sources.sqliteRoots) {
        try {
          const source = await readLegacyInboundDedupeSqliteSource(io, storageRootDir);
          if (source.legacyRowCount === 0) {
            continue;
          }
          gathered.push(...source.markers);
          sqliteRootsToRetire.push(storageRootDir);
        } catch (err) {
          warnings.push(
            `Failed reading Matrix inbound dedupe rows for ${storageRootDir}: ${String(err)}; left legacy rows in place`,
          );
        }
      }
      const jsonRootsToRetire: string[] = [];
      for (const storageRootDir of sources.jsonRoots) {
        try {
          const markers = await readLegacyInboundDedupeJsonSource(storageRootDir);
          if (markers === null) {
            // Nothing recoverable, but archiving (rename, not delete) resolves
            // the pending detection while preserving the bytes for inspection.
            warnings.push(
              `Matrix inbound dedupe JSON for ${storageRootDir} is malformed; archived without import`,
            );
          } else {
            gathered.push(...markers);
          }
          jsonRootsToRetire.push(storageRootDir);
        } catch (err) {
          warnings.push(
            `Failed reading Matrix inbound dedupe JSON for ${storageRootDir}: ${String(err)}; left legacy file in place`,
          );
        }
      }
      if (sqliteRootsToRetire.length + jsonRootsToRetire.length === 0) {
        return { changes, warnings };
      }

      try {
        const result = await importNewestInboundDedupeMarkers({ io, markers: gathered });
        changes.push(
          `Migrated Matrix inbound dedupe markers to the claimable dedupe store (${result.imported} of ${result.total} entries)`,
        );
      } catch (err) {
        warnings.push(
          `Failed importing Matrix inbound dedupe markers: ${String(err)}; left legacy sources in place`,
        );
        return { changes, warnings };
      }

      // Retire the legacy sources only after the import succeeded so a failed
      // run keeps them for the next doctor attempt.
      for (const storageRootDir of sqliteRootsToRetire) {
        try {
          await retireLegacyInboundDedupeSqliteRows(io, storageRootDir);
          changes.push(`Retired Matrix inbound dedupe rows for ${storageRootDir}`);
        } catch (err) {
          warnings.push(
            `Failed retiring Matrix inbound dedupe rows for ${storageRootDir}: ${String(err)}`,
          );
        }
      }
      for (const storageRootDir of jsonRootsToRetire) {
        await archiveLegacyMatrixStateFile({
          storageRootDir,
          filename: MATRIX_LEGACY_INBOUND_DEDUPE_FILENAME,
          label: "Matrix inbound dedupe",
          changes,
          warnings,
        });
      }
      return { changes, warnings };
    },
  },
  {
    id: "matrix-storage-meta-json-to-plugin-state",
    label: "Matrix storage metadata",
    async detectLegacyState(params) {
      const previews: string[] = [];
      for (const storageRootDir of await collectLegacyMatrixStateRoots(
        params.stateDir,
        MATRIX_STORAGE_META_FILENAME,
      )) {
        if (!(await readLegacyMatrixStorageMetadata(storageRootDir))) {
          continue;
        }
        previews.push(`Matrix storage metadata JSON can migrate to SQLite: ${storageRootDir}`);
      }
      return previews.length > 0 ? { preview: previews } : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const notices: string[] = [];
      for (const storageRootDir of await collectLegacyMatrixStateRoots(
        params.stateDir,
        MATRIX_STORAGE_META_FILENAME,
      )) {
        const payload = await readLegacyMatrixStorageMetadata(storageRootDir);
        if (!payload) {
          continue;
        }
        const store = params.context.openPluginStateKeyedStore<MatrixStorageMetadata>(
          openMatrixStorageMetaStoreOptions(storageRootDir),
        );
        if (await hasMatrixStorageMetaStateInStore({ store })) {
          await archiveLegacyMatrixStateFile({
            storageRootDir,
            filename: MATRIX_STORAGE_META_FILENAME,
            label: "Matrix storage metadata",
            changes,
            warnings,
            notices,
            notice: `Kept existing Matrix storage metadata in SQLite and archived the legacy source for ${storageRootDir}`,
          });
          continue;
        }
        await writeMatrixStorageMetaStateToStore({ payload, store });
        changes.push(`Migrated Matrix storage metadata JSON to SQLite for ${storageRootDir}`);
        await archiveLegacyMatrixStateFile({
          storageRootDir,
          filename: MATRIX_STORAGE_META_FILENAME,
          label: "Matrix storage metadata",
          changes,
          warnings,
        });
      }
      return { changes, warnings, ...(notices.length > 0 ? { notices } : {}) };
    },
  },
  {
    id: "matrix-sync-cache-json-to-plugin-state",
    label: "Matrix sync cache",
    async detectLegacyState(params) {
      const previews: string[] = [];
      for (const storageRootDir of await collectLegacySyncCacheRoots(params.stateDir)) {
        const persisted = await readLegacyMatrixSyncCacheState(storageRootDir);
        if (!persisted) {
          continue;
        }
        previews.push(`Matrix sync cache JSON can migrate to SQLite: ${storageRootDir}`);
      }
      return previews.length > 0 ? { preview: previews } : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const notices: string[] = [];
      for (const storageRootDir of await collectLegacySyncCacheRoots(params.stateDir)) {
        const persisted = await readLegacyMatrixSyncCacheState(storageRootDir);
        if (!persisted) {
          continue;
        }
        const store = params.context.openPluginStateKeyedStore<MatrixSyncCacheRecord>(
          openMatrixSyncCacheStoreOptions(storageRootDir),
        );
        if (await hasMatrixSyncCacheStateInStore({ storageRootDir, store })) {
          await archiveLegacySyncCache({
            storageRootDir,
            changes,
            warnings,
            notices,
            notice: `Kept existing Matrix sync cache in SQLite and archived the legacy source for ${storageRootDir}`,
          });
          continue;
        }
        await writeMatrixSyncCacheStateToStore({
          storageRootDir,
          payload: persisted,
          store,
        });
        changes.push(`Migrated Matrix sync cache JSON to SQLite for ${storageRootDir}`);
        await archiveLegacySyncCache({ storageRootDir, changes, warnings });
      }
      return { changes, warnings, ...(notices.length > 0 ? { notices } : {}) };
    },
  },
  {
    id: "matrix-recovery-key-json-to-plugin-state",
    label: "Matrix recovery key",
    async detectLegacyState(params) {
      const previews: string[] = [];
      for (const storageRootDir of await collectLegacyMatrixStateRoots(
        params.stateDir,
        MATRIX_RECOVERY_KEY_FILENAME,
      )) {
        if (!readLegacyMatrixRecoveryKeyState(storageRootDir)) {
          continue;
        }
        previews.push(`Matrix recovery-key JSON can migrate to SQLite: ${storageRootDir}`);
      }
      return previews.length > 0 ? { preview: previews } : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const notices: string[] = [];
      for (const storageRootDir of await collectLegacyMatrixStateRoots(
        params.stateDir,
        MATRIX_RECOVERY_KEY_FILENAME,
      )) {
        const payload = readLegacyMatrixRecoveryKeyState(storageRootDir);
        if (!payload) {
          continue;
        }
        const store = params.context.openPluginStateKeyedStore<MatrixStoredRecoveryKey>(
          openMatrixRecoveryKeyStoreOptions(storageRootDir),
        );
        if (await hasMatrixRecoveryKeyStateInStore({ store })) {
          await archiveLegacyMatrixStateFile({
            storageRootDir,
            filename: MATRIX_RECOVERY_KEY_FILENAME,
            label: "Matrix recovery key",
            changes,
            warnings,
            notices,
            notice: `Kept existing Matrix recovery key in SQLite and archived the legacy source for ${storageRootDir}`,
          });
          continue;
        }
        await writeMatrixRecoveryKeyStateToStore({ payload, store });
        changes.push(`Migrated Matrix recovery-key JSON to SQLite for ${storageRootDir}`);
        await archiveLegacyMatrixStateFile({
          storageRootDir,
          filename: MATRIX_RECOVERY_KEY_FILENAME,
          label: "Matrix recovery key",
          changes,
          warnings,
        });
      }
      return { changes, warnings, ...(notices.length > 0 ? { notices } : {}) };
    },
  },
  {
    id: "matrix-idb-snapshot-json-to-plugin-state",
    label: "Matrix IndexedDB snapshot",
    async detectLegacyState(params) {
      const previews: string[] = [];
      for (const storageRootDir of await collectLegacyMatrixStateRoots(
        params.stateDir,
        MATRIX_IDB_SNAPSHOT_FILENAME,
      )) {
        const snapshot = await readLegacyMatrixIdbSnapshotState(storageRootDir);
        if (!snapshot) {
          continue;
        }
        previews.push(`Matrix IndexedDB snapshot JSON can migrate to SQLite: ${storageRootDir}`);
      }
      return previews.length > 0 ? { preview: previews } : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const notices: string[] = [];
      for (const storageRootDir of await collectLegacyMatrixStateRoots(
        params.stateDir,
        MATRIX_IDB_SNAPSHOT_FILENAME,
      )) {
        const snapshot = await readLegacyMatrixIdbSnapshotState(storageRootDir);
        if (!snapshot) {
          continue;
        }
        const store = params.context.openPluginStateKeyedStore<MatrixIdbSnapshotRecord>(
          openMatrixIdbSnapshotStoreOptions(storageRootDir),
        );
        if (await hasMatrixIdbSnapshotStateInStore({ store })) {
          await archiveLegacyMatrixStateFile({
            storageRootDir,
            filename: MATRIX_IDB_SNAPSHOT_FILENAME,
            label: "Matrix IndexedDB snapshot",
            changes,
            warnings,
            notices,
            notice: `Kept existing Matrix IndexedDB snapshot in SQLite and archived the legacy source for ${storageRootDir}`,
          });
          continue;
        }
        await writeMatrixIdbSnapshotJsonToStore({
          snapshotJson: JSON.stringify(snapshot),
          databaseCount: snapshot.length,
          store,
        });
        changes.push(`Migrated Matrix IndexedDB snapshot JSON to SQLite for ${storageRootDir}`);
        await archiveLegacyMatrixStateFile({
          storageRootDir,
          filename: MATRIX_IDB_SNAPSHOT_FILENAME,
          label: "Matrix IndexedDB snapshot",
          changes,
          warnings,
        });
      }
      return { changes, warnings, ...(notices.length > 0 ? { notices } : {}) };
    },
  },
  {
    id: "matrix-legacy-crypto-migration-json-to-plugin-state",
    label: "Matrix legacy crypto migration",
    async detectLegacyState(params) {
      const previews: string[] = [];
      for (const storageRootDir of await collectLegacyMatrixStateRoots(
        params.stateDir,
        MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
      )) {
        if (!readLegacyMatrixLegacyCryptoMigrationState(storageRootDir)) {
          continue;
        }
        previews.push(
          `Matrix legacy crypto migration JSON can migrate to SQLite: ${storageRootDir}`,
        );
      }
      return previews.length > 0 ? { preview: previews } : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const notices: string[] = [];
      for (const storageRootDir of await collectLegacyMatrixStateRoots(
        params.stateDir,
        MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
      )) {
        const state = readLegacyMatrixLegacyCryptoMigrationState(storageRootDir);
        if (!state) {
          continue;
        }
        const store = params.context.openPluginStateKeyedStore<MatrixLegacyCryptoMigrationState>(
          openMatrixLegacyCryptoMigrationStoreOptions(storageRootDir),
        );
        if (await hasMatrixLegacyCryptoMigrationStateInStore({ store })) {
          await archiveLegacyMatrixStateFile({
            storageRootDir,
            filename: MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
            label: "Matrix legacy crypto migration",
            changes,
            warnings,
            notices,
            notice: `Kept existing Matrix legacy crypto migration in SQLite and archived the legacy source for ${storageRootDir}`,
          });
          continue;
        }
        await writeMatrixLegacyCryptoMigrationStateToStore({ state, store });
        changes.push(
          `Migrated Matrix legacy crypto migration JSON to SQLite for ${storageRootDir}`,
        );
        await archiveLegacyMatrixStateFile({
          storageRootDir,
          filename: MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
          label: "Matrix legacy crypto migration",
          changes,
          warnings,
        });
      }
      return { changes, warnings, ...(notices.length > 0 ? { notices } : {}) };
    },
  },
];
