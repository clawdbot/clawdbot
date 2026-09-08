/** Read-side cron codec between task-ledger detail and the stable run-history wire shape.
 * Deliberately free of agent/runtime imports so history reads stay dependency-light;
 * the event->entry write codec lives in task-run-event-codec.ts. */
import {
  asSafeIntegerInRange,
  MAX_DATE_TIMESTAMP_MS,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import {
  FAILOVER_REASONS,
  type FailoverReason,
} from "../../packages/gateway-protocol/src/failover-reasons.js";
import { resolveCronCompletionStatus } from "./completion-status.js";
import { isCronTimeoutErrorText } from "./execution-error-constants.js";
import { normalizeCronRunDiagnosticsCore } from "./run-diagnostics-normalize.js";

type JsonValue = import("../tasks/task-registry.types.js").JsonValue;
type TaskRecord = import("../tasks/task-registry.types.js").TaskRecord;
type TaskStatus = import("../tasks/task-registry.types.js").TaskStatus;
type CronRunLogEntry = import("./run-log-types.js").CronRunLogEntry;
type CronDeliveryStatus = import("./types.js").CronDeliveryStatus;
type CronRunStatus = import("./types.js").CronRunStatus;

const CRON_TASK_DETAIL_KIND = "cron-run";
const CRON_FAILOVER_REASONS = new Set(FAILOVER_REASONS);
const cronRunStatusSchema = z.enum(["ok", "error", "skipped"]);
const cronCompletionStatusSchema = z.enum(["succeeded", "failed", "unknown"]);
const cronDeliveryStatusSchema = z.enum(["delivered", "not-delivered", "unknown", "not-requested"]);
const optionalCronStringSchema = z.string().optional().catch(undefined);
const optionalNonBlankCronStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0)
  .optional()
  .catch(undefined);
const optionalCronTimestampSchema = z
  .unknown()
  .optional()
  .transform((value) => normalizeTimestamp(value));
const optionalCronDurationSchema = z
  .unknown()
  .optional()
  .transform((value) => asSafeIntegerInRange(value, { min: 0 }));
const optionalCronTokenCountSchema = z
  .unknown()
  .optional()
  .transform((value) => asSafeIntegerInRange(value, { min: 0 }));
const cronUsageSchema = z
  .object({
    input_tokens: optionalCronTokenCountSchema,
    output_tokens: optionalCronTokenCountSchema,
    total_tokens: optionalCronTokenCountSchema,
    cache_read_tokens: optionalCronTokenCountSchema,
    cache_write_tokens: optionalCronTokenCountSchema,
  })
  .transform((usage) =>
    Object.values(usage).some((tokenCount) => tokenCount !== undefined) ? usage : undefined,
  )
  .optional()
  .catch(undefined);
const cronFailureNotificationDeliverySchema = z
  .looseObject({
    status: cronDeliveryStatusSchema,
    delivered: z.boolean().optional().catch(undefined),
    error: optionalCronStringSchema,
  })
  .transform(({ status, delivered, error }) => ({
    status,
    ...(delivered !== undefined ? { delivered } : {}),
    ...(error !== undefined ? { error } : {}),
  }))
  .optional()
  .catch(undefined);
const cronRunLogEntrySchema = z.looseObject({
  action: z.literal("finished"),
  jobId: z.string().refine((value) => value.trim().length > 0),
  ts: z
    .unknown()
    .transform((value) => normalizeTimestamp(value))
    .pipe(z.number()),
  status: cronRunStatusSchema.optional().catch(undefined),
  completionStatus: cronCompletionStatusSchema.optional().catch(undefined),
  error: optionalCronStringSchema,
  errorReason: z
    .custom<FailoverReason>(
      (value) => typeof value === "string" && CRON_FAILOVER_REASONS.has(value as FailoverReason),
    )
    .optional()
    .catch(undefined),
  summary: optionalCronStringSchema,
  runId: optionalNonBlankCronStringSchema,
  diagnostics: z.unknown().optional(),
  runAtMs: optionalCronTimestampSchema,
  durationMs: optionalCronDurationSchema,
  nextRunAtMs: optionalCronTimestampSchema,
  triggerFired: z
    .unknown()
    .optional()
    .transform((value) => (value === true ? true : undefined)),
  model: optionalNonBlankCronStringSchema,
  provider: optionalNonBlankCronStringSchema,
  usage: cronUsageSchema,
  delivered: z.boolean().optional().catch(undefined),
  deliveryStatus: cronDeliveryStatusSchema.optional().catch(undefined),
  deliveryError: optionalCronStringSchema,
  deliverySuppressionReason: z
    .enum(["empty", "silent", "heartbeat", "channel_transform"])
    .optional()
    .catch(undefined),
  failureNotificationDelivery: cronFailureNotificationDeliverySchema,
  delivery: z.custom<{ [key: string]: JsonValue }>(isJsonObject).optional().catch(undefined),
  sessionId: optionalNonBlankCronStringSchema,
  sessionKey: optionalNonBlankCronStringSchema,
});

function toJsonValue(value: unknown): JsonValue | undefined {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : (JSON.parse(serialized) as JsonValue);
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return isRecord(value);
}

function normalizeTimestamp(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 0, max: MAX_DATE_TIMESTAMP_MS });
}

export function isCronRunStatus(value: unknown): value is CronRunStatus {
  return cronRunStatusSchema.safeParse(value).success;
}

export function isCronDeliveryStatus(value: unknown): value is CronDeliveryStatus {
  return cronDeliveryStatusSchema.safeParse(value).success;
}

/** Parses stored or migrated cron history while preserving the stable wire shape. */
export function parseCronRunLogEntryObject(
  obj: unknown,
  opts?: { jobId?: string },
): CronRunLogEntry | null {
  const jobId = normalizeOptionalString(opts?.jobId);
  const parsed = cronRunLogEntrySchema.safeParse(obj);
  if (!parsed.success) {
    return null;
  }
  const entryObj = parsed.data;
  if (jobId && entryObj.jobId !== jobId) {
    return null;
  }

  // Diagnostics are redacted at authoring; this read/migration path only normalizes stored shape.
  const entry: CronRunLogEntry = {
    ts: entryObj.ts,
    jobId: entryObj.jobId,
    action: "finished",
    status: entryObj.status,
    completionStatus:
      entryObj.completionStatus ??
      resolveCronCompletionStatus({
        status: entryObj.status,
        delivered: entryObj.delivered,
        deliveryStatus: entryObj.deliveryStatus,
      }),
    error: entryObj.error,
    errorReason: entryObj.errorReason,
    summary: entryObj.summary,
    runId: entryObj.runId,
    diagnostics: normalizeCronRunDiagnosticsCore(entryObj.diagnostics),
    runAtMs: entryObj.runAtMs,
    durationMs: entryObj.durationMs,
    nextRunAtMs: entryObj.nextRunAtMs,
    triggerFired: entryObj.triggerFired,
    model: entryObj.model,
    provider: entryObj.provider,
    usage: entryObj.usage,
  };
  if (entryObj.delivered !== undefined) {
    entry.delivered = entryObj.delivered;
  }
  if (entryObj.deliveryStatus !== undefined) {
    entry.deliveryStatus = entryObj.deliveryStatus;
  }
  if (entryObj.deliveryError !== undefined) {
    entry.deliveryError = entryObj.deliveryError;
  }
  if (entryObj.deliverySuppressionReason !== undefined) {
    entry.deliverySuppressionReason = entryObj.deliverySuppressionReason;
  }
  if (entryObj.failureNotificationDelivery !== undefined) {
    entry.failureNotificationDelivery = entryObj.failureNotificationDelivery;
  }
  if (entryObj.delivery !== undefined) {
    entry.delivery = entryObj.delivery;
  }
  if (entryObj.sessionId !== undefined) {
    entry.sessionId = entryObj.sessionId;
  }
  if (entryObj.sessionKey !== undefined) {
    entry.sessionKey = entryObj.sessionKey;
  }
  return entry;
}

/** Encodes cron-owned outcome fields; the generic lifecycle projection stays on TaskRecord. */
export function cronRunLogEntryToTaskDetail(
  entry: CronRunLogEntry,
  options: {
    storeKey: string;
    triggerEval?: { fired: boolean; stateChanged: boolean; state?: unknown };
    scriptResult?: { scriptStateChanged?: boolean; scriptState?: unknown };
  },
): JsonValue {
  const detail = toJsonValue({
    kind: CRON_TASK_DETAIL_KIND,
    status: entry.status,
    completionStatus: entry.completionStatus,
    error: entry.error ?? null,
    summary: entry.summary ?? null,
    storeKey: options.storeKey,
    errorReason: entry.errorReason,
    diagnostics: entry.diagnostics,
    delivered: entry.delivered,
    deliveryStatus: entry.deliveryStatus,
    deliveryError: entry.deliveryError,
    deliverySuppressionReason: entry.deliverySuppressionReason,
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
    scriptStateChanged: options.scriptResult?.scriptStateChanged === true ? true : undefined,
    scriptState:
      options.scriptResult?.scriptStateChanged === true
        ? options.scriptResult.scriptState
        : undefined,
    model: entry.model,
    provider: entry.provider,
    usage: entry.usage,
  });
  return detail ?? { kind: CRON_TASK_DETAIL_KIND };
}

/** Stores quiet-trigger recovery facts without creating a run-history detail row. */
export function cronQuietTriggerTaskDetail(
  storeKey: string,
  triggerEval: { fired: false; stateChanged: boolean; state?: unknown },
): JsonValue {
  return (
    toJsonValue({
      storeKey,
      triggerFired: false,
      triggerStateChanged: triggerEval.stateChanged,
      ...(triggerEval.stateChanged ? { triggerState: triggerEval.state } : {}),
    }) ?? { storeKey, triggerFired: false, triggerStateChanged: false }
  );
}

/** Returns the cron store partition recorded on a task row. */
export function cronTaskRecordStoreKey(task: TaskRecord): string | undefined {
  return isJsonObject(task.detail) && typeof task.detail.storeKey === "string"
    ? task.detail.storeKey
    : undefined;
}

/** Keeps history projection, recovery, and retention on one task-row timestamp. */
export function resolveCronTaskRecordTimestamp(
  task: Pick<TaskRecord, "endedAt" | "lastEventAt" | "createdAt">,
): number {
  return task.endedAt ?? task.lastEventAt ?? task.createdAt;
}

/** Reads internal trigger recovery data without adding it to run-history responses. */
export function cronTaskRecordToTriggerEval(
  task: TaskRecord,
): { fired: boolean; stateChanged: boolean; state?: JsonValue } | undefined {
  if (!isJsonObject(task.detail) || typeof task.detail.triggerFired !== "boolean") {
    return undefined;
  }
  return {
    fired: task.detail.triggerFired,
    stateChanged: task.detail.triggerStateChanged === true,
    ...(task.detail.triggerStateChanged === true && "triggerState" in task.detail
      ? { state: task.detail.triggerState }
      : {}),
  };
}

/** Reads internal payload-script recovery data without exposing it in run history. */
export function cronTaskRecordToScriptRunResult(
  task: TaskRecord,
): { scriptStateChanged: true; scriptState?: JsonValue } | undefined {
  if (!isJsonObject(task.detail) || task.detail.scriptStateChanged !== true) {
    return undefined;
  }
  return {
    scriptStateChanged: true,
    ...(Object.hasOwn(task.detail, "scriptState") ? { scriptState: task.detail.scriptState } : {}),
  };
}

/** Maps the cron outcome vocabulary onto generic task terminal states. */
export function cronRunStatusToTaskStatus(
  entry: Pick<CronRunLogEntry, "status" | "error"> & Partial<CronRunLogEntry>,
): Extract<TaskStatus, "succeeded" | "failed" | "timed_out"> {
  if (entry.status === "ok") {
    const completionStatus =
      entry.completionStatus ??
      resolveCronCompletionStatus({
        status: entry.status,
        delivered: entry.delivered,
        deliveryStatus: entry.deliveryStatus,
      });
    return completionStatus === "succeeded" ? "succeeded" : "failed";
  }
  return entry.status === "error" && isCronTimeoutErrorText(entry.error) ? "timed_out" : "failed";
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
      // Released rows stored these only on the generic task; current detail wins
      // when task cancellation and the underlying execution have different outcomes.
      error: task.error,
      summary: task.terminalSummary,
      ...wireDetail,
      ts: resolveCronTaskRecordTimestamp(task),
      jobId: task.sourceId,
      action: "finished",
      sessionKey: task.childSessionKey,
      runId: typeof task.detail.runId === "string" ? task.detail.runId : undefined,
    },
    { jobId: task.sourceId },
  );
  if (!entry) {
    return null;
  }
  // The parsed entry is private; materialize the legacy reader’s absent indexed fields on it.
  return Object.assign(entry, {
    delivered: entry.delivered,
    deliveryStatus: entry.deliveryStatus,
    deliveryError: entry.deliveryError,
    sessionId: entry.sessionId,
    sessionKey: entry.sessionKey,
  });
}
