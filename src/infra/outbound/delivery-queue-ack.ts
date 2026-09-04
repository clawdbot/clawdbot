// Acknowledges exact outbound custody before releasing its queue-owned media.
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite-bound.js";
import { transitionOwnedDeliveryQueueEntry } from "../delivery-queue-sqlite-claim.js";
import {
  completeDeliveryQueueEntryInDatabase,
  deleteDeliveryQueueEntryInDatabase,
} from "../delivery-queue-sqlite.js";
import { collectEntrySpoolPaths, releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

type AckDeliveryOptions = {
  /** Caller holds a GC-visible recovery lease until its active adapter settles. */
  retainSpoolArtifacts?: boolean;
  /** An intentionally suppressed pre-send batch must not become a success receipt. */
  suppressCompletionReceipt?: boolean;
  /** Prevent an older provider attempt from settling a replacement owner. */
  expectedPlatformSendAttemptId?: string | null;
};

/** Remove a successfully delivered entry, or retain its producer-owned receipt. */
export async function ackDelivery(
  id: string,
  stateDir?: string,
  options?: AckDeliveryOptions,
): Promise<void> {
  // Read the media references before the row goes, then unlink only after the
  // delete commits. A crash in between leaves an orphan for the retention sweep;
  // unlinking first could strip media from a row that still has to replay.
  const database = openOpenClawStateDatabase({
    env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env,
  });
  let spoolPaths: string[] = [];
  const settle = (current: QueuedDelivery | null): void => {
    spoolPaths = current
      ? collectEntrySpoolPaths(
          acceptedPreparedOutboundEntries(current.preparedBatch).map(
            (prepared) => prepared.payload,
          ),
          stateDir,
        )
      : [];
    if (current?.completionRetention && options?.suppressCompletionReceipt !== true) {
      completeDeliveryQueueEntryInDatabase(database, OUTBOUND_DELIVERY_QUEUE_NAME, id);
    } else {
      deleteDeliveryQueueEntryInDatabase(database, OUTBOUND_DELIVERY_QUEUE_NAME, id);
    }
  };
  if (options && "expectedPlatformSendAttemptId" in options) {
    const settled = transitionOwnedDeliveryQueueEntry(
      {
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        id,
        stateDir,
        database,
        platformSendAttemptId: options.expectedPlatformSendAttemptId ?? null,
      },
      (entry) => {
        // SAFETY: Pending rows in this namespace retain the prepared outbound payload.
        settle(entry as QueuedDelivery);
      },
    );
    if (!settled) {
      throw new Error(`Delivery platform claim was lost: ${id}`);
    }
  } else {
    const current = loadDeliveryQueueEntryInDatabase(
      database,
      OUTBOUND_DELIVERY_QUEUE_NAME,
      id,
      "pending",
    );
    // SAFETY: Pending rows in this namespace retain the prepared outbound payload.
    settle(current as QueuedDelivery | null);
  }
  if (!options?.retainSpoolArtifacts) {
    await releaseSpoolArtifacts(spoolPaths, stateDir);
  }
}
