// Payload-free ownership fence for stable outbound ids.
import { upsertDeliveryQueueEntryOnceAcrossNamespaces } from "../delivery-queue-sqlite-namespace.js";
import {
  completeDeliveryQueueEntry,
  failPendingDeliveryQueueEntry,
  type DeliveryQueueCompletionRetention,
  type DeliveryQueueEntryState,
} from "../delivery-queue-sqlite.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_INTENT_FENCE_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";

export type StableDeliveryIntentFence = DeliveryQueueEntryState;

export type StableDeliveryIntentFenceOwner = {
  fence: StableDeliveryIntentFence;
  markPublished: () => void;
};

export class StableDeliveryIntentFenceLostError extends Error {
  constructor(id: string) {
    super(`Stable outbound intent fence was lost: ${id}`);
    this.name = "StableDeliveryIntentFenceLostError";
  }
}

function claimStableDeliveryIntentFence(params: {
  id: string;
  completionRetention?: DeliveryQueueCompletionRetention;
  stateDir?: string;
}): StableDeliveryIntentFence | null {
  const fence: StableDeliveryIntentFence = {
    id: params.id,
    enqueuedAt: Date.now(),
    retryCount: 0,
    attemptCount: 0,
    ...(params.completionRetention ? { completionRetention: params.completionRetention } : {}),
  };
  return upsertDeliveryQueueEntryOnceAcrossNamespaces({
    queueName: OUTBOUND_DELIVERY_INTENT_FENCE_QUEUE_NAME,
    conflictQueueNames: [OUTBOUND_DELIVERY_QUEUE_NAME, LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME],
    entry: fence,
    stateDir: params.stateDir,
  })
    ? fence
    : null;
}

/**
 * Admits one stable producer before modifying policy starts. A crash can leave
 * this payload-free fence behind, intentionally suppressing regeneration
 * rather than rerunning stateful modifiers without their prepared output.
 */
export async function withStableDeliveryIntentFence<T>(params: {
  id: string;
  completionRetention?: DeliveryQueueCompletionRetention;
  stateDir?: string;
  run: (owner: StableDeliveryIntentFenceOwner) => Promise<T>;
}): Promise<{ status: "claimed"; value: T } | { status: "existing" }> {
  const fence = claimStableDeliveryIntentFence(params);
  if (!fence) {
    return { status: "existing" };
  }

  let published = false;
  try {
    const value = await params.run({
      fence,
      markPublished: () => {
        published = true;
      },
    });
    if (!published) {
      completeDeliveryQueueEntry(
        OUTBOUND_DELIVERY_INTENT_FENCE_QUEUE_NAME,
        fence.id,
        params.stateDir,
      );
    }
    return { status: "claimed", value };
  } catch (error) {
    if (!published) {
      failPendingDeliveryQueueEntry({
        queueName: OUTBOUND_DELIVERY_INTENT_FENCE_QUEUE_NAME,
        id: fence.id,
        expectedStatus: "pending",
        lastError: "stable outbound intent failed before prepared custody",
        entry: fence,
        failedEntry: fence,
        stateDir: params.stateDir,
      });
    }
    throw error;
  }
}
