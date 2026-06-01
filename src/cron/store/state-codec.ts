import type { CronJobState } from "../types.js";
import {
  booleanToInteger,
  integerToBoolean,
  normalizeNumber,
  parseJsonObject,
} from "./scalar-codec.js";
import type { CronJobInsert, CronJobRow } from "./schema.js";

/** Maps mutable cron runtime state into normalized SQLite columns. */
export function bindStateColumns(
  state: CronJobState,
): Pick<
  CronJobInsert,
  | "consecutive_errors"
  | "consecutive_skipped"
  | "last_delivered"
  | "last_delivery_error"
  | "last_delivery_status"
  | "last_duration_ms"
  | "last_error"
  | "last_failure_alert_at_ms"
  | "last_run_at_ms"
  | "last_run_status"
  | "next_run_at_ms"
  | "running_at_ms"
  | "schedule_error_count"
> {
  return {
    next_run_at_ms: state.nextRunAtMs ?? null,
    running_at_ms: state.runningAtMs ?? null,
    last_run_at_ms: state.lastRunAtMs ?? null,
    last_run_status: state.lastRunStatus ?? state.lastStatus ?? null,
    last_error: state.lastError ?? null,
    last_duration_ms: state.lastDurationMs ?? null,
    consecutive_errors: state.consecutiveErrors ?? null,
    consecutive_skipped: state.consecutiveSkipped ?? null,
    schedule_error_count: state.scheduleErrorCount ?? null,
    last_delivery_status: state.lastDeliveryStatus ?? null,
    last_delivery_error: state.lastDeliveryError ?? null,
    last_delivered: booleanToInteger(state.lastDelivered),
    last_failure_alert_at_ms: state.lastFailureAlertAtMs ?? null,
  };
}

/** Reconstructs cron runtime state from JSON plus split indexed columns. */
export function stateFromRow(row: CronJobRow): CronJobState {
  return {
    // Keep unknown runtime fields from state_json while letting indexed columns
    // win for fields that SQLite updates independently during hot-path writes.
    ...parseJsonObject<CronJobState>(row.state_json, {}),
    ...(row.next_run_at_ms != null ? { nextRunAtMs: normalizeNumber(row.next_run_at_ms) } : {}),
    ...(row.running_at_ms != null ? { runningAtMs: normalizeNumber(row.running_at_ms) } : {}),
    ...(row.last_run_at_ms != null ? { lastRunAtMs: normalizeNumber(row.last_run_at_ms) } : {}),
    ...(row.last_run_status
      ? { lastRunStatus: row.last_run_status as CronJobState["lastRunStatus"] }
      : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.last_duration_ms != null
      ? { lastDurationMs: normalizeNumber(row.last_duration_ms) }
      : {}),
    ...(row.consecutive_errors != null
      ? { consecutiveErrors: normalizeNumber(row.consecutive_errors) }
      : {}),
    ...(row.consecutive_skipped != null
      ? { consecutiveSkipped: normalizeNumber(row.consecutive_skipped) }
      : {}),
    ...(row.schedule_error_count != null
      ? { scheduleErrorCount: normalizeNumber(row.schedule_error_count) }
      : {}),
    ...(row.last_delivery_status
      ? { lastDeliveryStatus: row.last_delivery_status as CronJobState["lastDeliveryStatus"] }
      : {}),
    ...(row.last_delivery_error ? { lastDeliveryError: row.last_delivery_error } : {}),
    ...(row.last_delivered != null ? { lastDelivered: integerToBoolean(row.last_delivered) } : {}),
    ...(row.last_failure_alert_at_ms != null
      ? { lastFailureAlertAtMs: normalizeNumber(row.last_failure_alert_at_ms) }
      : {}),
  };
}
