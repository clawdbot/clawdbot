import { isCronDeliveryRequired } from "./delivery-plan.js";
import type { CronCompletionStatus, CronDeliveryStatus, CronJob, CronRunStatus } from "./types.js";

/** Resolves authored completion from an admitted job, or legacy completion from stored facts. */
export function resolveCronCompletionStatus(params: {
  status?: CronRunStatus;
  delivered?: boolean;
  deliveryStatus?: CronDeliveryStatus;
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
  if (!params.requiredDelivery) {
    return "succeeded";
  }
  if (params.deliveryStatus === "delivered") {
    return "succeeded";
  }
  return params.deliveryStatus === "not-delivered" ? "failed" : "unknown";
}

/** Resolves completion from the immutable delivery contract admitted for this run. */
export function resolveAdmittedCronCompletionStatus(
  job: CronJob,
  status: CronRunStatus,
  deliveryStatus: CronDeliveryStatus,
): CronCompletionStatus {
  return resolveCronCompletionStatus({
    status,
    deliveryStatus,
    requiredDelivery: isCronDeliveryRequired(job),
  });
}
