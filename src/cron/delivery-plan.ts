/** Resolves cron delivery and failure-notification routing from job config. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import type { CronFailureDestinationConfig } from "../config/types.cron.js";
import { resolveTargetPrefixedChannel } from "../infra/outbound/channel-target-prefix.js";
import { shouldDefaultCronDeliveryToAnnounce } from "./delivery-defaults.js";
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

function normalizeThreadIdentity(value: unknown): string | undefined {
  const normalized = normalizeOptionalThreadValue(value);
  return normalized == null ? undefined : String(normalized);
}

function resolveAnnounceChannel(params: {
  channel?: CronMessageChannel;
  to?: string;
}): CronMessageChannel {
  if (params.channel && params.channel !== "last") {
    return params.channel;
  }
  // A prefixed recipient like "slack:C123" is enough to infer the channel when
  // the cron config intentionally leaves channel at "last" or unset.
  return (
    (resolveTargetPrefixedChannel(params.to) as CronMessageChannel | undefined) ??
    params.channel ??
    "last"
  );
}

/** Resolves primary delivery config into the runtime mode/channel/target plan. */
export function resolveCronDeliveryPlan(
  job: Pick<CronJob, "delivery"> & Partial<Pick<CronJob, "payload" | "sessionTarget">>,
): CronDeliveryPlan {
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

  // Isolated/current/session output jobs default to announce delivery so their
  // result reaches the initiating session unless the job opts out. Keep this
  // aligned with create-time normalization and direct service callers.
  const resolvedMode =
    job.payload &&
    job.sessionTarget &&
    shouldDefaultCronDeliveryToAnnounce({
      payloadKind: job.payload.kind,
      sessionTarget: job.sessionTarget,
    })
      ? "announce"
      : "none";

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
type CronFailureDeliveryPlan = {
  mode: "announce" | "webhook";
  channel?: CronMessageChannel;
  to?: string;
  accountId?: string;
};

/** Job-level failure destination override fields before global defaults are merged. */
type CronFailureDestinationInput = {
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
  job: Pick<CronJob, "delivery">,
  globalConfig?: CronFailureDestinationConfig,
  jobAlertRoute?: CronFailureDestinationInput,
): CronFailureDeliveryPlan | null {
  const delivery = job.delivery;
  const jobFailureDest = delivery?.failureDestination as CronFailureDestinationInput | undefined;

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

  // Apply the delivery override first, then the job's failureAlert route. This
  // is the canonical route layering used by mutation validation and finalization.
  for (const routeOverride of [jobFailureDest, jobAlertRoute]) {
    if (!routeOverride || typeof routeOverride !== "object") {
      continue;
    }
    const overrideTo = normalizeOptionalString(routeOverride.to);
    const explicitOverrideChannel = normalizeChannel(routeOverride.channel);
    const overrideChannel =
      explicitOverrideChannel ??
      (overrideTo
        ? (resolveTargetPrefixedChannel(overrideTo) as CronMessageChannel | undefined)
        : undefined);
    const overrideAccountId = normalizeOptionalString(routeOverride.accountId);
    const overrideMode = normalizeFailureMode(routeOverride.mode);
    const hasChannelField = "channel" in routeOverride;
    const hasToField = "to" in routeOverride;
    const hasAccountIdField = "accountId" in routeOverride;
    const hasModeField = "mode" in routeOverride;

    const hasExplicitTo = hasToField && overrideTo !== undefined;
    const globalChannel = resolveAnnounceChannel({ channel, to });

    if (hasChannelField || (overrideChannel && overrideTo)) {
      channel = overrideChannel;
      if (overrideChannel && overrideChannel !== globalChannel) {
        // Targets and accounts belong to the channel that supplied them.
        if (!hasToField) {
          to = undefined;
        }
        if (!hasAccountIdField) {
          accountId = undefined;
        }
      }
    }
    if (hasToField) {
      to = overrideTo;
    }
    if (hasAccountIdField) {
      accountId = overrideAccountId;
    }
    // Naming a channel makes this an announce route even when mode is omitted;
    // inheriting webhook here would reinterpret the chat target as a URL.
    const overrideImpliesAnnounce = !hasModeField && overrideChannel !== undefined;
    if (hasModeField || overrideImpliesAnnounce) {
      const effectiveOverrideMode = overrideImpliesAnnounce ? "announce" : overrideMode;
      const globalMode = mode ?? "announce";
      const resolvedOverrideMode = effectiveOverrideMode ?? "announce";
      if (globalMode !== resolvedOverrideMode) {
        // Chat targets and accounts cannot be reused as webhook routing, or vice versa.
        if (!hasChannelField) {
          channel = undefined;
        }
        if (!hasExplicitTo) {
          to = undefined;
        }
        if (!hasAccountIdField) {
          accountId = undefined;
        }
      }
      mode = effectiveOverrideMode;
    }
  }

  const jobAlertOnlySelectsMode =
    jobAlertRoute?.mode !== undefined &&
    jobAlertRoute.channel === undefined &&
    jobAlertRoute.to === undefined &&
    jobAlertRoute.accountId === undefined;
  if (!channel && !to && !accountId && (!mode || jobAlertOnlySelectsMode)) {
    return null;
  }

  const resolvedMode = mode ?? "announce";
  if (resolvedMode === "webhook" && !to) {
    // Webhook failure destinations are only useful with a concrete URL/target.
    return null;
  }

  const result: CronFailureDeliveryPlan = {
    mode: resolvedMode,
    channel: resolvedMode === "announce" ? resolveAnnounceChannel({ channel, to }) : undefined,
    to,
    accountId,
  };

  if (delivery && isSameDeliveryTarget(delivery, result)) {
    // Avoid sending the same failure text through the primary delivery route twice.
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
  const primaryThreadId = normalizeThreadIdentity(delivery.threadId);

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
    failurePlan.accountId === primaryAccountId &&
    primaryThreadId === undefined
  );
}
