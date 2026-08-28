import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { pruneDeliveryQueueTombstones } from "../infra/delivery-queue-sqlite-bound.js";
import {
  inferDeliveryQueueFailureRetention,
  projectDeliveryQueueTerminalEntry,
} from "../infra/delivery-queue-sqlite.types.js";

function nonNegativeSafeInteger(value: unknown): number | undefined {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0
    ? number
    : undefined;
}
const inferLegacyRetention = (
  entry: ReturnType<typeof safeParseJsonRecord>,
  id: string,
  queue: string,
) => inferDeliveryQueueFailureRetention(entry ?? {}, id, queue, true);

/** Compact every preexisting failed row without inferring replay or owner policy. */
export function compactLegacyDeliveryQueueFailures(db: DatabaseSync): void {
  const migrationNow = Date.now();
  const retainPending = db.prepare(
    `UPDATE delivery_queue_entries SET entry_json = ?
      WHERE queue_name = ? AND id = ? AND status = 'pending' AND entry_json = ?`,
  );
  const select = db.prepare(
    `SELECT queue_name, id, status, retry_count, entry_json, updated_at, failed_at, recovery_state
       FROM delivery_queue_entries WHERE status IN ('pending', 'failed')`,
  );
  select.setReadBigInts(true);
  const rows = select.all() as Array<Record<string, unknown>>;
  const remove = db.prepare(
    `DELETE FROM delivery_queue_entries WHERE queue_name = ? AND id = ? AND status = 'failed'`,
  );
  const compact = db.prepare(
    `UPDATE delivery_queue_entries
        SET entry_kind = NULL, session_key = NULL, channel = NULL, target = NULL,
            account_id = NULL, retry_count = @retryCount, last_attempt_at = NULL,
            last_error = NULL, platform_send_started_at = NULL, entry_json = @entryJson,
            enqueued_at = @failedAt, failed_at = @failedAt, recovery_state = @recoveryState
      WHERE queue_name = @queueName AND id = @id AND status = 'failed'`,
  );
  for (const row of rows) {
    // Failed send custody can still own a restartable completion projection.
    if (row.recovery_state === "settlement_pending") {
      continue;
    }
    const parsedEntry = safeParseJsonRecord(String(row.entry_json));
    const queueName = String(row.queue_name);
    const id = String(row.id);
    if (row.status === "pending") {
      if (
        parsedEntry?.retainOnFailure !== true &&
        inferLegacyRetention(parsedEntry, id, queueName)
      ) {
        retainPending.run(
          JSON.stringify({ ...parsedEntry, retainOnFailure: true }),
          queueName,
          id,
          String(row.entry_json),
        );
      }
      continue;
    }
    const failedAt =
      nonNegativeSafeInteger(row.failed_at) ??
      nonNegativeSafeInteger(row.updated_at) ??
      migrationNow;
    const entry = parsedEntry ?? {};
    const retryCount = Math.max(
      nonNegativeSafeInteger(row.retry_count) ?? 0,
      nonNegativeSafeInteger(entry.retryCount) ?? 0,
    );
    const retention = parsedEntry ? inferLegacyRetention(entry, id, queueName) : "permanent";
    if (!retention) {
      remove.run(queueName, id);
      continue;
    }
    const failedEntry = projectDeliveryQueueTerminalEntry(
      { id, retryCount },
      failedAt,
      "failed",
      retention,
    );
    compact.run({
      retryCount,
      entryJson: JSON.stringify(failedEntry),
      failedAt,
      recoveryState: failedEntry.recoveryState ?? null,
      queueName,
      id,
    });
  }
  pruneDeliveryQueueTombstones(db, migrationNow);
}
