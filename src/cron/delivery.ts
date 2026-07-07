import type { CliDeps } from "../cli/deps.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import type { CronFailureDestinationConfig } from "../config/types.cron.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { getChildLogger } from "../logging.js";
import { resolveDeliveryTarget } from "./isolated-agent/delivery-target.js";
import type { CronDelivery, CronDeliveryMode, CronJob, CronMessageChannel } from "./types.js";

export type CronDeliveryPlan = {
  mode: CronDeliveryMode;
  channel?: CronMessageChannel;
  to?: string;
  /** Explicit channel account id from the delivery config, if set. */
  accountId?: string;
  /** Thread ID for threaded replies (e.g., Slack threads). */
  threadId?: string | number;
  source: "delivery" | "payload";
  requested: boolean;
};

function normalizeChannel(value: unknown): CronMessageChannel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return trimmed as CronMessageChannel;
}

function normalizeTo(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeAccountId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveCronDeliveryPlan(job: CronJob): CronDeliveryPlan {
  const payload = job.payload.kind === "agentTurn" ? job.payload : null;
  const delivery = job.delivery;
  const hasDelivery = delivery && typeof delivery === "object";
  const rawMode = hasDelivery ? (delivery as { mode?: unknown }).mode : undefined;
  const normalizedMode = typeof rawMode === "string" ? rawMode.trim().toLowerCase() : rawMode;
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

  const payloadChannel = normalizeChannel(payload?.channel);
  const payloadTo = normalizeTo(payload?.to);
  const deliveryChannel = normalizeChannel(
    (delivery as { channel?: unknown } | undefined)?.channel,
  );
  const deliveryTo = normalizeTo((delivery as { to?: unknown } | undefined)?.to);
  const channel = deliveryChannel ?? payloadChannel ?? "last";
  const to = deliveryTo ?? payloadTo;
  const deliveryAccountId = normalizeAccountId(
    (delivery as { accountId?: unknown } | undefined)?.accountId,
  );
  if (hasDelivery) {
    const resolvedMode = mode ?? "announce";
    // When mode is 'none', ignore channel and to fields since there's no delivery
    const effectiveChannel = resolvedMode === "announce" ? channel : undefined;
    const effectiveTo = resolvedMode === "announce" ? to : undefined;
    return {
      mode: resolvedMode,
      channel: effectiveChannel,
      to: effectiveTo,
      accountId: deliveryAccountId,
      threadId: payload?.threadId,
      source: "delivery",
      requested: resolvedMode === "announce",
    };
  }

  const legacyMode =
    payload?.deliver === true ? "explicit" : payload?.deliver === false ? "off" : "auto";
  const hasExplicitTarget = Boolean(to);
  const requested = legacyMode === "explicit" || (legacyMode === "auto" && hasExplicitTarget);

  return {
    mode: requested ? "announce" : "none",
    channel,
    to,
    threadId: payload?.threadId,
    source: "payload",
    requested,
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
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
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

  // Start with global config as base
  if (globalConfig) {
    channel = normalizeChannel(globalConfig.channel);
    to = normalizeTo(globalConfig.to);
    accountId = normalizeAccountId(globalConfig.accountId);
    mode = normalizeFailureMode(globalConfig.mode);
  }

  // Override with job-level values if present
  if (hasJobFailureDest) {
    const jobChannel = normalizeChannel(jobFailureDest.channel);
    const jobTo = normalizeTo(jobFailureDest.to);
    const jobAccountId = normalizeAccountId(jobFailureDest.accountId);
    const jobMode = normalizeFailureMode(jobFailureDest.mode);
    const hasJobChannelField = "channel" in jobFailureDest;
    const hasJobToField = "to" in jobFailureDest;
    const hasJobAccountIdField = "accountId" in jobFailureDest;

    // Track if 'to' was explicitly set at job level
    const jobToExplicitValue = hasJobToField && jobTo !== undefined;

    // Respect explicit clears from partial patches.
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
      // Mode was explicitly overridden - clear inherited 'to' since URL semantics differ
      // between announce (channel recipient) and webhook (HTTP endpoint)
      // But preserve explicit 'to' that was set at job level
      // Treat undefined global mode as "announce" for comparison
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

  // Webhook mode requires a URL
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

const FAILURE_NOTIFICATION_TIMEOUT_MS = 30_000;
const cronDeliveryLogger = getChildLogger({ subsystem: "cron-delivery" });

export async function sendFailureNotificationAnnounce(
  deps: CliDeps,
  cfg: OpenClawConfig,
  agentId: string,
  jobId: string,
  target: { channel?: string; to?: string; accountId?: string },
  message: string,
): Promise<void> {
  const resolvedTarget = await resolveDeliveryTarget(cfg, agentId, {
    channel: target.channel as CronMessageChannel | undefined,
    to: target.to,
    accountId: target.accountId,
  });

  if (!resolvedTarget.ok) {
    cronDeliveryLogger.warn(
      { error: resolvedTarget.error.message },
      "cron: failed to resolve failure destination target",
    );
    return;
  }

  const identity = resolveAgentOutboundIdentity(cfg, agentId);
  const session = buildOutboundSessionContext({
    cfg,
    agentId,
    sessionKey: `cron:${jobId}:failure`,
  });

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, FAILURE_NOTIFICATION_TIMEOUT_MS);

  try {
    await deliverOutboundPayloads({
      cfg,
      channel: resolvedTarget.channel,
      to: resolvedTarget.to,
      accountId: resolvedTarget.accountId,
      threadId: resolvedTarget.threadId,
      payloads: [{ text: message }],
      session,
      identity,
      bestEffort: false,
      deps: createOutboundSendDeps(deps),
      abortSignal: abortController.signal,
    });
  } catch (err) {
    cronDeliveryLogger.warn(
      {
        err: formatErrorMessage(err),
        channel: resolvedTarget.channel,
        to: resolvedTarget.to,
      },
      "cron: failure destination announce failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}
