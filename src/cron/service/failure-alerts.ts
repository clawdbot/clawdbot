import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveFailoverReasonFromError } from "../../agents/failover-error.js";
import type { CronFailureNotificationDelivery, CronJob, CronMessageChannel } from "../types.js";
import type { CronServiceState } from "./state.js";

const DEFAULT_FAILURE_ALERT_AFTER = 2;
const DEFAULT_FAILURE_ALERT_COOLDOWN_MS = 60 * 60_000; // 1 hour

type ResolvedFailureAlert = {
  after: number;
  cooldownMs: number;
  channel: CronMessageChannel;
  to?: string;
  mode?: "announce" | "webhook";
  accountId?: string;
  includeSkipped: boolean;
};

export function failureNotificationDeliveryFromJobState(
  job: CronJob,
): CronFailureNotificationDelivery | undefined {
  const status = job.state.lastFailureNotificationDeliveryStatus;
  if (!status || status === "not-requested") {
    return undefined;
  }
  return {
    delivered: job.state.lastFailureNotificationDelivered,
    status,
    error: job.state.lastFailureNotificationDeliveryError,
  };
}

function normalizeCronMessageChannel(input: unknown): CronMessageChannel | undefined {
  const channel = normalizeOptionalLowercaseString(input);
  return channel ? (channel as CronMessageChannel) : undefined;
}

function normalizeTo(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const to = input.trim();
  return to ? to : undefined;
}

function clampPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return floored >= 1 ? floored : fallback;
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return floored >= 0 ? floored : fallback;
}

export function resolveFailureAlert(
  state: CronServiceState,
  job: CronJob,
): ResolvedFailureAlert | null {
  const globalConfig = state.deps.cronConfig?.failureAlert;
  const jobConfig = job.failureAlert === false ? undefined : job.failureAlert;

  if (job.failureAlert === false) {
    return null;
  }
  if (!jobConfig && globalConfig?.enabled !== true) {
    return null;
  }

  const mode = jobConfig?.mode ?? globalConfig?.mode;
  const explicitTo = normalizeTo(jobConfig?.to);

  return {
    after: clampPositiveInt(jobConfig?.after ?? globalConfig?.after, DEFAULT_FAILURE_ALERT_AFTER),
    cooldownMs: clampNonNegativeInt(
      jobConfig?.cooldownMs ?? globalConfig?.cooldownMs,
      DEFAULT_FAILURE_ALERT_COOLDOWN_MS,
    ),
    channel:
      normalizeCronMessageChannel(jobConfig?.channel) ??
      normalizeCronMessageChannel(job.delivery?.channel) ??
      "last",
    to: mode === "webhook" ? explicitTo : (explicitTo ?? normalizeTo(job.delivery?.to)),
    mode,
    accountId: jobConfig?.accountId ?? globalConfig?.accountId,
    includeSkipped: jobConfig?.includeSkipped ?? globalConfig?.includeSkipped ?? false,
  };
}

function emitFailureAlert(
  state: CronServiceState,
  params: {
    job: CronJob;
    error?: string;
    consecutiveErrors: number;
    channel: CronMessageChannel;
    to?: string;
    mode?: "announce" | "webhook";
    accountId?: string;
    status: "error" | "skipped";
    provider?: string;
  },
) {
  const safeJobName = params.job.name || params.job.id;
  const truncatedError = (params.error?.trim() || "unknown reason").slice(0, 200);
  const errorReason =
    params.status === "error" && typeof params.error === "string"
      ? (resolveFailoverReasonFromError(params.error, params.provider) ?? undefined)
      : undefined;
  const statusVerb = params.status === "skipped" ? "skipped" : "failed";
  const detailLabel = params.status === "skipped" ? "Skip reason" : "Last error";
  const text = [
    `Cron job "${safeJobName}" ${statusVerb} ${params.consecutiveErrors} times`,
    ...(errorReason ? [`Cause: ${errorReason}`] : []),
    `${detailLabel}: ${truncatedError}`,
  ].join("\n");

  if (state.deps.sendCronFailureAlert) {
    void state.deps
      .sendCronFailureAlert({
        job: params.job,
        text,
        channel: params.channel,
        to: params.to,
        mode: params.mode,
        accountId: params.accountId,
      })
      .catch((err) => {
        state.deps.log.warn(
          { jobId: params.job.id, err: String(err) },
          "cron: failure alert delivery failed",
        );
      });
    return;
  }

  state.deps.enqueueSystemEvent(text, { agentId: params.job.agentId });
  if (params.job.wakeMode === "now") {
    state.deps.requestHeartbeat({
      source: "cron",
      intent: "immediate",
      reason: `cron:${params.job.id}:failure-alert`,
    });
  }
}

export function maybeEmitFailureAlert(
  state: CronServiceState,
  params: {
    job: CronJob;
    alertConfig: ResolvedFailureAlert | null;
    status: "error" | "skipped";
    error?: string;
    provider?: string;
    consecutiveCount: number;
  },
) {
  if (!params.alertConfig || params.consecutiveCount < params.alertConfig.after) {
    return;
  }
  const isBestEffort = params.job.delivery?.bestEffort === true;
  if (isBestEffort) {
    return;
  }
  const now = state.deps.nowMs();
  const lastAlert = params.job.state.lastFailureAlertAtMs;
  const inCooldown =
    typeof lastAlert === "number" && now - lastAlert < Math.max(0, params.alertConfig.cooldownMs);
  if (inCooldown) {
    return;
  }
  emitFailureAlert(state, {
    job: params.job,
    error: params.error,
    consecutiveErrors: params.consecutiveCount,
    channel: params.alertConfig.channel,
    to: params.alertConfig.to,
    mode: params.alertConfig.mode,
    accountId: params.alertConfig.accountId,
    status: params.status,
    provider: params.provider,
  });
  params.job.state.lastFailureAlertAtMs = now;
}
