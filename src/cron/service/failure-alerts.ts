/** Resolves and emits cron failure-alert notifications. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { FailoverReason } from "../../agents/embedded-agent-helpers/types.js";
import { resolveTargetPrefixedChannel } from "../../infra/outbound/channel-target-prefix.js";
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
  threadId?: string | number;
  includeSkipped: boolean;
};

/** Returns the last failure-notification delivery trace persisted on a cron job. */
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

function resolveFailureAlertChannel(channel: unknown, to?: string): CronMessageChannel | undefined {
  const normalized = normalizeCronMessageChannel(channel);
  if (normalized && normalized !== "last") {
    return normalized;
  }
  return normalizeCronMessageChannel(resolveTargetPrefixedChannel(to)) ?? normalized;
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

/** Resolves effective failure-alert policy from job config, delivery defaults, and global cron config. */
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
  const inheritsGlobalMode =
    !jobConfig?.mode || jobConfig.mode === (globalConfig?.mode ?? "announce");
  const jobTo = normalizeTo(jobConfig?.to);
  const jobChannel = resolveFailureAlertChannel(jobConfig?.channel, jobTo);
  const configuredGlobalTo = inheritsGlobalMode ? normalizeTo(globalConfig?.to) : undefined;
  const globalChannel = inheritsGlobalMode
    ? resolveFailureAlertChannel(globalConfig?.channel, configuredGlobalTo)
    : undefined;
  // Webhook destinations have no chat-channel identity. Announce destinations
  // must stay on their original channel when a job overrides its route.
  const inheritsGlobalRoute =
    inheritsGlobalMode && (mode === "webhook" || !jobChannel || jobChannel === globalChannel);
  const globalTo = inheritsGlobalRoute ? configuredGlobalTo : undefined;
  const deliveryTo = normalizeTo(job.delivery?.to);
  const deliveryChannel = resolveFailureAlertChannel(job.delivery?.channel, deliveryTo);
  const channel = jobChannel ?? globalChannel ?? deliveryChannel ?? "last";
  const inheritsDeliveryChannel =
    channel === deliveryChannel || (channel === "last" && !deliveryChannel);
  const compatibleDeliveryTo = inheritsDeliveryChannel ? deliveryTo : undefined;
  const explicitTo = jobTo ?? globalTo;
  const inheritedDeliveryAccountId =
    mode !== "webhook" && !explicitTo && inheritsDeliveryChannel
      ? job.delivery?.accountId
      : undefined;
  const accountId =
    jobConfig?.accountId ??
    (inheritsGlobalRoute ? globalConfig?.accountId : undefined) ??
    inheritedDeliveryAccountId;
  // A topic belongs to its channel, peer, and account; never attach the
  // primary topic to an independently routed failure destination.
  const inheritsDeliveryThread =
    mode !== "webhook" &&
    inheritsDeliveryChannel &&
    (explicitTo === undefined || explicitTo === deliveryTo) &&
    accountId === job.delivery?.accountId;

  // Announce alerts inherit the job delivery target; webhook alerts require an
  // explicit alert target so chat recipients are not reused as URLs.
  return {
    after: clampPositiveInt(jobConfig?.after ?? globalConfig?.after, DEFAULT_FAILURE_ALERT_AFTER),
    cooldownMs: clampNonNegativeInt(
      jobConfig?.cooldownMs ?? globalConfig?.cooldownMs,
      DEFAULT_FAILURE_ALERT_COOLDOWN_MS,
    ),
    channel,
    to: mode === "webhook" ? explicitTo : (explicitTo ?? compatibleDeliveryTo),
    mode,
    accountId,
    threadId: inheritsDeliveryThread ? job.delivery?.threadId : undefined,
    includeSkipped: jobConfig?.includeSkipped ?? globalConfig?.includeSkipped ?? false,
  };
}

function emitFailureAlert(
  state: CronServiceState,
  params: {
    job: CronJob;
    error?: string;
    errorReason?: FailoverReason;
    runAtMs?: number;
    consecutiveErrors: number;
    channel: CronMessageChannel;
    to?: string;
    mode?: "announce" | "webhook";
    accountId?: string;
    threadId?: string | number;
    status: "error" | "skipped";
  },
) {
  const safeJobName = params.job.name || params.job.id;
  const truncatedError = truncateUtf16Safe(params.error?.trim() || "unknown reason", 200);
  const errorReason = params.status === "error" ? params.errorReason : undefined;
  // Keep alert bodies compact because they may route through chat channels
  // with notification previews and provider-specific message limits.
  const statusVerb = params.status === "skipped" ? "skipped" : "failed";
  const detailLabel = params.status === "skipped" ? "Skip reason" : "Last error";
  const text = [
    `Automation "${safeJobName}" ${statusVerb} ${params.consecutiveErrors} times`,
    ...(errorReason ? [`Cause: ${errorReason}`] : []),
    `${detailLabel}: ${truncatedError}`,
  ].join("\n");

  if (state.deps.sendCronFailureAlert) {
    void state.deps
      .sendCronFailureAlert({
        job: params.job,
        text,
        runAtMs: params.runAtMs,
        channel: params.channel,
        to: params.to,
        mode: params.mode,
        accountId: params.accountId,
        threadId: params.threadId,
      })
      .catch((err: unknown) => {
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

/** Emits a failure alert when threshold, best-effort, and cooldown policy allow it. */
export function maybeEmitFailureAlert(
  state: CronServiceState,
  params: {
    job: CronJob;
    alertConfig: ResolvedFailureAlert | null;
    status: "error" | "skipped";
    error?: string;
    errorReason?: FailoverReason;
    runAtMs?: number;
    consecutiveCount: number;
    delivery?: "emit" | "record-only";
    occurredAtMs?: number;
  },
) {
  if (!params.alertConfig || params.consecutiveCount < params.alertConfig.after) {
    return;
  }
  if (
    params.status === "error" &&
    !params.job.failureAlert &&
    params.job.delivery?.failureDestination
  ) {
    // Completion delivery owns explicit failure routes and clear-only opt-outs.
    // Suppress failed-run duplicates without disabling global skipped alerts.
    return;
  }
  // Best-effort delivery suppresses inherited alert noise, not an independently
  // configured job alert that the operator explicitly requested.
  if (params.job.delivery?.bestEffort === true && !params.job.failureAlert) {
    return;
  }
  const now = params.occurredAtMs ?? state.deps.nowMs();
  const lastAlert = params.job.state.lastFailureAlertAtMs;
  // Cooldown is stored on job state so process restarts and service reloads do
  // not spam operators with repeated alerts for the same failing job.
  const inCooldown =
    typeof lastAlert === "number" && now - lastAlert < Math.max(0, params.alertConfig.cooldownMs);
  if (inCooldown) {
    return;
  }
  if (params.delivery !== "record-only") {
    emitFailureAlert(state, {
      job: params.job,
      error: params.error,
      errorReason: params.errorReason,
      runAtMs: params.runAtMs,
      consecutiveErrors: params.consecutiveCount,
      channel: params.alertConfig.channel,
      to: params.alertConfig.to,
      mode: params.alertConfig.mode,
      accountId: params.alertConfig.accountId,
      threadId: params.alertConfig.threadId,
      status: params.status,
    });
  }
  params.job.state.lastFailureAlertAtMs = now;
}
