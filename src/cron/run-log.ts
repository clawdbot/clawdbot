/** Public cron run-log API with serialized writes and paged reads. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { parseByteSize } from "../cli/parse-bytes.js";
import type { CronConfig } from "../config/types.cron.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import {
  countCronRunLogRows,
  insertCronRunLogEntry,
  parseStoredRunLogEntry,
  pruneCronRunLogRows,
  readCronRunLogRows,
  readCronRunLogRowsPage,
} from "./run-log/sqlite-store.js";
import { cronStoreKey } from "./store/key.js";
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

/** Returns whether an error came from cron run-log job id validation. */
export function isInvalidCronRunLogJobIdError(err: unknown): boolean {
  return err instanceof Error && err.message === INVALID_CRON_RUN_LOG_JOB_ID_MESSAGE;
}

const writesByTarget = new Map<string, Promise<void>>();

/** Legacy byte cap kept for config parsing compatibility with older file-backed run logs. */
export const DEFAULT_CRON_RUN_LOG_MAX_BYTES = 2_000_000;
/** Default SQLite row retention per cron job when no explicit keepLines value is configured. */
export const DEFAULT_CRON_RUN_LOG_KEEP_LINES = 2_000;

/** Resolves configured run-log pruning limits while preserving legacy maxBytes parsing. */
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

  // `maxBytes` remains accepted for older file-backed config. SQLite runtime
  // pruning uses row counts (`keepLines`) only.
  return { maxBytes, keepLines };
}

/** Exposes the in-process async write queue size for run-log concurrency tests. */
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

/** Appends a cron run-log row and serializes writes per store/job before pruning old rows. */
export async function appendCronRunLog(params: {
  storePath: string;
  entry: CronRunLogEntry;
  opts?: AppendCronRunLogOptions;
}) {
  const storeKey = cronStoreKey(params.storePath);
  const writeKey = cronRunLogWriteKey(params.storePath, params.entry.jobId);
  const prev = writesByTarget.get(writeKey) ?? Promise.resolve();
  // Keep writes for the same store/job ordered so prune-by-count cannot race a later insert.
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

/** Reads recent run-log entries in chronological order after draining pending async writes. */
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

/** Reads recent run-log entries synchronously for startup/task reconciliation paths. */
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

/** Reads a bounded, filterable run-log page for CLI and UI list views. */
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
    // Without a text query SQLite can page directly; query mode filters in JS
    // because diagnostics and derived job names are not all indexed columns.
    const total = countCronRunLogRows({
      db,
      storeKey,
      jobId,
      statuses,
      deliveryStatuses,
      runId: opts.runId,
    });
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

/** Reads a run-log page across all jobs for a specific cron store. */
export async function readCronRunLogEntriesPageAll(
  opts: ReadCronRunLogAllPageOptions,
): Promise<CronRunLogPageResult> {
  return readCronRunLogEntriesPage(opts);
}
