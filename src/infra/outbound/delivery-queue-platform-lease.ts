import {
  claimDeliveryQueueEntryPlatformSend,
  dispatchDeliveryQueueEntryPlatformSend,
  renewDeliveryQueueEntryPlatformSendLease,
} from "../delivery-queue-sqlite-claim.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";

/** Atomically transfer a stable pending producer intent to one platform sender. */
export async function claimDeliveryPlatformSendAttempt(
  id: string,
  stateDir?: string,
  reconciledPlatformSendStartedAt?: number,
  reconciledPlatformSendAttemptId?: string,
): Promise<string | undefined> {
  return claimDeliveryQueueEntryPlatformSend({
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
    ...(reconciledPlatformSendStartedAt !== undefined ? { reconciledPlatformSendStartedAt } : {}),
    ...(reconciledPlatformSendAttemptId !== undefined ? { reconciledPlatformSendAttemptId } : {}),
  });
}

/** Claim and atomically upgrade a live reusable producer to renewable ownership. */
export async function claimReusableDeliveryPlatformSendAttempt(
  id: string,
  stateDir?: string,
): Promise<string | undefined> {
  return claimDeliveryQueueEntryPlatformSend({
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
    requiresProducerClaim: true,
  });
}

/** Extend the exact active producer lease without changing ownership. */
export async function renewDeliveryPlatformSendLease(
  id: string,
  stateDir: string | undefined,
  claimId: string,
): Promise<number | undefined> {
  return renewDeliveryQueueEntryPlatformSendLease({
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
    claimId,
  });
}

/** Promote or refresh the exact live owner at recipient-visible dispatch. */
export function markOwnedDeliveryPlatformSendDispatched(
  id: string,
  stateDir: string | undefined,
  route: { replyToId?: string | null } | undefined,
  claimId: string,
): void {
  const dispatched = dispatchDeliveryQueueEntryPlatformSend({
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
    route,
    claimId,
  });
  if (!dispatched) {
    throw new Error(`Delivery platform claim was lost: ${id}`);
  }
}
