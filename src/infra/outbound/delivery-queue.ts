// Public outbound delivery queue facade for storage and recovery operations.
export {
  ackDelivery,
  enqueueDelivery,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendDispatched,
  markDeliveryPlatformSendAttemptStarted,
} from "./delivery-queue-storage.js";
export type {
  QueuedReplyPayloadSendingHook,
  QueuedRenderedMessageBatchPlan,
} from "./delivery-queue-storage.js";
export {
  drainPendingDeliveries,
  recoverPendingDeliveries,
  withActiveDeliveryClaim,
} from "./delivery-queue-recovery.js";
export type { DeliverFn, RecoveryLogger } from "./delivery-queue-recovery.js";
