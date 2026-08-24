import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isStringRecord as isRecordOfStrings } from "@openclaw/normalization-core/record-coerce";
import { acquireFileLockSyncWithRetry } from "../infra/file-lock-sync.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  recordLegacyMigrationRun,
  recordLegacyMigrationSource,
} from "../infra/state-migrations.receipts.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";

const MIGRATION_KIND = "auth-profile-json-to-sqlite-v2";
type MigrationDatabase = Pick<OpenClawStateDatabase, "migration_runs" | "migration_sources">;
type AuthProfileTargetDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "auth_profile_store" | "auth_profile_state"
>;
type SharedAuthProfileTargetDatabase = Pick<
  OpenClawStateDatabase,
  "auth_profile_stores" | "auth_profile_state"
>;

export type AuthProfileMigrationSourceReceipt = {
  sourceKey: string;
  runId: string;
  sourcePath: string;
  sourceSha256: string;
  sourceSizeBytes: number;
  sourceRecordCount: number;
  /** In-memory migration snapshot; never serialized into the receipt ledger or diagnostics. */
  sourceBytes?: Buffer;
  targetDatabasePath: string;
  targetTable: "auth_profile_store" | "auth_profile_stores" | "auth_profile_state";
  targetStoreKey?: "primary" | "shared";
  archivePath: string;
  expectedProfileSha256?: Record<string, string>;
  expectedStateSha256?: string;
  completionStatus?: "completed" | "archived-unparsed";
  env?: NodeJS.ProcessEnv;
};

function digestBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createAuthProfileMigrationSourceReceipt(params: {
  sourcePath: string;
  sourceBytes: Buffer;
  sourceRecordCount: number;
  targetDatabasePath: string;
  targetTable: AuthProfileMigrationSourceReceipt["targetTable"];
  targetStoreKey?: AuthProfileMigrationSourceReceipt["targetStoreKey"];
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): AuthProfileMigrationSourceReceipt {
  const sourcePath = path.resolve(params.sourcePath);
  const sourceSha256 = digestBytes(params.sourceBytes);
  const sourceKey = `auth-profile-v2:${digestBytes(Buffer.from(`${sourcePath}\0${sourceSha256}`))}`;
  const stamp = (params.now ?? new Date()).toISOString().replaceAll(":", "-");
  return {
    sourceKey,
    runId: `${sourceKey}:${randomUUID()}`,
    sourcePath,
    sourceSha256,
    sourceSizeBytes: params.sourceBytes.byteLength,
    sourceRecordCount: params.sourceRecordCount,
    sourceBytes: Buffer.from(params.sourceBytes),
    targetDatabasePath: path.resolve(params.targetDatabasePath),
    targetTable: params.targetTable,
    ...(params.targetStoreKey ? { targetStoreKey: params.targetStoreKey } : {}),
    archivePath: `${sourcePath}.migrated-${stamp}-${randomUUID()}`,
    ...(params.env ? { env: params.env } : {}),
  };
}

function reportJson(receipt: AuthProfileMigrationSourceReceipt): string {
  return JSON.stringify({
    format: MIGRATION_KIND,
    archivePath: receipt.archivePath,
    targetDatabasePath: receipt.targetDatabasePath,
    targetTable: receipt.targetTable,
    targetStoreKey: receipt.targetStoreKey ?? "primary",
    expectedProfileSha256: receipt.expectedProfileSha256,
    expectedStateSha256: receipt.expectedStateSha256,
    completionStatus: receipt.completionStatus ?? "completed",
  });
}

export function digestAuthProfileMigrationValue(value: unknown): string {
  return digestBytes(Buffer.from(JSON.stringify(value) ?? "<undefined>"));
}

function recordAuthProfileMigrationImported(
  receipt: AuthProfileMigrationSourceReceipt,
  now = Date.now(),
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<MigrationDatabase>(db);
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("migration_sources")
          .select(["last_run_id", "status"])
          .where("source_key", "=", receipt.sourceKey),
      );
      if (
        existing &&
        existing.last_run_id !== receipt.runId &&
        existing.status !== "retryable" &&
        existing.status !== "superseded"
      ) {
        throw new Error(
          `auth profile migration source already owned by ${existing.status} receipt`,
        );
      }
      const report = reportJson(receipt);
      recordLegacyMigrationRun(db, {
        runId: receipt.runId,
        startedAt: now,
        finishedAt: null,
        status: "imported",
        reportJson: report,
        upsert: true,
      });
      recordLegacyMigrationSource(db, {
        sourceKey: receipt.sourceKey,
        migrationKind: MIGRATION_KIND,
        sourcePath: receipt.sourcePath,
        targetTable: receipt.targetTable,
        sourceSha256: receipt.sourceSha256,
        sourceSizeBytes: receipt.sourceSizeBytes,
        sourceRecordCount: receipt.sourceRecordCount,
        runId: receipt.runId,
        status: "imported",
        importedAt: now,
        reportJson: report,
        upsert: true,
      });
    },
    { env: receipt.env },
  );
}

function retirePendingAuthProfileMigrationReceipt(
  receipt: AuthProfileMigrationSourceReceipt,
  status: "retryable" | "superseded",
  now = Date.now(),
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<MigrationDatabase>(db);
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("migration_runs")
          .set({ status, finished_at: now })
          .where("id", "=", receipt.runId)
          .where("status", "=", "imported"),
      );
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("migration_sources")
          .set({ status })
          .where("source_key", "=", receipt.sourceKey)
          .where("last_run_id", "=", receipt.runId)
          .where("status", "=", "imported"),
      );
    },
    { env: receipt.env },
  );
}

function restoreAuthProfileMigrationArchiveNoClobber(
  receipt: AuthProfileMigrationSourceReceipt,
): "restored" | "source-exists" {
  try {
    fs.linkSync(receipt.archivePath, receipt.sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return "source-exists";
    }
    throw error;
  }
  fs.unlinkSync(receipt.archivePath);
  return "restored";
}

function recordAuthProfileMigrationCompleted(
  receipt: AuthProfileMigrationSourceReceipt,
  now = Date.now(),
  status: "completed" | "archived-unparsed" = "completed",
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<MigrationDatabase>(db);
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("migration_runs")
          .set({ status, finished_at: now })
          .where("id", "=", receipt.runId),
      );
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("migration_sources")
          .set({ status, removed_source: 1 })
          .where("source_key", "=", receipt.sourceKey)
          .where("last_run_id", "=", receipt.runId),
      );
    },
    { env: receipt.env },
  );
}

export function archiveAuthProfileMigrationSource(
  receipt: AuthProfileMigrationSourceReceipt,
): void {
  if (fs.existsSync(receipt.sourcePath)) {
    const sourceBytes = fs.readFileSync(receipt.sourcePath);
    if (digestBytes(sourceBytes) !== receipt.sourceSha256) {
      throw new Error("legacy auth source changed after verification");
    }
    fs.renameSync(receipt.sourcePath, receipt.archivePath);
  }
  const archiveBytes = fs.readFileSync(receipt.archivePath);
  if (digestBytes(archiveBytes) !== receipt.sourceSha256) {
    throw new Error("legacy auth archive verification failed");
  }
}

export function acquireAuthProfileMigrationSourceLocks(sourcePaths: readonly string[]): () => void {
  const releases: Array<() => void> = [];
  try {
    for (const sourcePath of [
      ...new Set(sourcePaths.map((entry) => path.resolve(entry))),
    ].toSorted()) {
      releases.push(acquireFileLockSyncWithRetry(sourcePath));
    }
  } catch (error) {
    for (const release of releases.toReversed()) {
      release();
    }
    throw error;
  }
  return () => {
    for (const release of releases.toReversed()) {
      release();
    }
  };
}

function verifyAuthProfileMigrationTarget(receipt: AuthProfileMigrationSourceReceipt): void {
  const hasExpectedProfiles = Object.keys(receipt.expectedProfileSha256 ?? {}).length > 0;
  if (!hasExpectedProfiles && !receipt.expectedStateSha256) {
    return;
  }
  const db = openNodeSqliteDatabase(receipt.targetDatabasePath, { readOnly: true });
  try {
    const targetStoreKey = receipt.targetStoreKey ?? "primary";
    if (hasExpectedProfiles && receipt.expectedProfileSha256) {
      const row =
        targetStoreKey === "shared"
          ? executeSqliteQueryTakeFirstSync(
              db,
              getNodeSqliteKysely<SharedAuthProfileTargetDatabase>(db)
                .selectFrom("auth_profile_stores")
                .select("store_json")
                .where("store_key", "=", "shared"),
            )
          : executeSqliteQueryTakeFirstSync(
              db,
              getNodeSqliteKysely<AuthProfileTargetDatabase>(db)
                .selectFrom("auth_profile_store")
                .select("store_json")
                .where("store_key", "=", "primary"),
            );
      const store = typeof row?.store_json === "string" ? JSON.parse(row.store_json) : null;
      for (const [profileId, expectedSha256] of Object.entries(receipt.expectedProfileSha256)) {
        if (digestAuthProfileMigrationValue(store?.profiles?.[profileId]) !== expectedSha256) {
          throw new Error("auth profile migration target verification failed");
        }
      }
    }
    if (receipt.expectedStateSha256) {
      const row =
        targetStoreKey === "shared"
          ? executeSqliteQueryTakeFirstSync(
              db,
              getNodeSqliteKysely<SharedAuthProfileTargetDatabase>(db)
                .selectFrom("auth_profile_state")
                .select("state_json")
                .where("store_key", "=", "shared"),
            )
          : executeSqliteQueryTakeFirstSync(
              db,
              getNodeSqliteKysely<AuthProfileTargetDatabase>(db)
                .selectFrom("auth_profile_state")
                .select("state_json")
                .where("state_key", "=", "primary"),
            );
      const state = typeof row?.state_json === "string" ? JSON.parse(row.state_json) : null;
      if (digestAuthProfileMigrationValue(state) !== receipt.expectedStateSha256) {
        throw new Error("auth profile migration target verification failed");
      }
    }
  } finally {
    db.close();
  }
}

export function finalizeAuthProfileMigrationSource(
  receipt: AuthProfileMigrationSourceReceipt,
  status: "completed" | "archived-unparsed" = "completed",
  options: { sourceLocked?: boolean } = {},
): void {
  receipt.completionStatus = status;
  const release = options.sourceLocked
    ? undefined
    : acquireFileLockSyncWithRetry(receipt.sourcePath);
  try {
    recordAuthProfileMigrationImported(receipt);
    verifyAuthProfileMigrationTarget(receipt);
    archiveAuthProfileMigrationSource(receipt);
    recordAuthProfileMigrationCompleted(receipt, Date.now(), status);
  } finally {
    release?.();
  }
}

export function resumePendingAuthProfileMigrationArchives(env?: NodeJS.ProcessEnv): string[] {
  const changes: string[] = [];
  const database = openOpenClawStateDatabase({ env });
  const kysely = getNodeSqliteKysely<MigrationDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("migration_sources as source")
      .innerJoin("migration_runs as run", "run.id", "source.last_run_id")
      .select([
        "source.source_key",
        "source.source_path",
        "source.source_sha256",
        "source.source_size_bytes",
        "source.source_record_count",
        "source.target_table",
        "source.last_run_id",
        "source.report_json",
      ])
      .where("source.migration_kind", "=", MIGRATION_KIND)
      .where("source.status", "=", "imported")
      .where("source.removed_source", "=", 0),
  ).rows;
  for (const row of rows) {
    const report = JSON.parse(row.report_json) as Record<string, unknown>;
    if (
      typeof row.source_sha256 !== "string" ||
      typeof row.source_size_bytes !== "number" ||
      typeof row.source_record_count !== "number" ||
      typeof report.archivePath !== "string" ||
      typeof report.targetDatabasePath !== "string" ||
      (row.target_table !== "auth_profile_store" &&
        row.target_table !== "auth_profile_stores" &&
        row.target_table !== "auth_profile_state")
    ) {
      throw new Error("invalid pending auth profile migration receipt");
    }
    const receipt: AuthProfileMigrationSourceReceipt = {
      sourceKey: row.source_key,
      runId: row.last_run_id,
      sourcePath: row.source_path,
      sourceSha256: row.source_sha256,
      sourceSizeBytes: row.source_size_bytes,
      sourceRecordCount: row.source_record_count,
      targetDatabasePath: report.targetDatabasePath,
      targetTable: row.target_table,
      targetStoreKey: report.targetStoreKey === "shared" ? "shared" : "primary",
      archivePath: report.archivePath,
      ...(isRecordOfStrings(report.expectedProfileSha256)
        ? { expectedProfileSha256: report.expectedProfileSha256 }
        : {}),
      ...(typeof report.expectedStateSha256 === "string"
        ? { expectedStateSha256: report.expectedStateSha256 }
        : {}),
      completionStatus:
        report.completionStatus === "archived-unparsed" ? "archived-unparsed" : "completed",
      ...(env ? { env } : {}),
    };
    if (!fs.existsSync(receipt.sourcePath) && !fs.existsSync(receipt.archivePath)) {
      throw new Error("pending auth profile migration has neither source nor archive");
    }
    const lockTarget = fs.existsSync(receipt.sourcePath) ? receipt.sourcePath : receipt.archivePath;
    const release = acquireFileLockSyncWithRetry(lockTarget);
    try {
      const sourceExists = fs.existsSync(receipt.sourcePath);
      if (sourceExists) {
        const sourceBytes = fs.readFileSync(receipt.sourcePath);
        if (digestBytes(sourceBytes) !== receipt.sourceSha256) {
          // The imported receipt describes different bytes. Retire its claim so
          // Doctor can process the current source under a new hash-owned run.
          retirePendingAuthProfileMigrationReceipt(receipt, "superseded");
          changes.push("Retired an interrupted auth migration receipt for a changed source.");
          continue;
        }
      } else {
        const archiveBytes = fs.readFileSync(receipt.archivePath);
        if (digestBytes(archiveBytes) !== receipt.sourceSha256) {
          throw new Error("legacy auth archive verification failed");
        }
      }
      try {
        verifyAuthProfileMigrationTarget(receipt);
      } catch {
        if (!sourceExists) {
          // Restore only hash-verified archive bytes, without replacing a
          // source recreated by a non-cooperating legacy writer or restore.
          const restored = restoreAuthProfileMigrationArchiveNoClobber(receipt);
          if (restored === "source-exists") {
            const currentBytes = fs.readFileSync(receipt.sourcePath);
            const status =
              digestBytes(currentBytes) === receipt.sourceSha256 ? "retryable" : "superseded";
            retirePendingAuthProfileMigrationReceipt(receipt, status);
            changes.push(
              status === "retryable"
                ? "Reset an interrupted auth migration receipt for retry."
                : "Retired an interrupted auth migration receipt for a changed source.",
            );
            continue;
          }
        }
        retirePendingAuthProfileMigrationReceipt(receipt, "retryable");
        changes.push("Reset an interrupted auth migration receipt for retry.");
        continue;
      }
      archiveAuthProfileMigrationSource(receipt);
      recordAuthProfileMigrationCompleted(
        receipt,
        Date.now(),
        receipt.completionStatus ?? "completed",
      );
    } finally {
      release();
    }
    changes.push(`Finalized interrupted auth profile archive -> ${receipt.archivePath}`);
  }
  return changes;
}

export function hasTerminalAuthProfileMigrationReceipt(
  sourceKey: string,
  env?: NodeJS.ProcessEnv,
): boolean {
  const database = openOpenClawStateDatabase({ env });
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getNodeSqliteKysely<MigrationDatabase>(database.db)
      .selectFrom("migration_sources")
      .select("status")
      .where("source_key", "=", sourceKey),
  );
  return row?.status === "completed" || row?.status === "archived-unparsed";
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.authProfileMigrationReceiptsTestApi")
  ] = {
    recordAuthProfileMigrationImported,
    recordAuthProfileMigrationCompleted,
    restoreAuthProfileMigrationArchiveNoClobber,
  };
}
