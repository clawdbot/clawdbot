/** Kysely row types and table facade for the cron_jobs SQLite table. */
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";

type CronJobsTable = OpenClawStateKyselyDatabase["cron_jobs"];
type CronStoreDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "cron_job_scratch" | "cron_jobs" | "cron_store_epochs"
>;

/** Read shape for rows in the cron_jobs SQLite table. */
export type CronJobRow = Selectable<CronJobsTable>;

/** Insert/update shape for rows in the cron_jobs SQLite table. */
export type CronJobInsert = Insertable<CronJobsTable>;

/** Creates the Kysely facade scoped to cron_jobs for synchronous SQLite access. */
export function getCronStoreKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<CronStoreDatabase>(db);
}

export function ensureCronStoreEpochSchema(db: DatabaseSync): void {
  db.exec(/* sqlite-allow-raw: additive schema DDL is outside Kysely's query builder. */ `
    CREATE TABLE IF NOT EXISTS cron_store_epochs (
      store_key TEXT PRIMARY KEY,
      store_epoch INTEGER NOT NULL DEFAULT 0
    ) STRICT
  `);
}
