type CronCompletionRunStatus = "ok" | "error" | "skipped";

type CronCompletionDeliveryStatus = "delivered" | "not-delivered" | "unknown" | "not-requested";

type CronCompletionJob = {
  delivery?: {
    mode?: "none" | "announce" | "webhook";
    bestEffort?: boolean;
  };
};

/** Whole-run completion after execution and any explicitly required delivery settle. */
export type CronCompletionStatus = "succeeded" | "failed" | "unknown";

/** Required delivery is an explicit admitted policy, never an inferred default. */
function isCronDeliveryRequired(job: CronCompletionJob): boolean {
  return (
    job.delivery?.bestEffort === false &&
    (job.delivery.mode === "announce" || job.delivery.mode === "webhook")
  );
}

/** Resolves authored completion from an admitted job, or legacy completion from stored facts. */
export function resolveCronCompletionStatus(params: {
  status?: CronCompletionRunStatus;
  delivered?: boolean;
  deliveryStatus?: CronCompletionDeliveryStatus;
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
  job: CronCompletionJob,
  status: CronCompletionRunStatus,
  deliveryStatus: CronCompletionDeliveryStatus,
): CronCompletionStatus {
  return resolveCronCompletionStatus({
    status,
    deliveryStatus,
    requiredDelivery: isCronDeliveryRequired(job),
  });
}
