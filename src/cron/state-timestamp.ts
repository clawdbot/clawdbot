/** Shared validation for persisted and caller-authored cron runtime timestamps. */
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { CronJobState } from "./types.js";

const CRON_STATE_TIMESTAMP_FIELDS = [
  "nextRunAtMs",
  "scheduleActivatedAtMs",
  "startupCatchupAtMs",
  "pacedNextRunAtMs",
  "forcePreservedNextRunAtMs",
  "queuedAtMs",
  "runningAtMs",
  "lastRunAtMs",
  "lastFailureAlertAtMs",
  "lastTriggerEvalAtMs",
  "lastTriggerFireAtMs",
  "streamLastStartedAtMs",
  "streamLastExitAtMs",
] as const satisfies readonly (keyof CronJobState)[];

function isValidCronStateTimestamp(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    typeof value === "number" &&
    value >= 0 &&
    asDateTimestampMs(value) !== undefined
  );
}

/** Returns the first runtime timestamp field that cannot round-trip through Date and SQLite. */
export function getInvalidCronJobStateTimestampField(state: unknown): string | undefined {
  const record = asRecord(state);
  for (const field of CRON_STATE_TIMESTAMP_FIELDS) {
    const value = record[field];
    if (value !== undefined && !isValidCronStateTimestamp(value)) {
      return field;
    }
  }
  const autoDisabled = asRecord(record.autoDisabled);
  if (autoDisabled.atMs !== undefined && !isValidCronStateTimestamp(autoDisabled.atMs)) {
    return "autoDisabled.atMs";
  }
  return undefined;
}

/** Rejects caller-authored state timestamps that cannot round-trip through Date and SQLite. */
export function assertCronJobStateTimestamps(state: Partial<CronJobState>): void {
  const invalidField = getInvalidCronJobStateTimestampField(state);
  if (invalidField) {
    throw new Error(
      `cron state.${invalidField} must be a non-negative Date-valid integer timestamp`,
    );
  }
}
