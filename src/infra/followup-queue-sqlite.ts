import type { DatabaseSync } from "node:sqlite";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type FollowupQueueDatabase = Pick<OpenClawStateKyselyDatabase, "followup_queue_entries">;

type FollowupQueueRow = {
  queue_key: string;
  queue_json: string;
  updated_at: number | bigint;
};

const ensuredDatabases = new WeakSet<DatabaseSync>();

const FOLLOWUP_QUEUE_ENTRIES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS followup_queue_entries (
  queue_key TEXT NOT NULL PRIMARY KEY,
  queue_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_followup_queue_entries_updated
  ON followup_queue_entries(updated_at DESC, queue_key);
`;

function databaseOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {};
}

function ensureFollowupQueueEntriesSchema(options: OpenClawStateDatabaseOptions = {}): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; queue rows use Kysely below.
      db.exec(FOLLOWUP_QUEUE_ENTRIES_SCHEMA_SQL);
    },
    options,
    { operationLabel: "followup-queue.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}

function openQueueDatabase(stateDir?: string) {
  const options = databaseOptions(stateDir);
  ensureFollowupQueueEntriesSchema(options);
  return openOpenClawStateDatabase(options);
}

export function listFollowupQueueKeys(stateDir?: string): string[] {
  const database = openQueueDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<FollowupQueueDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    queueDb.selectFrom("followup_queue_entries").select(["queue_key"]).orderBy("queue_key", "asc"),
  ).rows;
  return rows.map((row) => row.queue_key);
}

export function replaceFollowupQueueEntries(params: {
  entries: Array<[string, unknown]>;
  stateDir?: string;
  /** Keys that must survive even when they are absent from `entries` (unreadable rows). */
  retainKeys?: readonly string[];
}): void {
  const now = Date.now();
  // Always open through the caller-selected state root — never the process-default singleton.
  const options = databaseOptions(params.stateDir);
  ensureFollowupQueueEntriesSchema(options);
  runOpenClawStateWriteTransaction((database) => {
    const queueDb = getNodeSqliteKysely<FollowupQueueDatabase>(database.db);
    const nextKeys = new Set(params.entries.map(([key]) => key));
    const retainKeys = new Set(params.retainKeys ?? []);
    if (nextKeys.size === 0 && retainKeys.size === 0) {
      executeSqliteQuerySync(database.db, queueDb.deleteFrom("followup_queue_entries"));
      return;
    }
    const existing = executeSqliteQuerySync(
      database.db,
      queueDb.selectFrom("followup_queue_entries").select(["queue_key"]),
    ).rows;
    for (const row of existing) {
      if (!nextKeys.has(row.queue_key) && !retainKeys.has(row.queue_key)) {
        executeSqliteQuerySync(
          database.db,
          queueDb.deleteFrom("followup_queue_entries").where("queue_key", "=", row.queue_key),
        );
      }
    }
    for (const [queueKey, queueData] of params.entries) {
      executeSqliteQuerySync(
        database.db,
        queueDb
          .insertInto("followup_queue_entries")
          .values({
            queue_key: queueKey,
            queue_json: JSON.stringify(queueData),
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.column("queue_key").doUpdateSet({
              queue_json: (eb) => eb.ref("excluded.queue_json"),
              updated_at: (eb) => eb.ref("excluded.updated_at"),
            }),
          ),
      );
    }
  }, options);
}

function readFollowupQueueRows(stateDir?: string): FollowupQueueRow[] {
  const database = openQueueDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<FollowupQueueDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    queueDb
      .selectFrom("followup_queue_entries")
      .select(["queue_key", "queue_json", "updated_at"])
      .orderBy("updated_at", "asc")
      .orderBy("queue_key", "asc"),
  ).rows;
}

export function loadFollowupQueueEntries(stateDir?: string): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const row of readFollowupQueueRows(stateDir)) {
    try {
      entries.push([row.queue_key, JSON.parse(row.queue_json) as unknown]);
    } catch (err) {
      // Skip only the corrupt row so one bad payload does not block restoring the rest.
      console.warn(`Skipping corrupt followup queue entry ${row.queue_key}: ${String(err)}`);
    }
  }
  return entries;
}

/** Keys whose `queue_json` cannot be parsed. Ordinary persist must retain these. */
export function listUnreadableFollowupQueueKeys(stateDir?: string): string[] {
  const unreadable: string[] = [];
  for (const row of readFollowupQueueRows(stateDir)) {
    try {
      JSON.parse(row.queue_json);
    } catch {
      unreadable.push(row.queue_key);
    }
  }
  return unreadable;
}

export function hasFollowupQueueEntries(stateDir?: string): boolean {
  const database = openQueueDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<FollowupQueueDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    queueDb
      .selectFrom("followup_queue_entries")
      .select((eb) => eb.fn.countAll<number>().as("count")),
  );
  return (row?.count ?? 0) > 0;
}

export function followupQueueEntryContainsPrompt(
  queueKey: string,
  prompt: string,
  stateDir?: string,
): boolean {
  const database = openQueueDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<FollowupQueueDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    queueDb
      .selectFrom("followup_queue_entries")
      .select(["queue_json"])
      .where("queue_key", "=", queueKey),
  );
  return row?.queue_json?.includes(prompt) === true;
}
