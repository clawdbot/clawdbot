/** Cron run-history reads backed by authoritative task-ledger rows. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { normalizeAgentId } from "../routing/session-key.js";
import { listTaskRegistryRecordsByRuntimeSourceIdFromSqlite } from "../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import {
  cronTaskRecordStoreKey,
  cronTaskRecordToRunLogEntry,
  isCronDeliveryStatus,
  isCronRunStatus,
} from "./task-run-detail.js";
import type { CronDeliveryStatus, CronRunStatus } from "./types.js";

type CronRunHistorySortDir = "asc" | "desc";
type CronRunHistoryStatusFilter = "all" | CronRunStatus;

type ReadCronTaskRunHistoryPageOptions = {
  storeKey: string;
  limit?: number;
  offset?: number;
  jobId?: string;
  agentId?: string;
  runId?: string;
  status?: CronRunHistoryStatusFilter;
  statuses?: CronRunStatus[];
  deliveryStatus?: CronDeliveryStatus;
  deliveryStatuses?: CronDeliveryStatus[];
  query?: string;
  sortDir?: CronRunHistorySortDir;
  jobNameById?: Record<string, string>;
  /** Filter before paging so hidden runs cannot consume page slots or inflate totals. */
  entryFilter?: (entry: CronRunLogEntry) => boolean;
};

type CronTaskRunHistoryPage = {
  entries: CronRunLogEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
};

const INVALID_CRON_TASK_RUN_JOB_ID_MESSAGE = "invalid cron task run job id";

export function normalizeCronTaskRunJobId(jobId: string): string {
  const trimmed = jobId.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error(INVALID_CRON_TASK_RUN_JOB_ID_MESSAGE);
  }
  return trimmed;
}

export function isInvalidCronTaskRunJobIdError(error: unknown): boolean {
  return error instanceof Error && error.message === INVALID_CRON_TASK_RUN_JOB_ID_MESSAGE;
}

function normalizeStatuses(options: ReadCronTaskRunHistoryPageOptions): CronRunStatus[] | null {
  if (options.statuses?.length) {
    const statuses = options.statuses.filter(isCronRunStatus);
    if (statuses.length > 0) {
      return uniqueValues(statuses);
    }
  }
  return isCronRunStatus(options.status) ? [options.status] : null;
}

function normalizeDeliveryStatuses(
  options: ReadCronTaskRunHistoryPageOptions,
): CronDeliveryStatus[] | null {
  if (options.deliveryStatuses?.length) {
    const statuses = options.deliveryStatuses.filter(isCronDeliveryStatus);
    if (statuses.length > 0) {
      return uniqueValues(statuses);
    }
  }
  return isCronDeliveryStatus(options.deliveryStatus) ? [options.deliveryStatus] : null;
}

function queryText(entry: CronRunLogEntry, jobNameById?: Record<string, string>): string {
  return [
    entry.summary ?? "",
    entry.error ?? "",
    entry.errorReason ?? "",
    entry.diagnostics?.summary ?? "",
    ...(entry.diagnostics?.entries ?? []).map((diagnostic) => diagnostic.message),
    entry.jobId,
    jobNameById?.[entry.jobId] ?? "",
    entry.delivery?.intended?.channel ?? "",
    entry.delivery?.resolved?.channel ?? "",
    ...(entry.delivery?.messageToolSentTo ?? []).map((target) => target.channel),
  ].join(" ");
}

function compareHistoryRows(
  left: { entry: CronRunLogEntry; task: TaskRecord },
  right: { entry: CronRunLogEntry; task: TaskRecord },
  direction: CronRunHistorySortDir,
): number {
  const multiplier = direction === "asc" ? 1 : -1;
  return (
    multiplier * (left.entry.ts - right.entry.ts) ||
    multiplier * (left.task.createdAt - right.task.createdAt) ||
    multiplier * left.task.taskId.localeCompare(right.task.taskId)
  );
}

function attachJobNames(entries: CronRunLogEntry[], jobNameById?: Record<string, string>): void {
  for (const entry of entries) {
    const jobName = jobNameById?.[entry.jobId];
    if (jobName) {
      entry.jobName = jobName;
    }
  }
}

/** Reads and filters cron task rows with the legacy run-history paging contract. */
export function readCronTaskRunHistoryPage(
  options: ReadCronTaskRunHistoryPageOptions,
): CronTaskRunHistoryPage {
  const jobId = options.jobId ? normalizeCronTaskRunJobId(options.jobId) : undefined;
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const statuses = normalizeStatuses(options);
  const deliveryStatuses = normalizeDeliveryStatuses(options);
  const runId = normalizeOptionalString(options.runId);
  const agentId = options.agentId ? normalizeAgentId(options.agentId) : undefined;
  const query = normalizeLowercaseStringOrEmpty(options.query);
  const sortDir: CronRunHistorySortDir = options.sortDir === "asc" ? "asc" : "desc";
  const rows = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
    runtime: "cron",
    sourceId: jobId,
  })
    .filter((task) => cronTaskRecordStoreKey(task) === options.storeKey)
    .filter((task) => !agentId || task.agentId === agentId)
    .map((task) => ({ task, entry: cronTaskRecordToRunLogEntry(task) }))
    .filter((row): row is { task: TaskRecord; entry: CronRunLogEntry } => row.entry !== null)
    .filter(({ entry }) => {
      if (runId && entry.runId !== runId) {
        return false;
      }
      if (statuses && (!entry.status || !statuses.includes(entry.status))) {
        return false;
      }
      if (deliveryStatuses && !deliveryStatuses.includes(entry.deliveryStatus ?? "not-requested")) {
        return false;
      }
      return (
        (!query ||
          normalizeLowercaseStringOrEmpty(queryText(entry, options.jobNameById)).includes(query)) &&
        (!options.entryFilter || options.entryFilter(entry))
      );
    })
    .toSorted((left, right) => compareHistoryRows(left, right, sortDir));
  const total = rows.length;
  const boundedOffset = Math.min(total, offset);
  const entries = rows.slice(boundedOffset, boundedOffset + limit).map(({ entry }) => entry);
  attachJobNames(entries, options.jobNameById);
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
