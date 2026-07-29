/** SQLite column codec for cron failure-alert configuration. */
import type { CronFailureAlert } from "../types.js";
import { booleanToInteger, integerToBoolean, normalizeNumber } from "./scalar-codec.js";
import type { CronJobInsert, CronJobRow } from "./schema.js";

/** Maps cron failure-alert config into normalized SQLite columns. */
export function bindFailureAlertColumns(
  failureAlert: CronFailureAlert | false | undefined,
): Pick<
  CronJobInsert,
  | "failure_alert_account_id"
  | "failure_alert_after"
  | "failure_alert_channel"
  | "failure_alert_cooldown_ms"
  | "failure_alert_disabled"
  | "failure_alert_include_skipped"
  | "failure_alert_mode"
  | "failure_alert_to"
> {
  if (failureAlert === false) {
    return {
      failure_alert_disabled: 1,
      failure_alert_after: null,
      failure_alert_channel: null,
      failure_alert_to: null,
      failure_alert_cooldown_ms: null,
      failure_alert_include_skipped: null,
      failure_alert_mode: null,
      failure_alert_account_id: null,
    };
  }
  return {
    failure_alert_disabled: failureAlert ? 0 : null,
    failure_alert_after: failureAlert?.after ?? null,
    failure_alert_channel: failureAlert?.channel ?? null,
    failure_alert_to: failureAlert?.to ?? null,
    failure_alert_cooldown_ms: failureAlert?.cooldownMs ?? null,
    failure_alert_include_skipped: booleanToInteger(failureAlert?.includeSkipped),
    failure_alert_mode: failureAlert?.mode ?? null,
    failure_alert_account_id: failureAlert?.accountId ?? null,
  };
}

/** Reconstructs failure-alert config, distinguishing disabled from omitted config. */
export function failureAlertFromRow(row: CronJobRow): CronFailureAlert | false | undefined {
  if (row.failure_alert_disabled === 1) {
    return false;
  }
  const failureAlertExplicitlyEnabled = row.failure_alert_disabled === 0;
  if (
    row.failure_alert_after == null &&
    !row.failure_alert_channel &&
    !row.failure_alert_to &&
    row.failure_alert_cooldown_ms == null &&
    row.failure_alert_include_skipped == null &&
    !row.failure_alert_mode &&
    !row.failure_alert_account_id &&
    !failureAlertExplicitlyEnabled
  ) {
    return undefined;
  }
  return {
    ...(row.failure_alert_after != null ? { after: normalizeNumber(row.failure_alert_after) } : {}),
    ...(row.failure_alert_channel
      ? { channel: row.failure_alert_channel as CronFailureAlert["channel"] }
      : {}),
    ...(row.failure_alert_to ? { to: row.failure_alert_to } : {}),
    ...(row.failure_alert_cooldown_ms != null
      ? { cooldownMs: normalizeNumber(row.failure_alert_cooldown_ms) }
      : {}),
    ...(row.failure_alert_include_skipped != null
      ? { includeSkipped: integerToBoolean(row.failure_alert_include_skipped) }
      : {}),
    ...(row.failure_alert_mode ? { mode: row.failure_alert_mode as "announce" | "webhook" } : {}),
    ...(row.failure_alert_account_id ? { accountId: row.failure_alert_account_id } : {}),
  };
}
