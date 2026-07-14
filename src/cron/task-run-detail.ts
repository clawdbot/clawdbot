/** Read-side cron codec between task-ledger detail and the stable run-history wire shape.
 * Deliberately free of agent/runtime imports so history reads stay dependency-light;
 * the event->entry write codec lives in task-run-event-codec.ts. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { CRON_JOB_EXECUTION_TIMEOUT_ERROR } from "./execution-error-constants.js";
import { normalizeCronRunDiagnostics } from "./run-diagnostics-normalize.js";

type FailoverReason = import("../agents/embedded-agent-helpers/types.js").FailoverReason;
type JsonValue = import("../tasks/task-registry.types.js").JsonValue;
type TaskRecord = import("../tasks/task-registry.types.js").TaskRecord;
type TaskStatus = import("../tasks/task-registry.types.js").TaskStatus;
type CronRunLogEntry = import("./run-log-types.js").CronRunLogEntry;
type CronDeliveryStatus = import("./types.js").CronDeliveryStatus;
type CronRunStatus = import("./types.js").CronRunStatus;

const CRON_TASK_DETAIL_KIND = "cron-run";
const CRON_FAILOVER_REASONS = new Set<FailoverReason>([
  "auth",
  "auth_permanent",
  "format",
  "rate_limit",
  "overloaded",
  "billing",
  "server_error",
  "timeout",
  "model_not_found",
  "session_expired",
  "context_overflow",
  "empty_response",
  "no_error_details",
  "unclassified",
  "unknown",
]);

function toJsonValue(value: unknown): JsonValue | undefined {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : (JSON.parse(serialized) as JsonValue);
}

function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCronRunStatus(value: unknown): value is CronRunStatus {
  return value === "ok" || value === "error" || value === "skipped";
}

function normalizeCronRunLogErrorReason(value: unknown): FailoverReason | undefined {
  return typeof value === "string" && CRON_FAILOVER_REASONS.has(value as FailoverReason)
    ? (value as FailoverReason)
    : undefined;
}

/** Parses stored or migrated cron history while preserving the stable wire shape. */
export function parseCronRunLogEntryObject(
  obj: unknown,
  opts?: { jobId?: string },
): CronRunLogEntry | null {
  const jobId = normalizeOptionalString(opts?.jobId);
  if (!obj || typeof obj !== "object") {
    return null;
  }
  const entryObj = obj as Partial<CronRunLogEntry>;
  if (entryObj.action !== "finished") {
    return null;
  }
  if (typeof entryObj.jobId !== "string" || entryObj.jobId.trim().length === 0) {
    return null;
  }
  if (typeof entryObj.ts !== "number" || !Number.isFinite(entryObj.ts)) {
    return null;
  }
  if (jobId && entryObj.jobId !== jobId) {
    return null;
  }

  const usage =
    entryObj.usage && typeof entryObj.usage === "object"
      ? (entryObj.usage as Record<string, unknown>)
      : undefined;
  const normalizedError = typeof entryObj.error === "string" ? entryObj.error : undefined;
  const normalizedProvider =
    typeof entryObj.provider === "string" && entryObj.provider.trim()
      ? entryObj.provider
      : undefined;
  // Diagnostics are redacted at authoring; this read/migration path only normalizes stored shape.
  const entry: CronRunLogEntry = {
    ts: entryObj.ts,
    jobId: entryObj.jobId,
    action: "finished",
    status: entryObj.status,
    error: normalizedError,
    errorReason: normalizeCronRunLogErrorReason(entryObj.errorReason) ?? undefined,
    summary: entryObj.summary,
    runId: typeof entryObj.runId === "string" && entryObj.runId.trim() ? entryObj.runId : undefined,
    diagnostics: normalizeCronRunDiagnostics(entryObj.diagnostics),
    runAtMs: entryObj.runAtMs,
    durationMs: entryObj.durationMs,
    nextRunAtMs: entryObj.nextRunAtMs,
    triggerFired: entryObj.triggerFired === true ? true : undefined,
    model: typeof entryObj.model === "string" && entryObj.model.trim() ? entryObj.model : undefined,
    provider: normalizedProvider,
    usage: usage
      ? {
          input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
          output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
          total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
          cache_read_tokens:
            typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : undefined,
          cache_write_tokens:
            typeof usage.cache_write_tokens === "number" ? usage.cache_write_tokens : undefined,
        }
      : undefined,
  };
  if (typeof entryObj.delivered === "boolean") {
    entry.delivered = entryObj.delivered;
  }
  if (
    entryObj.deliveryStatus === "delivered" ||
    entryObj.deliveryStatus === "not-delivered" ||
    entryObj.deliveryStatus === "unknown" ||
    entryObj.deliveryStatus === "not-requested"
  ) {
    entry.deliveryStatus = entryObj.deliveryStatus as CronDeliveryStatus;
  }
  if (typeof entryObj.deliveryError === "string") {
    entry.deliveryError = entryObj.deliveryError;
  }
  if (
    entryObj.failureNotificationDelivery &&
    typeof entryObj.failureNotificationDelivery === "object"
  ) {
    const failureNotificationDelivery = entryObj.failureNotificationDelivery as {
      delivered?: unknown;
      status?: unknown;
      error?: unknown;
    };
    if (
      failureNotificationDelivery.status === "delivered" ||
      failureNotificationDelivery.status === "not-delivered" ||
      failureNotificationDelivery.status === "unknown" ||
      failureNotificationDelivery.status === "not-requested"
    ) {
      entry.failureNotificationDelivery = {
        status: failureNotificationDelivery.status,
        ...(typeof failureNotificationDelivery.delivered === "boolean"
          ? { delivered: failureNotificationDelivery.delivered }
          : {}),
        ...(typeof failureNotificationDelivery.error === "string"
          ? { error: failureNotificationDelivery.error }
          : {}),
      };
    }
  }
  if (entryObj.delivery && typeof entryObj.delivery === "object") {
    entry.delivery = entryObj.delivery;
  }
  if (typeof entryObj.sessionId === "string" && entryObj.sessionId.trim()) {
    entry.sessionId = entryObj.sessionId;
  }
  if (typeof entryObj.sessionKey === "string" && entryObj.sessionKey.trim()) {
    entry.sessionKey = entryObj.sessionKey;
  }
  return entry;
}

/** Encodes cron-only outcome fields; generic lifecycle fields stay on TaskRecord. */
export function cronRunLogEntryToTaskDetail(
  entry: CronRunLogEntry,
  options: {
    storeKey: string;
    triggerEval?: { fired: boolean; stateChanged: boolean; state?: unknown };
  },
): JsonValue {
  const detail = toJsonValue({
    kind: CRON_TASK_DETAIL_KIND,
    status: entry.status,
    storeKey: options.storeKey,
    errorReason: entry.errorReason,
    diagnostics: entry.diagnostics,
    delivered: entry.delivered,
    deliveryStatus: entry.deliveryStatus,
    deliveryError: entry.deliveryError,
    failureNotificationDelivery: entry.failureNotificationDelivery,
    delivery: entry.delivery,
    sessionId: entry.sessionId,
    // TaskRecord.runId remains the internal cancellation identity.
    runId: entry.runId,
    runAtMs: entry.runAtMs,
    durationMs: entry.durationMs,
    nextRunAtMs: entry.nextRunAtMs,
    triggerFired: entry.triggerFired,
    triggerStateChanged:
      options.triggerEval?.fired === true ? options.triggerEval.stateChanged : undefined,
    triggerState:
      options.triggerEval?.fired === true && options.triggerEval.stateChanged
        ? options.triggerEval.state
        : undefined,
    model: entry.model,
    provider: entry.provider,
    usage: entry.usage,
  });
  return detail ?? { kind: CRON_TASK_DETAIL_KIND };
}

/** Returns the cron store partition recorded on a task row. */
export function cronTaskRecordStoreKey(task: TaskRecord): string | undefined {
  return isJsonObject(task.detail) && typeof task.detail.storeKey === "string"
    ? task.detail.storeKey
    : undefined;
}

/** Reads internal trigger recovery data without adding it to run-history responses. */
export function cronTaskRecordToTriggerEval(
  task: TaskRecord,
): { fired: true; stateChanged: boolean; state?: JsonValue } | undefined {
  if (!isJsonObject(task.detail) || task.detail.triggerFired !== true) {
    return undefined;
  }
  return {
    fired: true,
    stateChanged: task.detail.triggerStateChanged === true,
    ...(task.detail.triggerStateChanged === true && "triggerState" in task.detail
      ? { state: task.detail.triggerState }
      : {}),
  };
}

/** Maps the cron outcome vocabulary onto generic task terminal states. */
export function cronRunStatusToTaskStatus(
  entry: CronRunLogEntry,
): Extract<TaskStatus, "succeeded" | "failed" | "timed_out"> {
  if (entry.status === "ok" || entry.status === "skipped") {
    return "succeeded";
  }
  return entry.error === CRON_JOB_EXECUTION_TIMEOUT_ERROR ? "timed_out" : "failed";
}

/** Reconstructs the unchanged CronRunLogEntry wire shape from a cron task row. */
export function cronTaskRecordToRunLogEntry(task: TaskRecord): CronRunLogEntry | null {
  if (task.runtime !== "cron" || !task.sourceId || !isJsonObject(task.detail)) {
    return null;
  }
  if (task.detail.kind !== CRON_TASK_DETAIL_KIND) {
    return null;
  }
  const wireDetail = { ...task.detail };
  delete wireDetail.storeKey;
  // Task detail is canonical write-time state; history reads do not rederive error reasons.
  const entry = parseCronRunLogEntryObject(
    {
      ...wireDetail,
      ts: task.endedAt ?? task.lastEventAt ?? task.createdAt,
      jobId: task.sourceId,
      action: "finished",
      status: isCronRunStatus(task.detail.status) ? task.detail.status : undefined,
      error: task.error,
      summary: task.terminalSummary,
      sessionKey: task.childSessionKey,
      runId: typeof task.detail.runId === "string" ? task.detail.runId : undefined,
    },
    { jobId: task.sourceId },
  );
  if (!entry) {
    return null;
  }
  // The legacy SQLite reader materializes these indexed columns even when absent.
  return {
    ...entry,
    delivered: entry.delivered,
    deliveryStatus: entry.deliveryStatus,
    deliveryError: entry.deliveryError,
    sessionId: entry.sessionId,
    sessionKey: entry.sessionKey,
  };
}
