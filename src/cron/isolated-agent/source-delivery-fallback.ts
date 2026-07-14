import { createSourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import type { SourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import type { CronDeliveryPlan } from "../delivery-plan.js";
import type { CronJob } from "../types.js";

type CronSourceDeliveryResolvedTarget = {
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  ok?: boolean;
};

export function resolveCronSourceDeliveryPlan(params: {
  deliveryPlan: CronDeliveryPlan;
  resolvedDelivery: CronSourceDeliveryResolvedTarget;
}): SourceDeliveryPlan {
  const target = {
    channel: params.resolvedDelivery.channel,
    to: params.resolvedDelivery.to,
    accountId: params.resolvedDelivery.accountId,
    threadId: params.resolvedDelivery.threadId,
  };

  if (params.deliveryPlan.mode === "webhook") {
    return createSourceDeliveryPlan({
      owner: "none",
      reason: "cron_webhook",
      messageToolEnabled: false,
      directFallback: false,
    });
  }

  if (params.deliveryPlan.mode === "none") {
    return createSourceDeliveryPlan({
      owner: "none",
      reason: "cron_none",
      target,
      messageToolEnabled: true,
      messageToolForced: false,
      directFallback: false,
    });
  }

  return createSourceDeliveryPlan({
    owner: "direct_fallback",
    reason: "cron_announce",
    target,
    messageToolEnabled: true,
    messageToolForced: false,
    requireExplicitMessageTarget: true,
    requireExplicitMessageTargetEvidence: true,
    directFallback: true,
    skipFallbackWhenMessageToolSentToTarget: params.resolvedDelivery.ok ?? true,
  });
}

export function resolveFallbackCronSourceDeliveryPlan(
  job: CronJob,
  resolvedDelivery: CronSourceDeliveryResolvedTarget,
): SourceDeliveryPlan {
  const deliveryPlan = resolveCronDeliveryPlan(job);
  return resolveCronSourceDeliveryPlan({ deliveryPlan, resolvedDelivery });
}
