import type { DeliveryQueueTerminalPolicy } from "../delivery-queue-sqlite.types.js";

/** Failed media stays owned until either replay or owner cleanup no longer needs it. */
export const outboundFailureRetainsMedia = (policy: DeliveryQueueTerminalPolicy): boolean =>
  (policy.replay === "safe" && policy.fence.kind === "none") ||
  (policy.replay === "owner-managed" && policy.cleanup !== "complete");
