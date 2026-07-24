// Durable receipts make legacy cron migration retries independent of mutable runtime rows.
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../infra/kysely-sync.js";
import { requireNodeSqlite, resolveNodeSqliteLocation } from "../../../infra/node-sqlite.js";
import type { DB as OpenClawStateDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import type { LegacyCronMigrationSource } from "./legacy-store-migration.js";

type CronMigrationDatabase = Pick<OpenClawStateDatabase, "migration_runs" | "migration_sources">;

function migrationRunId(source: LegacyCronMigrationSource): string {
  return `cron-legacy:${source.sourceKey}`;
}

function hasLegacyCronMigrationReceiptInDatabase(
  db: DatabaseSync,
  source: LegacyCronMigrationSource,
): boolean {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<CronMigrationDatabase>(db)
      .selectFrom("migration_sources")
      .select("status")
      .where("source_key", "=", source.sourceKey),
  );
  return row?.status === "completed";
}

export function hasLegacyCronMigrationReceipt(source: LegacyCronMigrationSource): boolean {
  return hasLegacyCronMigrationReceiptInDatabase(openOpenClawStateDatabase().db, source);
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) !== undefined
  );
}

export function hasLegacyCronMigrationReceiptReadOnly(source: LegacyCronMigrationSource): boolean {
  const statePath = resolveOpenClawStateSqlitePath(process.env);
  if (!fs.existsSync(statePath)) {
    return false;
  }
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(resolveNodeSqliteLocation(statePath), { readOnly: true });
  try {
    if (!tableExists(db, "migration_sources")) {
      return false;
    }
    return hasLegacyCronMigrationReceiptInDatabase(db, source);
  } finally {
    db.close();
  }
}

export function acquireLegacyCronMigrationReceipt(
  db: DatabaseSync,
  source: LegacyCronMigrationSource,
): boolean {
  if (hasLegacyCronMigrationReceiptInDatabase(db, source)) {
    return false;
  }
  const now = Date.now();
  const runId = migrationRunId(source);
  const reportJson = JSON.stringify({
    source: "legacy-cron-json",
    target: "cron_jobs",
    statePath: source.stateSha256 ? source.statePath : undefined,
    stateSha256: source.stateSha256,
  });
  const kysely = getNodeSqliteKysely<CronMigrationDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("migration_runs")
      .values({
        id: runId,
        started_at: now,
        finished_at: now,
        status: "completed",
        report_json: reportJson,
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          finished_at: now,
          status: "completed",
          report_json: reportJson,
        }),
      ),
  );
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("migration_sources")
      .values({
        source_key: source.sourceKey,
        migration_kind: "legacy-cron-json",
        source_path: source.sourcePath,
        target_table: "cron_jobs",
        source_sha256: source.sourceSha256,
        source_size_bytes: source.sourceSizeBytes,
        source_record_count: source.sourceRecordCount,
        last_run_id: runId,
        status: "completed",
        imported_at: now,
        removed_source: 0,
        report_json: reportJson,
      })
      .onConflict((conflict) =>
        conflict.column("source_key").doUpdateSet({
          last_run_id: runId,
          status: "completed",
          imported_at: now,
          removed_source: 0,
          report_json: reportJson,
        }),
      ),
  );
  return true;
}

export function markLegacyCronMigrationSourceRemoved(source: LegacyCronMigrationSource): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<CronMigrationDatabase>(db)
        .updateTable("migration_sources")
        .set({ removed_source: 1 })
        .where("source_key", "=", source.sourceKey),
    );
  });
}
