import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type MigrationReceiptDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "migration_runs" | "migration_sources"
>;

export type LegacyMigrationReceipt = {
  sourceKey: string;
  sourceSha256: string | null;
  removedSource: boolean;
  reportJson: string;
};

type LegacyMigrationRun = {
  runId: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  reportJson: string;
  upsert?: boolean;
};

type LegacyMigrationSource = {
  sourceKey: string;
  migrationKind: string;
  sourcePath: string;
  targetTable: string;
  sourceSha256: string | null;
  sourceSizeBytes: number | null;
  sourceRecordCount: number | null;
  runId: string;
  status: string;
  importedAt: number;
  reportJson: string;
  upsert?: boolean;
  updateReportOnConflict?: boolean;
};

/** Source keys are persisted contracts; scoped owners hash their scope before the path. */
export function resolveLegacyMigrationSourceKey(
  prefix: string,
  sourcePath: string,
  scope?: string,
): string {
  const hash = createHash("sha256");
  if (scope !== undefined) {
    hash.update(scope).update("\0");
  }
  return `${prefix}:${hash.update(path.resolve(sourcePath)).digest("hex")}`;
}

export function readLegacyMigrationReceiptFromDatabase(
  database: DatabaseSync,
  sourceKey: string,
): LegacyMigrationReceipt | null {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<MigrationReceiptDatabase>(database)
      .selectFrom("migration_sources")
      .select(["source_sha256", "removed_source", "report_json"])
      .where("source_key", "=", sourceKey),
  );
  return row
    ? {
        sourceKey,
        sourceSha256: row.source_sha256,
        removedSource: row.removed_source === 1,
        reportJson: row.report_json,
      }
    : null;
}

export function readLegacyMigrationReceipt(
  sourceKey: string,
  env: NodeJS.ProcessEnv,
): LegacyMigrationReceipt | null {
  return readLegacyMigrationReceiptFromDatabase(openOpenClawStateDatabase({ env }).db, sourceKey);
}

export function recordLegacyMigrationRun(database: DatabaseSync, run: LegacyMigrationRun): void {
  const query = getNodeSqliteKysely<MigrationReceiptDatabase>(database)
    .insertInto("migration_runs")
    .values({
      id: run.runId,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      status: run.status,
      report_json: run.reportJson,
    });
  executeSqliteQuerySync(
    database,
    run.upsert
      ? query.onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            finished_at: run.finishedAt,
            status: run.status,
            report_json: run.reportJson,
          }),
        )
      : query,
  );
}

export function recordLegacyMigrationSource(
  database: DatabaseSync,
  source: LegacyMigrationSource,
): void {
  const query = getNodeSqliteKysely<MigrationReceiptDatabase>(database)
    .insertInto("migration_sources")
    .values({
      source_key: source.sourceKey,
      migration_kind: source.migrationKind,
      source_path: source.sourcePath,
      target_table: source.targetTable,
      source_sha256: source.sourceSha256,
      source_size_bytes: source.sourceSizeBytes,
      source_record_count: source.sourceRecordCount,
      last_run_id: source.runId,
      status: source.status,
      imported_at: source.importedAt,
      removed_source: 0,
      report_json: source.reportJson,
    });
  executeSqliteQuerySync(
    database,
    source.upsert
      ? query.onConflict((conflict) =>
          conflict.column("source_key").doUpdateSet({
            source_sha256: source.sourceSha256,
            source_size_bytes: source.sourceSizeBytes,
            source_record_count: source.sourceRecordCount,
            last_run_id: source.runId,
            status: source.status,
            imported_at: source.importedAt,
            removed_source: 0,
            ...(source.updateReportOnConflict === false ? {} : { report_json: source.reportJson }),
          }),
        )
      : query,
  );
}

/** Insert run and source together inside the caller's existing synchronous transaction. */
export function recordLegacyMigrationReceipt(
  database: DatabaseSync,
  receipt: Omit<LegacyMigrationSource, "status" | "importedAt" | "updateReportOnConflict"> & {
    now: number;
  },
): void {
  recordLegacyMigrationRun(database, {
    runId: receipt.runId,
    startedAt: receipt.now,
    finishedAt: receipt.now,
    status: "completed",
    reportJson: receipt.reportJson,
    upsert: receipt.upsert,
  });
  recordLegacyMigrationSource(database, {
    ...receipt,
    status: "completed",
    importedAt: receipt.now,
  });
}

export function markLegacyMigrationSourceRemoved(
  sourceKey: string,
  env: NodeJS.ProcessEnv,
  operationLabel?: string,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<MigrationReceiptDatabase>(db)
          .updateTable("migration_sources")
          .set({ removed_source: 1 })
          .where("source_key", "=", sourceKey),
      );
    },
    { env },
    operationLabel ? { operationLabel } : {},
  );
}
