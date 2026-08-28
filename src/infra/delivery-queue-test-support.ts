// Test helper for driving delivery queue rows into their failed terminal state.
import {
  loadDeliveryQueueEntry,
  terminalizePendingDeliveryQueueEntry,
} from "./delivery-queue-sqlite.js";

function enoent(queueName: string, id: string): Error & { code: string } {
  const error = new Error(`No pending ${queueName} delivery queue entry ${id}`) as Error & {
    code: string;
  };
  error.code = "ENOENT";
  return error;
}

/** Terminalize one pending row using its failure-retention ownership fact. */
export function moveDeliveryQueueEntryToFailedForTest(
  queueName: string,
  id: string,
  stateDir?: string,
): void {
  const entry = loadDeliveryQueueEntry(queueName, id, stateDir);
  if (!entry) {
    throw enoent(queueName, id);
  }
  const result = terminalizePendingDeliveryQueueEntry({ queueName, id, entry, stateDir });
  if (result.status !== "terminalized") {
    throw enoent(queueName, id);
  }
}
