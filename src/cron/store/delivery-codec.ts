import type { CronDelivery } from "../types.js";
import { booleanToInteger, integerToBoolean } from "./scalar-codec.js";
import type { CronJobInsert, CronJobRow } from "./schema.js";

/** Maps cron delivery config into normalized SQLite columns. */
export function bindDeliveryColumns(
  delivery: CronDelivery | undefined,
): Pick<
  CronJobInsert,
  | "delivery_account_id"
  | "delivery_best_effort"
  | "delivery_channel"
  | "delivery_completion_mode"
  | "delivery_completion_to"
  | "delivery_mode"
  | "delivery_thread_id"
  | "delivery_to"
  | "failure_delivery_account_id"
  | "failure_delivery_channel"
  | "failure_delivery_mode"
  | "failure_delivery_to"
> {
  const failureDestination = delivery?.failureDestination;
  return {
    delivery_mode: delivery?.mode ?? null,
    delivery_channel: delivery?.channel ?? null,
    delivery_to: delivery?.to ?? null,
    delivery_thread_id:
      delivery?.threadId === undefined || delivery.threadId === null
        ? null
        : String(delivery.threadId),
    delivery_account_id: delivery?.accountId ?? null,
    delivery_best_effort: booleanToInteger(delivery?.bestEffort),
    delivery_completion_mode: delivery?.completionDestination?.mode ?? null,
    delivery_completion_to: delivery?.completionDestination?.to ?? null,
    // Empty string is an internal SQLite sentinel for an explicit undefined field.
    // `resolveFailureDestination` uses own-property presence to clear inherited
    // global failure-destination fields, so persistence must preserve presence.
    failure_delivery_mode: bindFailureDestinationField(failureDestination, "mode"),
    failure_delivery_channel: bindFailureDestinationField(failureDestination, "channel"),
    failure_delivery_to: bindFailureDestinationField(failureDestination, "to"),
    failure_delivery_account_id: bindFailureDestinationField(failureDestination, "accountId"),
  };
}

function bindFailureDestinationField(
  failureDestination: CronDelivery["failureDestination"],
  key: "accountId" | "channel" | "mode" | "to",
): string | null {
  if (!failureDestination || !Object.hasOwn(failureDestination, key)) {
    return null;
  }
  return failureDestination[key] ?? "";
}

function readFailureDestinationField(value: string | null): string | undefined {
  return value === "" || value == null ? undefined : value;
}

function cronDeliveryModeFromValue(value: unknown): CronDelivery["mode"] | undefined {
  return value === "none" || value === "announce" || value === "webhook" ? value : undefined;
}

/** Reconstructs delivery config from split SQLite columns, preserving legacy partial rows. */
export function deliveryFromRow(row: CronJobRow): CronDelivery | undefined {
  const rowMode = cronDeliveryModeFromValue(row.delivery_mode);
  const hasDeliveryColumns =
    Boolean(
      row.delivery_channel ||
      row.delivery_to ||
      row.delivery_thread_id ||
      row.delivery_account_id ||
      row.delivery_completion_mode ||
      row.delivery_completion_to ||
      row.failure_delivery_channel != null ||
      row.failure_delivery_to != null ||
      row.failure_delivery_mode != null ||
      row.failure_delivery_account_id != null,
    ) || row.delivery_best_effort != null;
  const completionDestination =
    rowMode === "announce" && row.delivery_completion_mode === "webhook"
      ? {
          mode: "webhook" as const,
          ...(row.delivery_completion_to ? { to: row.delivery_completion_to } : {}),
        }
      : undefined;
  const failureDestination =
    row.failure_delivery_channel != null ||
    row.failure_delivery_to != null ||
    row.failure_delivery_mode != null ||
    row.failure_delivery_account_id != null
      ? {
          ...(row.failure_delivery_channel != null
            ? {
                channel: readFailureDestinationField(
                  row.failure_delivery_channel,
                ) as CronDelivery["channel"],
              }
            : {}),
          ...(row.failure_delivery_to != null
            ? { to: readFailureDestinationField(row.failure_delivery_to) }
            : {}),
          ...(row.failure_delivery_mode != null
            ? {
                mode: readFailureDestinationField(row.failure_delivery_mode) as
                  | "announce"
                  | "webhook",
              }
            : {}),
          ...(row.failure_delivery_account_id != null
            ? { accountId: readFailureDestinationField(row.failure_delivery_account_id) }
            : {}),
        }
      : undefined;
  if (!rowMode && !hasDeliveryColumns) {
    return undefined;
  }
  // Old rows may have destination columns without a mode; announce matches the
  // historical default for configured channel delivery.
  return {
    mode: rowMode ?? "announce",
    ...(row.delivery_channel ? { channel: row.delivery_channel as CronDelivery["channel"] } : {}),
    ...(row.delivery_to ? { to: row.delivery_to } : {}),
    ...(row.delivery_thread_id ? { threadId: row.delivery_thread_id } : {}),
    ...(row.delivery_account_id ? { accountId: row.delivery_account_id } : {}),
    ...(row.delivery_best_effort != null
      ? { bestEffort: integerToBoolean(row.delivery_best_effort) }
      : {}),
    ...(completionDestination ? { completionDestination } : {}),
    ...(failureDestination ? { failureDestination } : {}),
  };
}
