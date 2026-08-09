// Public outbound delivery queue facade for storage and recovery operations.
export {
  ackDelivery,
  enqueueDelivery,
  enqueueDeliveryOnce,
  enqueuePreparedDeliveryOnce,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  markDeliveryPlatformSendDispatched,
} from "./delivery-queue-storage.js";
export {
  claimReusableDeliveryPlatformSendAttempt,
  renewDeliveryPlatformSendLease,
} from "./delivery-queue-platform-lease.js";
export type { QueuedReplyPayloadSendingHook } from "./delivery-queue-storage.js";
export {
  drainPendingDeliveries,
  recoverPendingDeliveries,
  withActiveDeliveryClaim,
} from "./delivery-queue-recovery.js";
export type { DeliverFn, RecoveryLogger } from "./delivery-queue-recovery.js";
