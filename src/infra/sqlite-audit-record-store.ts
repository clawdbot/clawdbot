// Shared SQLite storage for append-only diagnostic audit records.
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
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

type DiagnosticEventsTable = OpenClawStateKyselyDatabase["diagnostic_events"];
type AuditRecordDatabase = Pick<OpenClawStateKyselyDatabase, "diagnostic_events">;
type DiagnosticEventRow = Pick<
  Selectable<DiagnosticEventsTable>,
  "event_key" | "payload_json" | "created_at" | "sequence"
>;
type PreparedDiagnosticEventRow = Omit<DiagnosticEventRow, "sequence">;

const LEGACY_AUDIT_SEQUENCE_BASE = Number.MIN_SAFE_INTEGER;

type SqliteAuditRecordEntry<T> = {
  key: string;
  value: T;
  createdAt: number;
};

export type SequencedSqliteAuditRecordEntry<T> = SqliteAuditRecordEntry<T> & {
  sequence: number;
};

function getAuditRecordKysely(database: DatabaseSync) {
  return getNodeSqliteKysely<AuditRecordDatabase>(database);
}

function parseAuditRecord<T>(row: DiagnosticEventRow): SequencedSqliteAuditRecordEntry<T> {
  return {
    key: row.event_key,
    value: JSON.parse(row.payload_json) as T,
    createdAt: row.created_at,
    sequence: row.sequence,
  };
}

function countAuditRecords(database: DatabaseSync, scope: string): number {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getAuditRecordKysely(database)
      .selectFrom("diagnostic_events")
      .select((eb) => eb.fn.countAll<number | bigint>().as("count"))
      .where("scope", "=", scope),
  );
  return typeof row?.count === "bigint" ? Number(row.count) : (row?.count ?? 0);
}

function nextAuditSequence(params: {
  database: DatabaseSync;
  scope: string;
  legacy: boolean;
}): number {
  const row = executeSqliteQueryTakeFirstSync(
    params.database,
    getAuditRecordKysely(params.database)
      .selectFrom("diagnostic_events")
      .select((eb) => eb.fn.max<number>("sequence").as("sequence"))
      .where("scope", "=", params.scope)
      .where("sequence", params.legacy ? "<" : ">=", 0),
  );
  const current = row?.sequence ?? (params.legacy ? LEGACY_AUDIT_SEQUENCE_BASE : 0);
  const next = current + 1;
  if (!Number.isSafeInteger(next) || (params.legacy && next >= 0)) {
    throw new Error(`Audit sequence exhausted for scope ${params.scope}`);
  }
  return next;
}

function pruneAuditRecords(params: {
  database: DatabaseSync;
  scope: string;
  maxEntries: number;
  protectedKey?: string;
}): void {
  const overflow = countAuditRecords(params.database, params.scope) - params.maxEntries;
  if (overflow <= 0) {
    return;
  }
  const protectedKey = params.protectedKey;
  const baseCandidates = getAuditRecordKysely(params.database)
    .selectFrom("diagnostic_events")
    .select("event_key")
    .where("scope", "=", params.scope);
  const candidates = (
    protectedKey === undefined
      ? baseCandidates
      : baseCandidates.where("event_key", "!=", protectedKey)
  )
    .orderBy("sequence", "asc")
    .limit(overflow);
  const rows = executeSqliteQuerySync(params.database, candidates).rows;
  for (const row of rows) {
    executeSqliteQuerySync(
      params.database,
      getAuditRecordKysely(params.database)
        .deleteFrom("diagnostic_events")
        .where("scope", "=", params.scope)
        .where("event_key", "=", row.event_key),
    );
  }
}

/** Opens one bounded append-only audit scope in the shared state database. */
export function createSqliteAuditRecordStore<T>(
  options: OpenClawStateDatabaseOptions & { scope: string; maxEntries: number },
) {
  const scope = options.scope;
  const maxEntries = Math.max(1, Math.floor(options.maxEntries));
  function prepareRecord(record: SqliteAuditRecordEntry<T>): PreparedDiagnosticEventRow {
    const payloadJson = JSON.stringify(record.value);
    if (payloadJson === undefined) {
      throw new Error(`Audit record ${scope}/${record.key} is not JSON-serializable`);
    }
    return {
      event_key: record.key,
      payload_json: payloadJson,
      created_at: record.createdAt,
    };
  }

  function insertRecord(database: DatabaseSync, record: DiagnosticEventRow): void {
    executeSqliteQuerySync(
      database,
      getAuditRecordKysely(database)
        .insertInto("diagnostic_events")
        .values({
          scope,
          event_key: record.event_key,
          payload_json: record.payload_json,
          created_at: record.created_at,
          sequence: record.sequence,
        })
        .onConflict((conflict) => conflict.columns(["scope", "event_key"]).doNothing()),
    );
  }

  return {
    register(key: string, value: T, createdAt = Date.now()): void {
      const record = prepareRecord({ key, value, createdAt });
      runOpenClawStateWriteTransaction((database) => {
        insertRecord(database.db, {
          ...record,
          sequence: nextAuditSequence({ database: database.db, scope, legacy: false }),
        });
        // Audit retention is scope-local. Keep the just-written row and evict the oldest
        // prior rows in the same synchronous commit section.
        pruneAuditRecords({
          database: database.db,
          scope,
          maxEntries,
          protectedKey: key,
        });
      }, options);
    },
    upsert(key: string, value: T, createdAt = Date.now()): void {
      const record = prepareRecord({ key, value, createdAt });
      runOpenClawStateWriteTransaction((database) => {
        executeSqliteQuerySync(
          database.db,
          getAuditRecordKysely(database.db)
            .insertInto("diagnostic_events")
            .values({
              scope,
              event_key: record.event_key,
              payload_json: record.payload_json,
              created_at: record.created_at,
              sequence: nextAuditSequence({ database: database.db, scope, legacy: false }),
            })
            .onConflict((conflict) =>
              conflict.columns(["scope", "event_key"]).doUpdateSet({
                payload_json: record.payload_json,
                created_at: record.created_at,
              }),
            ),
        );
        pruneAuditRecords({
          database: database.db,
          scope,
          maxEntries,
          protectedKey: key,
        });
      }, options);
    },
    delete(key: string): void {
      runOpenClawStateWriteTransaction((database) => {
        executeSqliteQuerySync(
          database.db,
          getAuditRecordKysely(database.db)
            .deleteFrom("diagnostic_events")
            .where("scope", "=", scope)
            .where("event_key", "=", key),
        );
      }, options);
    },
    compareAndSet(
      key: string,
      expectedValue: T | null,
      value: T | null,
      createdAt = Date.now(),
    ): boolean {
      const expectedPayloadJson = expectedValue === null ? null : JSON.stringify(expectedValue);
      const record = value === null ? null : prepareRecord({ key, value, createdAt });
      let updated = false;
      runOpenClawStateWriteTransaction((database) => {
        const current = executeSqliteQueryTakeFirstSync(
          database.db,
          getAuditRecordKysely(database.db)
            .selectFrom("diagnostic_events")
            .select("payload_json")
            .where("scope", "=", scope)
            .where("event_key", "=", key),
        );
        if ((current?.payload_json ?? null) !== expectedPayloadJson) {
          return;
        }
        if (record) {
          executeSqliteQuerySync(
            database.db,
            getAuditRecordKysely(database.db)
              .insertInto("diagnostic_events")
              .values({
                scope,
                event_key: record.event_key,
                payload_json: record.payload_json,
                created_at: record.created_at,
                sequence: nextAuditSequence({ database: database.db, scope, legacy: false }),
              })
              .onConflict((conflict) =>
                conflict.columns(["scope", "event_key"]).doUpdateSet({
                  payload_json: record.payload_json,
                  created_at: record.created_at,
                }),
              ),
          );
          pruneAuditRecords({ database: database.db, scope, maxEntries, protectedKey: key });
        } else {
          executeSqliteQuerySync(
            database.db,
            getAuditRecordKysely(database.db)
              .deleteFrom("diagnostic_events")
              .where("scope", "=", scope)
              .where("event_key", "=", key),
          );
        }
        updated = true;
      }, options);
      return updated;
    },
    registerLegacyMany(records: readonly SqliteAuditRecordEntry<T>[]): void {
      const prepared = records.map(prepareRecord);
      if (prepared.length === 0) {
        return;
      }
      // Legacy imports can contain tens of thousands of rows. Serialize first,
      // then assign ordered negative sequences before runtime audit history.
      runOpenClawStateWriteTransaction((database) => {
        let sequence = nextAuditSequence({ database: database.db, scope, legacy: true });
        for (const record of prepared) {
          insertRecord(database.db, { ...record, sequence });
          sequence += 1;
        }
        pruneAuditRecords({ database: database.db, scope, maxEntries });
      }, options);
    },
    size(): number {
      return countAuditRecords(openOpenClawStateDatabase(options).db, scope);
    },
    entries(): SqliteAuditRecordEntry<T>[] {
      const database = openOpenClawStateDatabase(options);
      return executeSqliteQuerySync(
        database.db,
        getAuditRecordKysely(database.db)
          .selectFrom("diagnostic_events")
          .select(["event_key", "payload_json", "created_at", "sequence"])
          .where("scope", "=", scope)
          .orderBy("sequence", "asc"),
      ).rows.map((row) => {
        const { sequence: _sequence, ...entry } = parseAuditRecord<T>(row);
        return entry;
      });
    },
    latest(params: {
      limit: number;
      beforeSequence?: number;
    }): SequencedSqliteAuditRecordEntry<T>[] {
      const limit = Math.max(0, Math.floor(params.limit));
      if (limit === 0) {
        return [];
      }
      const database = openOpenClawStateDatabase(options);
      const baseQuery = getAuditRecordKysely(database.db)
        .selectFrom("diagnostic_events")
        .select(["event_key", "payload_json", "created_at", "sequence"])
        .where("scope", "=", scope);
      const query =
        params.beforeSequence === undefined
          ? baseQuery
          : baseQuery.where("sequence", "<", params.beforeSequence);
      return executeSqliteQuerySync(
        database.db,
        query.orderBy("sequence", "desc").limit(limit),
      ).rows.map((row) => parseAuditRecord<T>(row));
    },
  };
}
