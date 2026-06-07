import type { Dirent } from "node:fs";
// Matrix API module exposes the plugin public contract.
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import {
  hasMatrixSyncCacheStateInStore,
  openMatrixSyncCacheStoreOptions,
  readLegacyMatrixSyncCacheState,
  writeMatrixSyncCacheStateToStore,
  type MatrixSyncCacheRecord,
} from "./src/matrix/client/file-sync-store.js";
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
import { readLegacyMatrixIdbSnapshotState } from "./src/matrix/sdk/idb-persistence.js";
import type { MatrixStoredRecoveryKey } from "./src/matrix/sdk/types.js";

export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";

const MATRIX_SYNC_CACHE_FILENAME = "bot-storage.json";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

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

async function archiveLegacySyncCache(params: {
  storageRootDir: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const sourcePath = path.join(params.storageRootDir, MATRIX_SYNC_CACHE_FILENAME);
  const archivedPath = `${sourcePath}.migrated`;
  if (await fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated Matrix sync cache in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.rename(sourcePath, archivedPath);
    params.changes.push(`Archived Matrix sync cache legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving Matrix sync cache legacy source: ${String(err)}`);
  }
}

async function archiveLegacyMatrixStateFile(params: {
  storageRootDir: string;
  filename: string;
  label: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const sourcePath = path.join(params.storageRootDir, params.filename);
  const archivedPath = `${sourcePath}.migrated`;
  if (await fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated ${params.label} in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.rename(sourcePath, archivedPath);
    params.changes.push(`Archived ${params.label} legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving ${params.label} legacy source: ${String(err)}`);
  }
}

export const stateMigrations: PluginDoctorStateMigration[] = [
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
      for (const storageRootDir of await collectLegacySyncCacheRoots(params.stateDir)) {
        const persisted = await readLegacyMatrixSyncCacheState(storageRootDir);
        if (!persisted) {
          continue;
        }
        const store = params.context.openPluginStateKeyedStore<MatrixSyncCacheRecord>(
          openMatrixSyncCacheStoreOptions(storageRootDir),
        );
        if (await hasMatrixSyncCacheStateInStore({ storageRootDir, store })) {
          warnings.push(
            `Skipped Matrix sync cache import for ${storageRootDir} because SQLite already has sync cache state`,
          );
          await archiveLegacySyncCache({ storageRootDir, changes, warnings });
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
      return { changes, warnings };
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
          warnings.push(
            `Skipped Matrix recovery-key import for ${storageRootDir} because SQLite already has recovery-key state`,
          );
          await archiveLegacyMatrixStateFile({
            storageRootDir,
            filename: MATRIX_RECOVERY_KEY_FILENAME,
            label: "Matrix recovery key",
            changes,
            warnings,
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
      return { changes, warnings };
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
          warnings.push(
            `Skipped Matrix IndexedDB snapshot import for ${storageRootDir} because SQLite already has snapshot state`,
          );
          await archiveLegacyMatrixStateFile({
            storageRootDir,
            filename: MATRIX_IDB_SNAPSHOT_FILENAME,
            label: "Matrix IndexedDB snapshot",
            changes,
            warnings,
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
      return { changes, warnings };
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
          warnings.push(
            `Skipped Matrix legacy crypto migration import for ${storageRootDir} because SQLite already has migration state`,
          );
          await archiveLegacyMatrixStateFile({
            storageRootDir,
            filename: MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
            label: "Matrix legacy crypto migration",
            changes,
            warnings,
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
      return { changes, warnings };
    },
  },
];
