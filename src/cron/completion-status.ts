import type { NormalizeReplySkipReason } from "../auto-reply/reply/normalize-reply-skip-reason.js";

type CronCompletionRunStatus = "ok" | "error" | "skipped";

type CronCompletionDeliveryStatus = "delivered" | "not-delivered" | "unknown" | "not-requested";

type CronCompletionJob = {
  delivery?: {
    mode?: "none" | "announce" | "webhook";
    bestEffort?: boolean;
  };
};

/** Whole-run completion after execution and its admitted delivery policy settle. */
export type CronCompletionStatus = "succeeded" | "failed" | "unknown";

/** Resolves authored completion from an admitted job, or legacy completion from stored facts. */
export function resolveCronCompletionStatus(params: {
  status?: CronCompletionRunStatus;
  delivered?: boolean;
  deliveryStatus?: CronCompletionDeliveryStatus;
  deliverySuppressionReason?: NormalizeReplySkipReason;
  requiredDelivery?: boolean;
}): CronCompletionStatus {
  if (params.status === "error" || params.status === "skipped") {
    return "failed";
  }
  if (params.status !== "ok") {
    return "unknown";
  }
  if (params.requiredDelivery === undefined) {
    return params.delivered === true ||
      params.deliveryStatus === "delivered" ||
      params.deliveryStatus === "not-requested"
      ? "succeeded"
      : "unknown";
  }
  // Intentional silence completes execution without claiming recipient delivery.
  if (
    !params.requiredDelivery ||
    params.deliveryStatus === "delivered" ||
    (params.deliveryStatus === "not-delivered" && params.deliverySuppressionReason !== undefined)
  ) {
    return "succeeded";
  }
  return params.deliveryStatus === "not-delivered" ? "failed" : "unknown";
}

/** Resolves completion from the immutable delivery contract admitted for this run. */
export function resolveAdmittedCronCompletionStatus(
  job: CronCompletionJob,
  status: CronCompletionRunStatus,
  deliveryStatus: CronCompletionDeliveryStatus,
  deliverySuppressionReason?: NormalizeReplySkipReason,
): CronCompletionStatus {
  return resolveCronCompletionStatus({
    status,
    deliveryStatus,
    deliverySuppressionReason,
    requiredDelivery: job.delivery?.bestEffort !== true && deliveryStatus !== "not-requested",
  });
}
