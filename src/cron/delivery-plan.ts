import type { CronFailureDestinationConfig } from "../config/types.cron.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "../shared/string-coerce.js";
import type { CronDelivery, CronDeliveryMode, CronJob, CronMessageChannel } from "./types.js";

export type CronDeliveryPlan = {
  mode: CronDeliveryMode;
  channel?: CronMessageChannel;
  to?: string;
  threadId?: string | number;
  /** Explicit channel account id from the delivery config, if set. */
  accountId?: string;
  source: "delivery";
  requested: boolean;
};

function normalizeChannel(value: unknown): CronMessageChannel | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed as CronMessageChannel;
}

export function resolveCronDeliveryPlan(job: CronJob): CronDeliveryPlan {
  const delivery = job.delivery;
  const hasDelivery = delivery && typeof delivery === "object";
  const rawMode = hasDelivery ? (delivery as { mode?: unknown }).mode : undefined;
  const normalizedMode =
    typeof rawMode === "string" ? normalizeLowercaseStringOrEmpty(rawMode) : rawMode;
  const mode =
    normalizedMode === "announce"
      ? "announce"
      : normalizedMode === "webhook"
        ? "webhook"
        : normalizedMode === "none"
          ? "none"
          : normalizedMode === "deliver"
            ? "announce"
            : undefined;

  const deliveryChannel = normalizeChannel(
    (delivery as { channel?: unknown } | undefined)?.channel,
  );
  const deliveryTo = normalizeOptionalString((delivery as { to?: unknown } | undefined)?.to);
  const deliveryThreadId = normalizeOptionalThreadValue(
    (delivery as { threadId?: unknown } | undefined)?.threadId,
  );
  const to = deliveryTo;
  const deliveryAccountId = normalizeOptionalString(
    (delivery as { accountId?: unknown } | undefined)?.accountId,
  );
  if (hasDelivery) {
    const resolvedMode = mode ?? "announce";
    const channel = resolvedMode === "announce" ? (deliveryChannel ?? "last") : deliveryChannel;
    return {
      mode: resolvedMode,
      channel: resolvedMode === "webhook" ? undefined : channel,
      to,
      threadId: resolvedMode === "webhook" ? undefined : deliveryThreadId,
      accountId: deliveryAccountId,
      source: "delivery",
      requested: resolvedMode === "announce",
    };
  }

  const isIsolatedAgentTurn =
    job.payload.kind === "agentTurn" &&
    (job.sessionTarget === "isolated" ||
      job.sessionTarget === "current" ||
      job.sessionTarget.startsWith("session:"));
  const resolvedMode = isIsolatedAgentTurn ? "announce" : "none";

  return {
    mode: resolvedMode,
    channel: resolvedMode === "announce" ? "last" : undefined,
    to: undefined,
    threadId: undefined,
    source: "delivery",
    requested: resolvedMode === "announce",
  };
}

export type CronFailureDeliveryPlan = {
  mode: "announce" | "webhook";
  channel?: CronMessageChannel;
  to?: string;
  accountId?: string;
};

export type CronFailureDestinationInput = {
  channel?: CronMessageChannel;
  to?: string;
  accountId?: string;
  mode?: "announce" | "webhook";
};

function normalizeFailureMode(value: unknown): "announce" | "webhook" | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  if (trimmed === "announce" || trimmed === "webhook") {
    return trimmed;
  }
  return undefined;
}

export function resolveFailureDestination(
  job: CronJob,
  globalConfig?: CronFailureDestinationConfig,
): CronFailureDeliveryPlan | null {
  const delivery = job.delivery;
  const jobFailureDest = delivery?.failureDestination as CronFailureDestinationInput | undefined;
  const hasJobFailureDest = jobFailureDest && typeof jobFailureDest === "object";

  let channel: CronMessageChannel | undefined;
  let to: string | undefined;
  let accountId: string | undefined;
  let mode: "announce" | "webhook" | undefined;

  if (globalConfig) {
    channel = normalizeChannel(globalConfig.channel);
    to = normalizeOptionalString(globalConfig.to);
    accountId = normalizeOptionalString(globalConfig.accountId);
    mode = normalizeFailureMode(globalConfig.mode);
  }

  if (hasJobFailureDest) {
    const jobChannel = normalizeChannel(jobFailureDest.channel);
    const jobTo = normalizeOptionalString(jobFailureDest.to);
    const jobAccountId = normalizeOptionalString(jobFailureDest.accountId);
    const jobMode = normalizeFailureMode(jobFailureDest.mode);
    const hasJobChannelField = "channel" in jobFailureDest;
    const hasJobToField = "to" in jobFailureDest;
    const hasJobAccountIdField = "accountId" in jobFailureDest;

    const jobToExplicitValue = hasJobToField && jobTo !== undefined;

    if (hasJobChannelField) {
      channel = jobChannel;
    }
    if (hasJobToField) {
      to = jobTo;
    }
    if (hasJobAccountIdField) {
      accountId = jobAccountId;
    }
    if (jobMode !== undefined) {
      const globalMode = globalConfig?.mode ?? "announce";
      if (!jobToExplicitValue && globalMode !== jobMode) {
        to = undefined;
      }
      mode = jobMode;
    }
  }

  if (!channel && !to && !accountId && !mode) {
    return null;
  }

  const resolvedMode = mode ?? "announce";
  if (resolvedMode === "webhook" && !to) {
    return null;
  }

  const result: CronFailureDeliveryPlan = {
    mode: resolvedMode,
    channel: resolvedMode === "announce" ? (channel ?? "last") : undefined,
    to,
    accountId,
  };

  if (delivery && isSameDeliveryTarget(delivery, result)) {
    return null;
  }

  return result;
}

function isSameDeliveryTarget(
  delivery: CronDelivery,
  failurePlan: CronFailureDeliveryPlan,
): boolean {
  const primaryMode = delivery.mode ?? "announce";
  if (primaryMode === "none") {
    return false;
  }

  const primaryChannel = delivery.channel;
  const primaryTo = delivery.to;
  const primaryAccountId = delivery.accountId;

  if (failurePlan.mode === "webhook") {
    return primaryMode === "webhook" && primaryTo === failurePlan.to;
  }

  const primaryChannelNormalized = primaryChannel ?? "last";
  const failureChannelNormalized = failurePlan.channel ?? "last";

  return (
    failureChannelNormalized === primaryChannelNormalized &&
    failurePlan.to === primaryTo &&
    failurePlan.accountId === primaryAccountId
  );
}
