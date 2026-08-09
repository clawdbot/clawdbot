/** One-shot import of legacy cron run history into the authoritative task ledger. */
import type { DatabaseSync } from "node:sqlite";
import {
  cronRunLogEntryToTaskDetail,
  cronRunStatusToTaskStatus,
  parseCronRunLogEntryObject,
} from "../cron/task-run-detail.js";
import { normalizeSqliteNumber } from "./sqlite-number.js";

type CronRunLogEntry = import("../cron/run-log-types.js").CronRunLogEntry;
type CronDeliveryStatus = import("../cron/types.js").CronDeliveryStatus;
type CronRunStatus = import("../cron/types.js").CronRunStatus;

const CRON_RUN_LOG_TASK_IMPORT_MIGRATION_ID = "state:cron-run-logs-to-task-runs:v1";

const CRON_RUN_LOG_IMPORT_BATCH_SIZE = 500;

type LegacyCronRunLogRow = {
  store_key: string;
  job_id: string;
  seq: number | bigint;
  ts: number | bigint;
  status?: string | null;
  error?: string | null;
  summary?: string | null;
  delivery_status?: string | null;
  delivery_error?: string | null;
  delivered?: number | bigint | null;
  session_id?: string | null;
  session_key?: string | null;
  run_id?: string | null;
  run_at_ms?: number | bigint | null;
  duration_ms?: number | bigint | null;
  next_run_at_ms?: number | bigint | null;
  model?: string | null;
  provider?: string | null;
  entry_json?: string | null;
};

type MirroredTask = {
  source_id: string | null;
  ended_at: number | bigint | null;
  detail_json: string | null;
};

type MirroredIdentity = { endedAt: number | null; runId?: string };

type CronRunLogTaskImportResult = {
  imported: number;
  alreadyMirrored: number;
  malformed: number;
  skipped: boolean;
};

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name),
  );
}

function parseDetail(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function collectMirroredTasks(db: DatabaseSync): Map<string, MirroredIdentity[]> {
  const rows = db
    .prepare(
      `SELECT source_id, ended_at, detail_json
       FROM task_runs
       WHERE runtime = 'cron' AND source_id IS NOT NULL AND detail_json IS NOT NULL`,
    )
    .all() as MirroredTask[];
  const bySource = new Map<string, MirroredIdentity[]>();
  for (const row of rows) {
    const detail = parseDetail(row.detail_json);
    if (!row.source_id || detail?.kind !== "cron-run") {
      continue;
    }
    const identities = bySource.get(row.source_id) ?? [];
    identities.push({
      endedAt: normalizeSqliteNumber(row.ended_at) ?? null,
      ...(typeof detail.runId === "string" && detail.runId ? { runId: detail.runId } : {}),
    });
    bySource.set(row.source_id, identities);
  }
  return bySource;
}

function hasMirroredIdentity(
  identities: MirroredIdentity[],
  runId: string | undefined,
  endedAt: number,
): boolean {
  // Mirroring is intentionally an existence check scoped only by source ID:
  // store partitions and duplicate legacy rows do not consume task identities.
  return identities.some((identity) =>
    runId && identity.runId ? identity.runId === runId : identity.endedAt === endedAt,
  );
}

function integerToBoolean(value: number | bigint | null | undefined): boolean | undefined {
  return value === null || value === undefined ? undefined : Number(value) !== 0;
}

/** Legacy rows trust write-time errorReason and diagnostic redaction without recomputation. */
function parseLegacyRow(row: LegacyCronRunLogRow): CronRunLogEntry | null {
  let rawEntry: unknown;
  try {
    rawEntry = JSON.parse(row.entry_json ?? "");
  } catch {
    return null;
  }
  const parsed = parseCronRunLogEntryObject(rawEntry, { jobId: row.job_id });
  if (!parsed) {
    return null;
  }
  return {
    ...parsed,
    ts: normalizeSqliteNumber(row.ts) ?? parsed.ts,
    jobId: row.job_id,
    status: (row.status as CronRunStatus | null | undefined) ?? parsed.status,
    error: row.error ?? parsed.error,
    summary: row.summary ?? parsed.summary,
    delivered: integerToBoolean(row.delivered) ?? parsed.delivered,
    deliveryStatus:
      (row.delivery_status as CronDeliveryStatus | null | undefined) ?? parsed.deliveryStatus,
    deliveryError: row.delivery_error ?? parsed.deliveryError,
    sessionId: row.session_id ?? parsed.sessionId,
    sessionKey: row.session_key ?? parsed.sessionKey,
    runId: row.run_id ?? parsed.runId,
    runAtMs: normalizeSqliteNumber(row.run_at_ms ?? null) ?? parsed.runAtMs,
    durationMs: normalizeSqliteNumber(row.duration_ms ?? null) ?? parsed.durationMs,
    nextRunAtMs: normalizeSqliteNumber(row.next_run_at_ms ?? null) ?? parsed.nextRunAtMs,
    model: row.model ?? parsed.model,
    provider: row.provider ?? parsed.provider,
  };
}

function ordinalKey(jobId: string, ts: number): string {
  return `${jobId}\0${ts}`;
}

/** Runs inside the state schema transaction and removes the retired table after import. */
export function migrateLegacyCronRunLogsToTaskRuns(db: DatabaseSync): CronRunLogTaskImportResult {
  if (!tableExists(db, "cron_run_logs")) {
    return { imported: 0, alreadyMirrored: 0, malformed: 0, skipped: true };
  }

  const mirrored = collectMirroredTasks(db);
  const ordinals = new Map<string, number>();
  const insert = db.prepare(`
    INSERT INTO task_runs (
      task_id, runtime, task_kind, source_id, requester_session_key, owner_key, scope_kind,
      child_session_key, parent_flow_id, parent_task_id, agent_id, requester_agent_id, run_id,
      label, task, status, delivery_status, notify_policy, created_at, started_at, ended_at,
      last_event_at, cleanup_after, error, progress_summary, terminal_summary, terminal_outcome,
      detail_json
    ) VALUES (
      @task_id, 'cron', NULL, @source_id, '', '', 'system', @child_session_key, NULL, NULL,
      NULL, NULL, @run_id, NULL, @task, @status, 'not_applicable', 'silent', @created_at,
      @started_at, @ended_at, @ended_at, NULL, @error, NULL, @terminal_summary,
      @terminal_outcome, @detail_json
    )
  `);
  let imported = 0;
  let alreadyMirrored = 0;
  let malformed = 0;
  let offset = 0;
  while (true) {
    const rows = db
      .prepare(
        `SELECT * FROM cron_run_logs
         ORDER BY job_id, ts, store_key, seq
         LIMIT ? OFFSET ?`,
      )
      .all(CRON_RUN_LOG_IMPORT_BATCH_SIZE, offset) as LegacyCronRunLogRow[];
    if (rows.length === 0) {
      break;
    }
    offset += rows.length;
    for (const row of rows) {
      const entry = parseLegacyRow(row);
      if (!entry) {
        malformed++;
        continue;
      }
      const key = ordinalKey(entry.jobId, entry.ts);
      const ordinal = (ordinals.get(key) ?? 0) + 1;
      ordinals.set(key, ordinal);
      const identities = mirrored.get(entry.jobId) ?? [];
      if (hasMirroredIdentity(identities, entry.runId, entry.ts)) {
        alreadyMirrored++;
        continue;
      }
      const taskId = `cron-runlog-import:${entry.jobId}:${entry.ts}:${ordinal}`;
      const status = cronRunStatusToTaskStatus(entry);
      insert.run({
        task_id: taskId,
        source_id: entry.jobId,
        child_session_key: entry.sessionKey ?? null,
        run_id: taskId,
        task: entry.jobId,
        status,
        created_at: entry.runAtMs ?? entry.ts,
        started_at: entry.runAtMs ?? null,
        ended_at: entry.ts,
        error: entry.error ?? null,
        terminal_summary: entry.summary ?? null,
        terminal_outcome: status === "succeeded" ? "succeeded" : null,
        detail_json: JSON.stringify(
          cronRunLogEntryToTaskDetail(entry, { storeKey: row.store_key }),
        ),
      });
      imported++;
    }
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_cron_run_logs_store_ts;
    DROP INDEX IF EXISTS idx_cron_run_logs_job_status;
    DROP INDEX IF EXISTS idx_cron_run_logs_delivery;
    DROP TABLE cron_run_logs;
  `);
  const result = { imported, alreadyMirrored, malformed, skipped: false };
  const now = Date.now();
  db.prepare(
    `INSERT INTO migration_runs (id, started_at, finished_at, status, report_json)
     VALUES (?, ?, ?, 'completed', ?)
     ON CONFLICT(id) DO UPDATE SET
       finished_at = excluded.finished_at,
       status = excluded.status,
       report_json = excluded.report_json`,
  ).run(CRON_RUN_LOG_TASK_IMPORT_MIGRATION_ID, now, now, JSON.stringify(result));
  return result;
}
