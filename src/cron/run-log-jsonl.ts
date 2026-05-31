import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import type { FailoverReason } from "../agents/embedded-agent-helpers/types.js";
import { resolveFailoverReasonFromError } from "../agents/failover-error.js";
import { normalizeCronRunDiagnostics } from "./run-diagnostics.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import type { CronDeliveryStatus } from "./types.js";

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

export function parseCronRunLogEntriesFromJsonl(
  raw: string,
  opts?: { jobId?: string },
): CronRunLogEntry[] {
  const jobId = normalizeOptionalString(opts?.jobId);
  if (!raw.trim()) {
    return [];
  }
  const parsed: CronRunLogEntry[] = [];
  const lines = raw.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const obj = JSON.parse(line) as Partial<CronRunLogEntry> | null;
      if (!obj || typeof obj !== "object") {
        continue;
      }
      if (obj.action !== "finished") {
        continue;
      }
      if (typeof obj.jobId !== "string" || obj.jobId.trim().length === 0) {
        continue;
      }
      if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) {
        continue;
      }
      if (jobId && obj.jobId !== jobId) {
        continue;
      }
      const usage =
        obj.usage && typeof obj.usage === "object"
          ? (obj.usage as Record<string, unknown>)
          : undefined;
      const normalizedError = typeof obj.error === "string" ? obj.error : undefined;
      const normalizedProvider =
        typeof obj.provider === "string" && obj.provider.trim() ? obj.provider : undefined;
      const normalizedErrorReason =
        normalizeCronRunLogErrorReason(obj.errorReason) ??
        resolveFailoverReasonFromError(normalizedError, normalizedProvider) ??
        undefined;
      const entry: CronRunLogEntry = {
        ts: obj.ts,
        jobId: obj.jobId,
        action: "finished",
        status: obj.status,
        error: normalizedError,
        errorReason: normalizedErrorReason,
        summary: obj.summary,
        runId: typeof obj.runId === "string" && obj.runId.trim() ? obj.runId : undefined,
        diagnostics: normalizeCronRunDiagnostics(obj.diagnostics),
        runAtMs: obj.runAtMs,
        durationMs: obj.durationMs,
        nextRunAtMs: obj.nextRunAtMs,
        model: typeof obj.model === "string" && obj.model.trim() ? obj.model : undefined,
        provider: normalizedProvider,
        usage: usage
          ? {
              input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
              output_tokens:
                typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
              total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
              cache_read_tokens:
                typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : undefined,
              cache_write_tokens:
                typeof usage.cache_write_tokens === "number" ? usage.cache_write_tokens : undefined,
            }
          : undefined,
      };
      if (typeof obj.delivered === "boolean") {
        entry.delivered = obj.delivered;
      }
      if (
        obj.deliveryStatus === "delivered" ||
        obj.deliveryStatus === "not-delivered" ||
        obj.deliveryStatus === "unknown" ||
        obj.deliveryStatus === "not-requested"
      ) {
        entry.deliveryStatus = obj.deliveryStatus as CronDeliveryStatus;
      }
      if (typeof obj.deliveryError === "string") {
        entry.deliveryError = obj.deliveryError;
      }
      if (obj.failureNotificationDelivery && typeof obj.failureNotificationDelivery === "object") {
        const failureNotificationDelivery = obj.failureNotificationDelivery as {
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
      if (obj.delivery && typeof obj.delivery === "object") {
        entry.delivery = obj.delivery;
      }
      if (typeof obj.sessionId === "string" && obj.sessionId.trim().length > 0) {
        entry.sessionId = obj.sessionId;
      }
      if (typeof obj.sessionKey === "string" && obj.sessionKey.trim().length > 0) {
        entry.sessionKey = obj.sessionKey;
      }
      parsed.push(entry);
    } catch {
      // Ignore invalid legacy JSONL lines.
    }
  }
  return parsed;
}
