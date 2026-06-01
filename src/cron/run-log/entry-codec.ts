import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { FailoverReason } from "../../agents/embedded-agent-helpers/types.js";
import { resolveFailoverReasonFromError } from "../../agents/failover-error.js";
import { normalizeCronRunDiagnostics } from "../run-diagnostics.js";
import type { CronRunLogEntry } from "../run-log-types.js";
import type { CronDeliveryStatus } from "../types.js";

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
  "empty_response",
  "no_error_details",
  "unclassified",
  "unknown",
]);

function normalizeCronRunLogErrorReason(value: unknown): FailoverReason | undefined {
  return typeof value === "string" && CRON_FAILOVER_REASONS.has(value as FailoverReason)
    ? (value as FailoverReason)
    : undefined;
}

/** Parses a persisted cron run-log entry object and drops invalid or wrong-job rows. */
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
  const normalizedErrorReason =
    normalizeCronRunLogErrorReason(entryObj.errorReason) ??
    resolveFailoverReasonFromError(normalizedError, normalizedProvider) ??
    undefined;
  const entry: CronRunLogEntry = {
    ts: entryObj.ts,
    jobId: entryObj.jobId,
    action: "finished",
    status: entryObj.status,
    error: normalizedError,
    errorReason: normalizedErrorReason,
    summary: entryObj.summary,
    runId: typeof entryObj.runId === "string" && entryObj.runId.trim() ? entryObj.runId : undefined,
    diagnostics: normalizeCronRunDiagnostics(entryObj.diagnostics),
    runAtMs: entryObj.runAtMs,
    durationMs: entryObj.durationMs,
    nextRunAtMs: entryObj.nextRunAtMs,
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
  if (typeof entryObj.sessionId === "string" && entryObj.sessionId.trim().length > 0) {
    entry.sessionId = entryObj.sessionId;
  }
  if (typeof entryObj.sessionKey === "string" && entryObj.sessionKey.trim().length > 0) {
    entry.sessionKey = entryObj.sessionKey;
  }
  return entry;
}
