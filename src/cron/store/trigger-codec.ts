/** SQLite column codec for cron trigger configuration. */
import type { CronTrigger } from "../types.js";
import { booleanToInteger, integerToBoolean } from "./scalar-codec.js";
import type { CronJobInsert, CronJobRow } from "./schema.js";

/** Maps cron trigger config into normalized SQLite columns. */
export function bindTriggerColumns(
  trigger: CronTrigger | undefined,
): Pick<CronJobInsert, "trigger_script" | "trigger_once"> {
  return {
    trigger_script: trigger?.script ?? null,
    trigger_once: booleanToInteger(trigger?.once),
  };
}

/** Reconstructs trigger config from normalized SQLite columns. */
export function triggerFromRow(row: CronJobRow): CronTrigger | undefined {
  if (!row.trigger_script) {
    return undefined;
  }
  return {
    script: row.trigger_script,
    ...(row.trigger_once != null ? { once: integerToBoolean(row.trigger_once) } : {}),
  };
}
