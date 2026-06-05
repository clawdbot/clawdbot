/** SQLite-backed cron run-log storage helpers. */
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable, SelectQueryBuilder } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type { CronRunLogEntry } from "../run-log-types.js";
import type { CronDeliveryStatus, CronRunStatus } from "../types.js";
import { parseCronRunLogEntryObject } from "./entry-codec.js";

type CronRunLogsTable = OpenClawStateKyselyDatabase["cron_run_logs"];
type CronRunLogDatabase = Pick<OpenClawStateKyselyDatabase, "cron_run_logs">;
type CronRunLogRow = Selectable<CronRunLogsTable>;
type CronRunLogInsert = Insertable<CronRunLogsTable>;
type CronRunLogFilterParams = {
  storeKey: string;
  jobId?: string;
  statuses: CronRunStatus[] | null;
  deliveryStatuses: CronDeliveryStatus[] | null;
  runId?: string;
};

function getCronRunLogKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<CronRunLogDatabase>(db);
}

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function booleanToInteger(value: boolean | undefined): number | null {
  return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

function integerToBoolean(value: number | bigint | null): boolean | undefined {
  const normalized = normalizeNumber(value);
  return normalized == null ? undefined : normalized !== 0;
}

function bindCronRunLogRow(params: {
  storeKey: string;
  seq: number;
  entry: CronRunLogEntry;
}): CronRunLogInsert {
  const entry = params.entry;
  // Store indexed columns for filtering and the original JSON payload for
  // forward-compatible fields that are not yet indexed.
  return {
    store_key: params.storeKey,
    job_id: entry.jobId,
    seq: params.seq,
    ts: entry.ts,
    status: entry.status ?? null,
    error: entry.error ?? null,
    summary: entry.summary ?? null,
    diagnostics_summary: entry.diagnostics?.summary ?? null,
    delivery_status: entry.deliveryStatus ?? null,
    delivery_error: entry.deliveryError ?? null,
    delivered: booleanToInteger(entry.delivered),
    session_id: entry.sessionId ?? null,
    session_key: entry.sessionKey ?? null,
    run_id: entry.runId ?? null,
    run_at_ms: entry.runAtMs ?? null,
    duration_ms: entry.durationMs ?? null,
    next_run_at_ms: entry.nextRunAtMs ?? null,
    model: entry.model ?? null,
    provider: entry.provider ?? null,
    total_tokens: entry.usage?.total_tokens ?? null,
    entry_json: JSON.stringify(entry),
    created_at: Date.now(),
  };
}

/** Rehydrates a cron run-log row, preferring indexed SQLite columns over JSON payload values. */
export function parseStoredRunLogEntry(row: CronRunLogRow): CronRunLogEntry | null {
  let rawEntry: unknown;
  try {
    rawEntry = JSON.parse(row.entry_json);
  } catch {
    return null;
  }
  const parsed = parseCronRunLogEntryObject(rawEntry, { jobId: row.job_id });
  if (!parsed) {
    return null;
  }
  return {
    ...parsed,
    ts: normalizeNumber(row.ts) ?? parsed.ts,
    jobId: row.job_id,
    status: (row.status as CronRunStatus | null) ?? parsed.status,
    error: row.error ?? parsed.error,
    summary: row.summary ?? parsed.summary,
    delivered: integerToBoolean(row.delivered) ?? parsed.delivered,
    deliveryStatus: (row.delivery_status as CronDeliveryStatus | null) ?? parsed.deliveryStatus,
    deliveryError: row.delivery_error ?? parsed.deliveryError,
    sessionId: row.session_id ?? parsed.sessionId,
    sessionKey: row.session_key ?? parsed.sessionKey,
    runId: row.run_id ?? parsed.runId,
    runAtMs: normalizeNumber(row.run_at_ms) ?? parsed.runAtMs,
    durationMs: normalizeNumber(row.duration_ms) ?? parsed.durationMs,
    nextRunAtMs: normalizeNumber(row.next_run_at_ms) ?? parsed.nextRunAtMs,
    model: row.model ?? parsed.model,
    provider: row.provider ?? parsed.provider,
  };
}

/** Reads run-log rows for one store, optionally scoped to one job, in chronological order. */
export function readCronRunLogRows(
  db: DatabaseSync,
  storeKey: string,
  jobId?: string,
): CronRunLogRow[] {
  let query = getCronRunLogKysely(db)
    .selectFrom("cron_run_logs")
    .selectAll()
    .where("store_key", "=", storeKey);
  if (jobId) {
    query = query.where("job_id", "=", jobId);
  }
  return executeSqliteQuerySync(db, query.orderBy("ts", "asc").orderBy("seq", "asc")).rows;
}

function applyRunLogFilters<Output>(
  query: SelectQueryBuilder<CronRunLogDatabase, "cron_run_logs", Output>,
  params: CronRunLogFilterParams,
): SelectQueryBuilder<CronRunLogDatabase, "cron_run_logs", Output> {
  let next = query.where("store_key", "=", params.storeKey);
  if (params.jobId) {
    next = next.where("job_id", "=", params.jobId);
  }
  if (params.statuses?.length) {
    next = next.where("status", "in", params.statuses);
  }
  if (params.deliveryStatuses?.length) {
    next = next.where((eb) =>
      eb.or(
        params.deliveryStatuses!.map((status) =>
          // Older rows stored an omitted delivery status as SQL NULL; keep
          // not-requested filters compatible with both representations.
          status === "not-requested"
            ? eb.or([eb("delivery_status", "is", null), eb("delivery_status", "=", status)])
            : eb("delivery_status", "=", status),
        ),
      ),
    );
  }
  const runId = params.runId?.trim();
  if (runId) {
    next = next.where("run_id", "=", runId);
  }
  return next;
}

/** Counts run-log rows after applying the same filters used by paged reads. */
export function countCronRunLogRows(params: {
  db: DatabaseSync;
  storeKey: string;
  jobId?: string;
  statuses: CronRunStatus[] | null;
  deliveryStatuses: CronDeliveryStatus[] | null;
  runId?: string;
}): number {
  const row = executeSqliteQueryTakeFirstSync(
    params.db,
    applyRunLogFilters(
      getCronRunLogKysely(params.db)
        .selectFrom("cron_run_logs")
        .select((eb) => eb.fn.countAll<number | bigint>().as("count")),
      params,
    ),
  );
  return normalizeNumber(row?.count ?? null) ?? 0;
}

/** Reads a sorted, filtered page of cron run-log rows. */
export function readCronRunLogRowsPage(params: {
  db: DatabaseSync;
  storeKey: string;
  jobId?: string;
  statuses: CronRunStatus[] | null;
  deliveryStatuses: CronDeliveryStatus[] | null;
  runId?: string;
  sortDir: "asc" | "desc";
  offset?: number;
  limit?: number;
}): CronRunLogRow[] {
  let query = applyRunLogFilters(
    getCronRunLogKysely(params.db).selectFrom("cron_run_logs").selectAll(),
    params,
  )
    .orderBy("ts", params.sortDir)
    .orderBy("seq", params.sortDir);
  if (params.limit !== undefined && params.offset !== undefined) {
    query = query.limit(params.limit).offset(params.offset);
  }
  return executeSqliteQuerySync(params.db, query).rows;
}

function nextCronRunLogSeq(db: DatabaseSync, storeKey: string, jobId: string): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getCronRunLogKysely(db)
      .selectFrom("cron_run_logs")
      .select((eb) => eb.fn.max<number | bigint>("seq").as("seq"))
      .where("store_key", "=", storeKey)
      .where("job_id", "=", jobId),
  );
  return (normalizeNumber(row?.seq ?? null) ?? 0) + 1;
}

/** Appends a cron run-log entry with a per-job monotonic sequence number. */
export function insertCronRunLogEntry(
  db: DatabaseSync,
  storeKey: string,
  entry: CronRunLogEntry,
): void {
  const seq = nextCronRunLogSeq(db, storeKey, entry.jobId);
  executeSqliteQuerySync(
    db,
    getCronRunLogKysely(db)
      .insertInto("cron_run_logs")
      .values(bindCronRunLogRow({ storeKey, seq, entry })),
  );
}

/** Prunes old cron run-log rows for one job, retaining the newest keepLines rows. */
export function pruneCronRunLogRows(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
  keepLines: number,
): void {
  const keep = Math.max(1, Math.floor(keepLines));
  const keepSeqs = getCronRunLogKysely(db)
    .selectFrom("cron_run_logs")
    .select("seq")
    .where("store_key", "=", storeKey)
    .where("job_id", "=", jobId)
    .orderBy("seq", "desc")
    .limit(keep);
  executeSqliteQuerySync(
    db,
    getCronRunLogKysely(db)
      .deleteFrom("cron_run_logs")
      .where("store_key", "=", storeKey)
      .where("job_id", "=", jobId)
      .where("seq", "not in", keepSeqs),
  );
}
