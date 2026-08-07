import {
  claimDeliveryQueueEntryPlatformSend,
  renewDeliveryQueueEntryPlatformSendLease,
} from "../delivery-queue-sqlite-claim.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";

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
