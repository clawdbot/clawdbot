import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { getMatrixRuntime } from "../../runtime.js";
import { resolveMatrixStoragePaths } from "../client/storage.js";
import type { MatrixAuth } from "../client/types.js";
import type { MatrixClient } from "../sdk.js";

type MatrixLegacyCryptoMigrationState = {
  version: 1;
  accountId: string;
  roomKeyCounts: {
    total: number;
    backedUp: number;
  } | null;
  restoreStatus: "pending" | "completed" | "manual-action-required";
  restoredAt?: string;
  importedCount?: number;
  totalCount?: number;
  lastError?: string | null;
};

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

function isMigrationState(value: unknown): value is MatrixLegacyCryptoMigrationState {
  return (
    Boolean(value) && typeof value === "object" && (value as { version?: unknown }).version === 1
  );
}

async function resolvePendingMigrationStatePath(params: {
  stateDir: string;
  auth: Pick<MatrixAuth, "homeserver" | "userId" | "accessToken" | "accountId" | "deviceId">;
}): Promise<{
  statePath: string;
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
  const directStatePath = path.join(rootDir, "legacy-crypto-migration.json");
  const { value: directValue } =
    await readJsonFileWithFallback<MatrixLegacyCryptoMigrationState | null>(directStatePath, null);
  if (isMigrationState(directValue) && directValue.restoreStatus === "pending") {
    return { statePath: directStatePath, value: directValue };
  }

  const accountStorageDir = path.dirname(rootDir);
  let siblingEntries: string[] = [];
  try {
    siblingEntries = (await fs.readdir(accountStorageDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((entry) => path.join(accountStorageDir, entry) !== rootDir)
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    return { statePath: directStatePath, value: directValue };
  }

  for (const sibling of siblingEntries) {
    const siblingStatePath = path.join(accountStorageDir, sibling, "legacy-crypto-migration.json");
    const { value } = await readJsonFileWithFallback<MatrixLegacyCryptoMigrationState | null>(
      siblingStatePath,
      null,
    );
    if (isMigrationState(value) && value.restoreStatus === "pending") {
      return { statePath: siblingStatePath, value };
    }
  }
  return { statePath: directStatePath, value: directValue };
}

export async function maybeRestoreLegacyMatrixBackup(params: {
  client: Pick<MatrixClient, "restoreRoomKeyBackup">;
  auth: Pick<MatrixAuth, "homeserver" | "userId" | "accessToken" | "accountId" | "deviceId">;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<MatrixLegacyCryptoRestoreResult> {
  const env = params.env ?? process.env;
  const stateDir = params.stateDir ?? getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  const { statePath, value } = await resolvePendingMigrationStatePath({
    stateDir,
    auth: params.auth,
  });
  if (!isMigrationState(value) || value.restoreStatus !== "pending") {
    return { kind: "skipped" };
  }

  const restore = await params.client.restoreRoomKeyBackup();
  const localOnlyKeys =
    value.roomKeyCounts && value.roomKeyCounts.total > value.roomKeyCounts.backedUp
      ? value.roomKeyCounts.total - value.roomKeyCounts.backedUp
      : 0;

  if (restore.success) {
    await writeJsonFileAtomically(statePath, {
      ...value,
      restoreStatus: "completed",
      restoredAt: restore.restoredAt ?? new Date().toISOString(),
      importedCount: restore.imported,
      totalCount: restore.total,
      lastError: null,
    } satisfies MatrixLegacyCryptoMigrationState);
    return {
      kind: "restored",
      imported: restore.imported,
      total: restore.total,
      localOnlyKeys,
    };
  }

  await writeJsonFileAtomically(statePath, {
    ...value,
    lastError: restore.error ?? "unknown",
  } satisfies MatrixLegacyCryptoMigrationState);
  return {
    kind: "failed",
    error: restore.error ?? "unknown",
    localOnlyKeys,
  };
}
