// Matrix plugin module implements legacy crypto restore behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getMatrixRuntime } from "../../runtime.js";
import { resolveMatrixStoragePaths } from "../client/storage.js";
import type { MatrixAuth } from "../client/types.js";
import {
  migrateLegacyMatrixLegacyCryptoMigrationFileToStore,
  readMatrixLegacyCryptoMigrationState,
  writeMatrixLegacyCryptoMigrationState,
  type MatrixLegacyCryptoMigrationState,
} from "../crypto-state-store.js";
import type { MatrixClient } from "../sdk.js";

export type MatrixLegacyCryptoRestoreResult =
  | { kind: "skipped" }
  | {
      kind: "restored";
      imported: number;
      total: number;
      localOnlyKeys: number;
    }
  | {
      kind: "failed";
      error: string;
      localOnlyKeys: number;
    };

async function resolvePendingMigrationStateRoot(params: {
  stateDir: string;
  auth: Pick<MatrixAuth, "homeserver" | "userId" | "accessToken" | "accountId" | "deviceId">;
}): Promise<{
  storageRootDir: string;
  value: MatrixLegacyCryptoMigrationState | null;
}> {
  const { rootDir } = resolveMatrixStoragePaths({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    accountId: params.auth.accountId,
    deviceId: params.auth.deviceId,
    stateDir: params.stateDir,
  });
  try {
    migrateLegacyMatrixLegacyCryptoMigrationFileToStore(rootDir);
  } catch {
    // Startup restore can still proceed from any already-migrated SQLite state.
  }
  const directValue = readMatrixLegacyCryptoMigrationState(rootDir);
  if (directValue?.restoreStatus === "pending") {
    return { storageRootDir: rootDir, value: directValue };
  }

  const accountStorageDir = path.dirname(rootDir);
  let siblingEntries: string[];
  try {
    siblingEntries = (await fs.readdir(accountStorageDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((entry) => path.join(accountStorageDir, entry) !== rootDir)
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    return { storageRootDir: rootDir, value: directValue };
  }

  for (const sibling of siblingEntries) {
    const siblingRootDir = path.join(accountStorageDir, sibling);
    try {
      migrateLegacyMatrixLegacyCryptoMigrationFileToStore(siblingRootDir);
    } catch {
      // Sibling scan is best-effort; unreadable roots are ignored.
    }
    const value = readMatrixLegacyCryptoMigrationState(siblingRootDir);
    if (value?.restoreStatus === "pending") {
      return { storageRootDir: siblingRootDir, value };
    }
  }
  return { storageRootDir: rootDir, value: directValue };
}

export async function maybeRestoreLegacyMatrixBackup(params: {
  client: Pick<MatrixClient, "restoreRoomKeyBackup">;
  auth: Pick<MatrixAuth, "homeserver" | "userId" | "accessToken" | "accountId" | "deviceId">;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<MatrixLegacyCryptoRestoreResult> {
  const env = params.env ?? process.env;
  const stateDir = params.stateDir ?? getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  const { storageRootDir, value } = await resolvePendingMigrationStateRoot({
    stateDir,
    auth: params.auth,
  });
  if (value?.restoreStatus !== "pending") {
    return { kind: "skipped" };
  }

  const restore = await params.client.restoreRoomKeyBackup();
  const localOnlyKeys =
    value.roomKeyCounts && value.roomKeyCounts.total > value.roomKeyCounts.backedUp
      ? value.roomKeyCounts.total - value.roomKeyCounts.backedUp
      : 0;

  if (restore.success) {
    writeMatrixLegacyCryptoMigrationState({
      storageRootDir,
      state: {
        ...value,
        restoreStatus: "completed",
        restoredAt: restore.restoredAt ?? new Date().toISOString(),
        importedCount: restore.imported,
        totalCount: restore.total,
        lastError: null,
      } satisfies MatrixLegacyCryptoMigrationState,
    });
    return {
      kind: "restored",
      imported: restore.imported,
      total: restore.total,
      localOnlyKeys,
    };
  }

  writeMatrixLegacyCryptoMigrationState({
    storageRootDir,
    state: {
      ...value,
      lastError: restore.error ?? "unknown",
    } satisfies MatrixLegacyCryptoMigrationState,
  });
  return {
    kind: "failed",
    error: restore.error ?? "unknown",
    localOnlyKeys,
  };
}
