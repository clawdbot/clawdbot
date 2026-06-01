import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import type { CronFailureDestinationConfig } from "../config/types.cron.js";
import { resolveTargetPrefixedChannel } from "../infra/outbound/channel-target-prefix.js";
import type { CronDelivery, CronDeliveryMode, CronJob, CronMessageChannel } from "./types.js";

/** Normalized routing plan for a cron job's primary delivery behavior. */
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

/** Returns whether a delivery plan names a concrete channel, recipient, thread, or account. */
export function hasExplicitCronDeliveryTarget(plan: CronDeliveryPlan): boolean {
  return Boolean(
    (plan.channel && plan.channel !== "last") || plan.to || plan.threadId != null || plan.accountId,
  );
}

function normalizeChannel(value: unknown): CronMessageChannel | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed as CronMessageChannel;
}

function resolveAnnounceChannel(params: {
  channel?: CronMessageChannel;
  to?: string;
}): CronMessageChannel {
  if (params.channel && params.channel !== "last") {
    return params.channel;
  }
  return (
    (resolveTargetPrefixedChannel(params.to) as CronMessageChannel | undefined) ??
    params.channel ??
    "last"
  );
}

/** Resolves primary delivery config into the runtime mode/channel/target plan. */
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
    const channel =
      resolvedMode === "announce"
        ? resolveAnnounceChannel({ channel: deliveryChannel, to })
        : deliveryChannel;
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
    typeof job.sessionTarget === "string" &&
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

/** Normalized destination for notifying about cron execution failures. */
export type CronFailureDeliveryPlan = {
  mode: "announce" | "webhook";
  channel?: CronMessageChannel;
  to?: string;
  accountId?: string;
};

/** Job-level failure destination override fields before global defaults are merged. */
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

/** Resolves job-level failure notification routing layered over global defaults. */
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
    const hasJobModeField = "mode" in jobFailureDest;

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
    if (hasJobModeField) {
      const globalMode = globalConfig?.mode ?? "announce";
      const resolvedJobMode = jobMode ?? "announce";
      if (!jobToExplicitValue && globalMode !== resolvedJobMode) {
        // Do not carry an inherited target across modes; an announce chat is not a webhook URL.
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
    channel: resolvedMode === "announce" ? resolveAnnounceChannel({ channel, to }) : undefined,
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

  const primaryTo = normalizeOptionalString(delivery.to);
  const primaryAccountId = normalizeOptionalString(delivery.accountId);

  if (failurePlan.mode === "webhook") {
    return primaryMode === "webhook" && primaryTo === failurePlan.to;
  }

  const primaryChannelNormalized = resolveAnnounceChannel({
    channel: normalizeChannel(delivery.channel),
    to: primaryTo,
  });
  const failureChannelNormalized = failurePlan.channel ?? "last";

  return (
    failureChannelNormalized === primaryChannelNormalized &&
    failurePlan.to === primaryTo &&
    failurePlan.accountId === primaryAccountId
  );
}
