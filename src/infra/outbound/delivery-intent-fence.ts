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
  fence?: StableDeliveryIntentFence;
  enterModifierBoundary: () => void;
  markPublished: () => void;
};

class StableDeliveryIntentFenceExistsError extends Error {}

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

/** Owns the irreversible stable-id fence only from the first modifier onward. */
export async function withStableDeliveryIntentFence<T>(params: {
  id: string;
  completionRetention?: DeliveryQueueCompletionRetention;
  stateDir?: string;
  run: (owner: StableDeliveryIntentFenceOwner) => Promise<T>;
}): Promise<{ status: "claimed"; value: T } | { status: "existing" }> {
  let published = false;
  const owner: StableDeliveryIntentFenceOwner = {
    enterModifierBoundary: () => {
      if (owner.fence) {
        return;
      }
      const fence = claimStableDeliveryIntentFence(params);
      if (!fence) {
        throw new StableDeliveryIntentFenceExistsError();
      }
      // Persist immediately before invoking the first stateful modifier. A
      // crash before this callback leaves no owner; afterward retry must not
      // repeat a modifier whose side effect may already have started.
      owner.fence = fence;
    },
    markPublished: () => {
      published = true;
    },
  };
  try {
    const value = await params.run(owner);
    if (owner.fence && !published) {
      completeDeliveryQueueEntry(
        OUTBOUND_DELIVERY_INTENT_FENCE_QUEUE_NAME,
        owner.fence.id,
        params.stateDir,
      );
    }
    return { status: "claimed", value };
  } catch (error) {
    if (error instanceof StableDeliveryIntentFenceExistsError) {
      return { status: "existing" };
    }
    if (owner.fence && !published) {
      failPendingDeliveryQueueEntry({
        queueName: OUTBOUND_DELIVERY_INTENT_FENCE_QUEUE_NAME,
        id: owner.fence.id,
        expectedStatus: "pending",
        lastError: "stable outbound intent failed before prepared custody",
        entry: owner.fence,
        failedEntry: owner.fence,
        stateDir: params.stateDir,
      });
    }
    throw error;
  }
}
