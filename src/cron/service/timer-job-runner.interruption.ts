// Pure interruption-outcome mapping for cron runs; kept separate so the
// cancellation/timeout branches and their invariants are directly testable.
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import type { CronJob } from "../types.js";
import type { IsolatedAgentSetupTimeoutSignal } from "./timer-execution-timeout.js";
import type { executeJobCore } from "./timer-execution.js";

type CronCoreRunOutcome = Awaited<ReturnType<typeof executeJobCore>> & {
  isolatedAgentSetupTimeout?: IsolatedAgentSetupTimeoutSignal;
};
export type CronRunProgress = {
  completedCoreResult?: CronCoreRunOutcome;
  settledDeliveryResult?: CronCoreRunOutcome;
};

export function withPrimaryWebhookTrace(params: {
  job: CronJob;
  result: CronCoreRunOutcome;
  delivered: boolean;
  error?: string;
}): CronCoreRunOutcome {
  const plan = resolveCronDeliveryPlan(params.job);
  const intended = params.result.delivery?.intended ?? {
    to: plan.to,
    source: "explicit" as const,
  };
  return {
    ...params.result,
    delivered: params.delivered,
    deliveryAttempted: true,
    ...(params.error ? { deliveryError: params.error } : { deliveryError: undefined }),
    delivery: {
      ...params.result.delivery,
      intended,
      delivered: params.delivered,
      resolved: {
        to: plan.to,
        source: "explicit",
        ok: params.delivered,
        ...(params.error ? { error: params.error } : {}),
      },
    },
  };
}

export function withPrimaryWebhookInterruption(params: {
  job: CronJob;
  result: CronCoreRunOutcome;
  error: string;
}): CronCoreRunOutcome {
  // Mirror deliverPrimaryWebhook's unfired-trigger gate: a trigger that
  // evaluated false never requested delivery, so an interruption must not
  // downgrade its intentional non-outcome to a delivery failure.
  return resolveCronDeliveryPlan(params.job).mode === "webhook" &&
    params.result.triggerEval?.fired !== false
    ? withPrimaryWebhookTrace({ ...params, delivered: false })
    : params.result;
}

export function resolveInterruptedRunProgress(params: {
  progress: CronRunProgress;
  job: CronJob;
  error: string;
}): CronCoreRunOutcome | undefined {
  if (params.progress.settledDeliveryResult) {
    return params.progress.settledDeliveryResult;
  }
  if (params.progress.completedCoreResult) {
    return withPrimaryWebhookInterruption({
      job: params.job,
      result: params.progress.completedCoreResult,
      error: params.error,
    });
  }
  return undefined;
}
