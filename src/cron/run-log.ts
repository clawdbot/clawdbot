import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import type { Insertable, Selectable } from "kysely";
import { parseByteSize } from "../cli/parse-bytes.js";
import type { CronConfig } from "../config/types.cron.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { parseCronRunLogEntriesFromJsonl } from "./run-log-jsonl.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import type { CronDeliveryStatus, CronRunStatus } from "./types.js";

export type { CronRunLogEntry } from "./run-log-types.js";

type CronRunLogSortDir = "asc" | "desc";
type CronRunLogStatusFilter = "all" | "ok" | "error" | "skipped";

type ReadCronRunLogPageOptions = {
  limit?: number;
  offset?: number;
  jobId?: string;
  runId?: string;
  status?: CronRunLogStatusFilter;
  statuses?: CronRunStatus[];
  deliveryStatus?: CronDeliveryStatus;
  deliveryStatuses?: CronDeliveryStatus[];
  query?: string;
  sortDir?: CronRunLogSortDir;
};

type CronRunLogPageResult = {
  entries: CronRunLogEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
};

type ReadCronRunLogAllPageOptions = Omit<ReadCronRunLogPageOptions, "jobId"> & {
  storePath: string;
  jobNameById?: Record<string, string>;
};

type AppendCronRunLogOptions = {
  keepLines?: number | false;
};

type CronRunLogsTable = OpenClawStateKyselyDatabase["cron_run_logs"];
type CronRunLogDatabase = Pick<OpenClawStateKyselyDatabase, "cron_run_logs">;
type CronRunLogRow = Selectable<CronRunLogsTable>;
type CronRunLogInsert = Insertable<CronRunLogsTable>;

const INVALID_CRON_RUN_LOG_JOB_ID_MESSAGE = "invalid cron run log job id";

function assertSafeCronRunLogJobId(jobId: string): string {
  const trimmed = jobId.trim();
  if (!trimmed) {
    throw new Error(INVALID_CRON_RUN_LOG_JOB_ID_MESSAGE);
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error(INVALID_CRON_RUN_LOG_JOB_ID_MESSAGE);
  }
  return trimmed;
}

export function isInvalidCronRunLogJobIdError(err: unknown): boolean {
  return err instanceof Error && err.message === INVALID_CRON_RUN_LOG_JOB_ID_MESSAGE;
}

const writesByTarget = new Map<string, Promise<void>>();

export const DEFAULT_CRON_RUN_LOG_MAX_BYTES = 2_000_000;
export const DEFAULT_CRON_RUN_LOG_KEEP_LINES = 2_000;

export function resolveCronRunLogPruneOptions(cfg?: CronConfig["runLog"]): {
  maxBytes: number;
  keepLines: number;
} {
  let maxBytes = DEFAULT_CRON_RUN_LOG_MAX_BYTES;
  if (cfg?.maxBytes !== undefined) {
    try {
      const configuredMaxBytes = normalizeStringifiedOptionalString(cfg.maxBytes);
      if (configuredMaxBytes) {
        maxBytes = parseByteSize(configuredMaxBytes, { defaultUnit: "b" });
      }
    } catch {
      maxBytes = DEFAULT_CRON_RUN_LOG_MAX_BYTES;
    }
  }

  let keepLines = DEFAULT_CRON_RUN_LOG_KEEP_LINES;
  if (typeof cfg?.keepLines === "number" && Number.isFinite(cfg.keepLines) && cfg.keepLines > 0) {
    keepLines = Math.floor(cfg.keepLines);
  }

  return { maxBytes, keepLines };
}

export function getPendingCronRunLogWriteCountForTests() {
  return writesByTarget.size;
}

function cronRunLogWriteKey(storePath: string, jobId?: string): string {
  return `${cronStoreKey(storePath)}\0${jobId ?? ""}`;
}

async function drainPendingWrite(storePath: string, jobId?: string): Promise<void> {
  if (jobId) {
    await writesByTarget.get(cronRunLogWriteKey(storePath, jobId))?.catch(() => undefined);
    return;
  }
  const storePrefix = `${cronStoreKey(storePath)}\0`;
  const pending = [...writesByTarget.entries()]
    .filter(([key]) => key.startsWith(storePrefix))
    .map(([, write]) => write.catch(() => undefined));
  await Promise.all(pending);
}

function cronStoreKey(storePath: string): string {
  return path.resolve(storePath);
}

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

function parseStoredRunLogEntry(row: CronRunLogRow): CronRunLogEntry | null {
  const parsed = parseCronRunLogEntriesFromJsonl(`${row.entry_json}\n`, { jobId: row.job_id })[0];
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

function readCronRunLogRows(db: DatabaseSync, storeKey: string, jobId?: string): CronRunLogRow[] {
  let query = getCronRunLogKysely(db)
    .selectFrom("cron_run_logs")
    .selectAll()
    .where("store_key", "=", storeKey);
  if (jobId) {
    query = query.where("job_id", "=", jobId);
  }
  return executeSqliteQuerySync(db, query.orderBy("ts", "asc").orderBy("seq", "asc")).rows;
}

function buildRunLogWhereClause(params: {
  storeKey: string;
  jobId?: string;
  statuses: CronRunStatus[] | null;
  deliveryStatuses: CronDeliveryStatus[] | null;
  runId?: string;
}): { whereSql: string; values: Array<string | number> } {
  const clauses = ["store_key = ?"];
  const values: Array<string | number> = [params.storeKey];
  if (params.jobId) {
    clauses.push("job_id = ?");
    values.push(params.jobId);
  }
  if (params.statuses?.length) {
    clauses.push(`status IN (${params.statuses.map(() => "?").join(", ")})`);
    values.push(...params.statuses);
  }
  if (params.deliveryStatuses?.length) {
    clauses.push(
      `COALESCE(delivery_status, 'not-requested') IN (${params.deliveryStatuses
        .map(() => "?")
        .join(", ")})`,
    );
    values.push(...params.deliveryStatuses);
  }
  const runId = normalizeOptionalString(params.runId);
  if (runId) {
    clauses.push("run_id = ?");
    values.push(runId);
  }
  return { whereSql: clauses.join(" AND "), values };
}

function countCronRunLogRows(
  db: DatabaseSync,
  whereSql: string,
  values: Array<string | number>,
): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM cron_run_logs WHERE ${whereSql}`)
    .get(...values) as { count?: number | bigint } | undefined;
  return normalizeNumber(row?.count ?? null) ?? 0;
}

function readCronRunLogRowsPage(params: {
  db: DatabaseSync;
  storeKey: string;
  jobId?: string;
  statuses: CronRunStatus[] | null;
  deliveryStatuses: CronDeliveryStatus[] | null;
  runId?: string;
  sortDir: CronRunLogSortDir;
  offset?: number;
  limit?: number;
}): CronRunLogRow[] {
  const { whereSql, values } = buildRunLogWhereClause(params);
  const order = params.sortDir === "asc" ? "ASC" : "DESC";
  const limitSql =
    params.limit === undefined || params.offset === undefined ? "" : " LIMIT ? OFFSET ?";
  const limitValues =
    params.limit === undefined || params.offset === undefined ? [] : [params.limit, params.offset];
  return params.db
    .prepare(
      `SELECT * FROM cron_run_logs WHERE ${whereSql} ORDER BY ts ${order}, seq ${order}${limitSql}`,
    )
    .all(...values, ...limitValues) as CronRunLogRow[];
}

function nextCronRunLogSeq(db: DatabaseSync, storeKey: string, jobId: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM cron_run_logs WHERE store_key = ? AND job_id = ?",
    )
    .get(storeKey, jobId) as { seq?: number | bigint } | undefined;
  return (normalizeNumber(row?.seq ?? null) ?? 0) + 1;
}

function insertCronRunLogEntry(db: DatabaseSync, storeKey: string, entry: CronRunLogEntry): void {
  const seq = nextCronRunLogSeq(db, storeKey, entry.jobId);
  executeSqliteQuerySync(
    db,
    getCronRunLogKysely(db)
      .insertInto("cron_run_logs")
      .values(bindCronRunLogRow({ storeKey, seq, entry })),
  );
}

function pruneCronRunLogRows(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
  keepLines: number,
): void {
  const keep = Math.max(1, Math.floor(keepLines));
  db.prepare(
    `DELETE FROM cron_run_logs
     WHERE store_key = ? AND job_id = ?
       AND seq NOT IN (
         SELECT seq FROM cron_run_logs
         WHERE store_key = ? AND job_id = ?
         ORDER BY seq DESC
         LIMIT ?
       )`,
  ).run(storeKey, jobId, storeKey, jobId, keep);
}

export async function appendCronRunLog(params: {
  storePath: string;
  entry: CronRunLogEntry;
  opts?: AppendCronRunLogOptions;
}) {
  const storeKey = cronStoreKey(params.storePath);
  const writeKey = cronRunLogWriteKey(params.storePath, params.entry.jobId);
  const prev = writesByTarget.get(writeKey) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      runOpenClawStateWriteTransaction(({ db }) => {
        insertCronRunLogEntry(db, storeKey, params.entry);
        if (params.opts?.keepLines !== false) {
          pruneCronRunLogRows(
            db,
            storeKey,
            params.entry.jobId,
            params.opts?.keepLines ?? DEFAULT_CRON_RUN_LOG_KEEP_LINES,
          );
        }
      });
    });
  writesByTarget.set(writeKey, next);
  try {
    await next;
  } finally {
    if (writesByTarget.get(writeKey) === next) {
      writesByTarget.delete(writeKey);
    }
  }
}

export async function readCronRunLogEntries(params: {
  storePath: string;
  jobId?: string;
  limit?: number;
}): Promise<CronRunLogEntry[]> {
  await drainPendingWrite(params.storePath, params.jobId);
  const limit = Math.max(1, Math.min(5000, Math.floor(params.limit ?? 200)));
  const page = await readCronRunLogEntriesPage({
    storePath: params.storePath,
    jobId: params.jobId,
    limit,
    offset: 0,
    status: "all",
    sortDir: "desc",
  });
  return page.entries.toReversed();
}

export function readCronRunLogEntriesSync(params: {
  storePath: string;
  jobId?: string;
  limit?: number;
}): CronRunLogEntry[] {
  const limit = Math.max(1, Math.min(5000, Math.floor(params.limit ?? 200)));
  const storeKey = cronStoreKey(params.storePath);
  const jobId = params.jobId ? assertSafeCronRunLogJobId(params.jobId) : undefined;
  const rows = readCronRunLogRows(openOpenClawStateDatabase().db, storeKey, jobId);
  return rows
    .map(parseStoredRunLogEntry)
    .filter((entry): entry is CronRunLogEntry => entry !== null)
    .slice(-limit);
}

function normalizeRunStatusFilter(status?: string): CronRunLogStatusFilter {
  if (status === "ok" || status === "error" || status === "skipped" || status === "all") {
    return status;
  }
  return "all";
}

function normalizeRunStatuses(opts?: {
  statuses?: CronRunStatus[];
  status?: CronRunLogStatusFilter;
}): CronRunStatus[] | null {
  if (Array.isArray(opts?.statuses) && opts.statuses.length > 0) {
    const filtered = opts.statuses.filter(
      (status): status is CronRunStatus =>
        status === "ok" || status === "error" || status === "skipped",
    );
    if (filtered.length > 0) {
      return uniqueValues(filtered);
    }
  }
  const status = normalizeRunStatusFilter(opts?.status);
  if (status === "all") {
    return null;
  }
  return [status];
}

function normalizeDeliveryStatuses(opts?: {
  deliveryStatuses?: CronDeliveryStatus[];
  deliveryStatus?: CronDeliveryStatus;
}): CronDeliveryStatus[] | null {
  if (Array.isArray(opts?.deliveryStatuses) && opts.deliveryStatuses.length > 0) {
    const filtered = opts.deliveryStatuses.filter(
      (status): status is CronDeliveryStatus =>
        status === "delivered" ||
        status === "not-delivered" ||
        status === "unknown" ||
        status === "not-requested",
    );
    if (filtered.length > 0) {
      return uniqueValues(filtered);
    }
  }
  if (
    opts?.deliveryStatus === "delivered" ||
    opts?.deliveryStatus === "not-delivered" ||
    opts?.deliveryStatus === "unknown" ||
    opts?.deliveryStatus === "not-requested"
  ) {
    return [opts.deliveryStatus];
  }
  return null;
}

function runIdMatches(entry: CronRunLogEntry, runId?: string): boolean {
  const normalized = normalizeOptionalString(runId);
  return !normalized || entry.runId === normalized;
}

function filterRunLogEntries(
  entries: CronRunLogEntry[],
  opts: {
    runId?: string;
    statuses: CronRunStatus[] | null;
    deliveryStatuses: CronDeliveryStatus[] | null;
    query: string;
    queryTextForEntry: (entry: CronRunLogEntry) => string;
  },
): CronRunLogEntry[] {
  return entries.filter((entry) => {
    if (!runIdMatches(entry, opts.runId)) {
      return false;
    }
    if (opts.statuses && (!entry.status || !opts.statuses.includes(entry.status))) {
      return false;
    }
    if (opts.deliveryStatuses) {
      const deliveryStatus = entry.deliveryStatus ?? "not-requested";
      if (!opts.deliveryStatuses.includes(deliveryStatus)) {
        return false;
      }
    }
    if (!opts.query) {
      return true;
    }
    return normalizeLowercaseStringOrEmpty(opts.queryTextForEntry(entry)).includes(opts.query);
  });
}

export async function readCronRunLogEntriesPage(
  opts: ReadCronRunLogPageOptions & { storePath: string; jobNameById?: Record<string, string> },
): Promise<CronRunLogPageResult> {
  const jobId = opts.jobId ? assertSafeCronRunLogJobId(opts.jobId) : undefined;
  await drainPendingWrite(opts.storePath, jobId);
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const statuses = normalizeRunStatuses(opts);
  const deliveryStatuses = normalizeDeliveryStatuses(opts);
  const query = normalizeLowercaseStringOrEmpty(opts.query);
  const sortDir: CronRunLogSortDir = opts.sortDir === "asc" ? "asc" : "desc";
  const db = openOpenClawStateDatabase().db;
  const storeKey = cronStoreKey(opts.storePath);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  if (!query) {
    const { whereSql, values } = buildRunLogWhereClause({
      storeKey,
      jobId,
      statuses,
      deliveryStatuses,
      runId: opts.runId,
    });
    const total = countCronRunLogRows(db, whereSql, values);
    const boundedOffset = Math.min(total, offset);
    const entries = readCronRunLogRowsPage({
      db,
      storeKey,
      jobId,
      statuses,
      deliveryStatuses,
      runId: opts.runId,
      sortDir,
      offset: boundedOffset,
      limit,
    })
      .map(parseStoredRunLogEntry)
      .filter((entry): entry is CronRunLogEntry => entry !== null);
    if (opts.jobNameById) {
      for (const entry of entries) {
        const jobName = opts.jobNameById[entry.jobId];
        if (jobName) {
          (entry as CronRunLogEntry & { jobName?: string }).jobName = jobName;
        }
      }
    }
    const nextOffset = boundedOffset + entries.length;
    return {
      entries,
      total,
      offset: boundedOffset,
      limit,
      hasMore: nextOffset < total,
      nextOffset: nextOffset < total ? nextOffset : null,
    };
  }

  const all = readCronRunLogRowsPage({
    db,
    storeKey,
    jobId,
    statuses,
    deliveryStatuses,
    runId: opts.runId,
    sortDir,
  })
    .map(parseStoredRunLogEntry)
    .filter((entry): entry is CronRunLogEntry => entry !== null);
  const filtered = filterRunLogEntries(all, {
    runId: opts.runId,
    statuses: null,
    deliveryStatuses: null,
    query,
    queryTextForEntry: (entry) => {
      const jobName = opts.jobNameById?.[entry.jobId] ?? "";
      return [
        entry.summary ?? "",
        entry.error ?? "",
        entry.errorReason ?? "",
        entry.diagnostics?.summary ?? "",
        ...(entry.diagnostics?.entries ?? []).map((diagnostic) => diagnostic.message),
        entry.jobId,
        jobName,
        entry.delivery?.intended?.channel ?? "",
        entry.delivery?.resolved?.channel ?? "",
        ...(entry.delivery?.messageToolSentTo ?? []).map((target) => target.channel),
      ].join(" ");
    },
  });
  const sorted =
    sortDir === "asc"
      ? filtered.toSorted((a, b) => a.ts - b.ts)
      : filtered.toSorted((a, b) => b.ts - a.ts);
  const total = sorted.length;
  const boundedOffset = Math.min(total, offset);
  const entries = sorted.slice(boundedOffset, boundedOffset + limit);
  if (opts.jobNameById) {
    for (const entry of entries) {
      const jobName = opts.jobNameById[entry.jobId];
      if (jobName) {
        (entry as CronRunLogEntry & { jobName?: string }).jobName = jobName;
      }
    }
  }
  const nextOffset = boundedOffset + entries.length;
  return {
    entries,
    total,
    offset: boundedOffset,
    limit,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
}

export async function readCronRunLogEntriesPageAll(
  opts: ReadCronRunLogAllPageOptions,
): Promise<CronRunLogPageResult> {
  return readCronRunLogEntriesPage(opts);
}
