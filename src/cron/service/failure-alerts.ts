/** Resolves and emits cron failure-alert notifications. */
import { randomUUID } from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { classifyOAuthRefreshFailure } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import type { FailoverReason } from "../../agents/failover/signal.js";
import { buildCodexLoginRecovery } from "../../auto-reply/codex-login-recovery.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeAnyChannelId } from "../../channels/registry-normalize.js";
import { resolveTargetPrefixedChannel } from "../../infra/outbound/channel-target-prefix.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "../delivery-plan.js";
import { cronFailureDetailLines } from "../failure-notification-text.js";
import type {
  CronFailureNotificationDelivery,
  CronFailureNotificationDetail,
  CronJob,
  CronMessageChannel,
} from "../types.js";
import { applyCronRuntimeRowsToState, commitCronRuntimeRows } from "./runtime-store.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { enqueueCronNotification } from "./wake.js";

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
  alternateRoute: boolean;
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
    return normalizeAnyChannelId(normalized) ?? normalized;
  }
  return normalizeCronMessageChannel(resolveTargetPrefixedChannel(to)) ?? normalized;
}

function normalizeFailureAlertRecipient(channel: CronMessageChannel, to: string): string {
  try {
    return normalizeTargetForProvider(channel, to) ?? to;
  } catch {
    // Invalid loaded targets are distinct routes; they must not block run finalization.
    return to;
  }
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
  state: { deps: Pick<CronServiceState["deps"], "cronConfig"> },
  job: Pick<CronJob, "delivery" | "failureAlert">,
): ResolvedFailureAlert | null {
  const globalConfig = state.deps.cronConfig?.failureAlert;
  const jobConfig = job.failureAlert === false ? undefined : job.failureAlert;

  if (job.failureAlert === false) {
    return null;
  }
  if (!jobConfig && globalConfig?.enabled === false) {
    return null;
  }
  const hasJobRoute = Boolean(
    jobConfig &&
    (jobConfig.channel !== undefined ||
      jobConfig.to !== undefined ||
      jobConfig.accountId !== undefined ||
      jobConfig.mode !== undefined),
  );
  const alternateRoute = resolveFailureDestination(
    job,
    globalConfig,
    hasJobRoute ? jobConfig : undefined,
  );
  const primaryRoute = resolveCronDeliveryPlan(job);
  const primaryAnnounceRoute =
    primaryRoute.mode === "announce" && primaryRoute.requested ? primaryRoute : undefined;
  const explicitlyConfigured = jobConfig !== undefined || globalConfig !== undefined;
  if (!alternateRoute && !primaryAnnounceRoute && !explicitlyConfigured) {
    return null;
  }
  const configuredMode =
    jobConfig?.mode ?? (jobConfig?.channel ? "announce" : undefined) ?? globalConfig?.mode;
  const route =
    alternateRoute ??
    (configuredMode === "webhook" && explicitlyConfigured
      ? {
          mode: "webhook",
          to: normalizeOptionalString(jobConfig?.to ?? globalConfig?.to),
          accountId: normalizeOptionalString(jobConfig?.accountId ?? globalConfig?.accountId),
        }
      : primaryAnnounceRoute);
  const mode = (route?.mode ?? configuredMode) === "webhook" ? "webhook" : "announce";
  const primaryChannel = primaryAnnounceRoute
    ? (resolveFailureAlertChannel(primaryAnnounceRoute.channel, primaryAnnounceRoute.to) ?? "last")
    : undefined;
  const hasAnnounceRouteSelector =
    jobConfig?.channel !== undefined ||
    jobConfig?.to !== undefined ||
    job.delivery?.failureDestination?.channel !== undefined ||
    job.delivery?.failureDestination?.to !== undefined ||
    globalConfig?.channel !== undefined ||
    globalConfig?.to !== undefined;
  const channel =
    mode === "announce" && !hasAnnounceRouteSelector && primaryChannel
      ? primaryChannel
      : (resolveFailureAlertChannel(route?.channel, route?.to) ?? "last");
  const routeUsesPrimaryChannel =
    mode === "announce" && primaryAnnounceRoute !== undefined && channel === primaryChannel;
  const to =
    normalizeOptionalString(route?.to) ??
    (routeUsesPrimaryChannel ? primaryAnnounceRoute?.to : undefined);
  const primaryRecipientMatches =
    primaryAnnounceRoute !== undefined &&
    mode === "announce" &&
    channel === primaryChannel &&
    (to === primaryAnnounceRoute.to ||
      (to !== undefined &&
        primaryAnnounceRoute.to !== undefined &&
        normalizeFailureAlertRecipient(channel, to) ===
          normalizeFailureAlertRecipient(channel, primaryAnnounceRoute.to)));
  const accountId =
    normalizeOptionalString(route?.accountId) ??
    (primaryRecipientMatches ? primaryAnnounceRoute?.accountId : undefined);
  // A configured failure destination has no thread and stays distinct from a
  // threaded primary peer unless a job alert names its own recipient.
  const primaryRouteMatches =
    primaryRecipientMatches &&
    accountId === primaryAnnounceRoute?.accountId &&
    (alternateRoute === null ||
      !job.delivery?.failureDestination ||
      primaryAnnounceRoute?.threadId == null ||
      jobConfig?.to !== undefined);

  return {
    after: clampPositiveInt(jobConfig?.after ?? globalConfig?.after, DEFAULT_FAILURE_ALERT_AFTER),
    cooldownMs: clampNonNegativeInt(
      jobConfig?.cooldownMs ?? globalConfig?.cooldownMs,
      DEFAULT_FAILURE_ALERT_COOLDOWN_MS,
    ),
    channel,
    to,
    mode,
    accountId,
    threadId: primaryRouteMatches ? primaryAnnounceRoute.threadId : undefined,
    includeSkipped: jobConfig?.includeSkipped ?? globalConfig?.includeSkipped ?? false,
    alternateRoute: alternateRoute !== null && !primaryRouteMatches,
  };
}

/**
 * Commits the settled failure-alert send outcome onto the authoritative cron
 * row through the row-scoped runtime transaction. The write is fenced to the
 * alert identity captured at dispatch, so a superseding alert or run cannot
 * be overwritten by a late completion, and a recipient already reached is
 * never downgraded to not-delivered.
 */
function recordFailureNotificationDeliveryOutcome(
  state: CronServiceState,
  params: {
    jobId: string;
    alertAtMs: number | undefined;
    attemptId: string | undefined;
    delivered: boolean;
    error?: string;
  },
): void {
  try {
    const committedJob = commitCronRuntimeRows({
      state,
      jobIds: [params.jobId],
      operationLabel: "cron.failure-alert-outcome",
      mutate: ({ jobs }) => {
        const job = jobs.get(params.jobId);
        if (!job) {
          return { value: undefined };
        }
        const rowAttemptId = job.state.lastFailureNotificationAttemptId;
        const staleRow =
          // A later cooldown-suppressed run reset the fields to not-requested.
          job.state.lastFailureNotificationDeliveryStatus === "not-requested" ||
          // An earlier settled attempt of this alert already reached the recipient.
          job.state.lastFailureNotificationDelivered === true ||
          // A newer alert attempt owns the delivery fields now.
          (rowAttemptId !== undefined && rowAttemptId !== params.attemptId) ||
          // Legacy row written before this attempt identity was persisted: only
          // trust a completion while the alert timestamp still matches exactly.
          (rowAttemptId === undefined && job.state.lastFailureAlertAtMs !== params.alertAtMs);
        if (staleRow) {
          return { value: undefined };
        }
        job.state.lastFailureNotificationDelivered = params.delivered;
        job.state.lastFailureNotificationDeliveryStatus = params.delivered
          ? "delivered"
          : "not-delivered";
        job.state.lastFailureNotificationDeliveryError = params.error;
        return { upsertJobIds: [job.id], value: job };
      },
    });
    if (committedJob) {
      applyCronRuntimeRowsToState(state, [committedJob]);
    }
  } catch (err: unknown) {
    state.deps.log.warn(
      { jobId: params.jobId, err: String(err) },
      "cron: failure alert delivery outcome persist failed",
    );
  }
}

function transportFailureAlert(
  state: CronServiceState,
  params: {
    job: CronJob;
    payload: ReplyPayload;
    runAtMs?: number;
    route: ResolvedFailureAlert;
  },
): void {
  const alertAtMs = params.job.state.lastFailureAlertAtMs;
  const attemptId = params.job.state.lastFailureNotificationAttemptId;
  let pendingFallback = true;
  let reachedRecipient = false;
  const fallback = (reached = false) => {
    if (pendingFallback && !reached) {
      enqueueCronNotification(state, params.job, params.payload.text ?? "", "failure-alert");
    }
    pendingFallback = false;
  };
  if (!state.deps.sendCronFailureAlert) {
    fallback();
    recordFailureNotificationDeliveryOutcome(state, {
      jobId: params.job.id,
      alertAtMs,
      attemptId,
      delivered: false,
    });
    return;
  }
  void state.deps
    .sendCronFailureAlert({
      job: params.job,
      payload: params.payload,
      runAtMs: params.runAtMs,
      channel: params.route.channel,
      to: params.route.to,
      mode: params.route.mode,
      accountId: params.route.accountId,
      threadId: params.route.threadId,
      ...(params.route.alternateRoute ? { inheritSessionThread: false as const } : {}),
      onDeliveryAttempt: (reached) => {
        if (reached) {
          reachedRecipient = true;
        }
        fallback(reached);
      },
    })
    .then(() => {
      recordFailureNotificationDeliveryOutcome(state, {
        jobId: params.job.id,
        alertAtMs,
        attemptId,
        delivered: reachedRecipient,
      });
    })
    .catch((err: unknown) => {
      state.deps.log.warn(
        { jobId: params.job.id, err: String(err) },
        "cron: failure alert delivery failed",
      );
      fallback();
      // The recipient-reached callback is the delivery fact; a later
      // transport exception does not un-deliver an alert that landed.
      recordFailureNotificationDeliveryOutcome(state, {
        jobId: params.job.id,
        alertAtMs,
        attemptId,
        delivered: reachedRecipient,
        ...(reachedRecipient ? {} : { error: err instanceof Error ? err.message : String(err) }),
      });
    });
}

function emitFailureAlert(
  state: CronServiceState,
  params: {
    job: CronJob;
    error?: string;
    errorReason?: FailoverReason;
    failureNotificationDetail?: CronFailureNotificationDetail;
    runAtMs?: number;
    consecutiveErrors: number;
    route: ResolvedFailureAlert;
    status: "error" | "skipped";
  },
) {
  const safeJobName = params.job.name || params.job.id;
  const errorReason = params.status === "error" ? params.errorReason : undefined;
  // Keep alert bodies compact because they may route through chat channels
  // with notification previews and provider-specific message limits.
  const statusVerb = params.status === "skipped" ? "skipped" : "failed";
  const detailLabel = params.status === "skipped" ? "Skip reason" : "Last error";
  const detailLines =
    params.route.mode === "webhook"
      ? [
          ...(errorReason ? [`Cause: ${errorReason}`] : []),
          `${detailLabel}: ${truncateUtf16Safe(params.error?.trim() || "unknown reason", 200)}`,
        ]
      : cronFailureDetailLines(errorReason, params.failureNotificationDetail);
  const text = [
    `Automation "${safeJobName}" ${statusVerb} ${params.consecutiveErrors} times`,
    ...detailLines,
  ].join("\n");
  const oauthRefreshFailure = params.error ? classifyOAuthRefreshFailure(params.error) : null;
  const codexLoginRecovery =
    params.status === "error" && (errorReason === "auth" || errorReason === "auth_permanent")
      ? buildCodexLoginRecovery({
          provider: oauthRefreshFailure?.provider,
          oauthReason: oauthRefreshFailure?.reason,
        })
      : undefined;
  const payload: ReplyPayload = {
    text: codexLoginRecovery ? `${text}\n${codexLoginRecovery.hint}` : text,
    ...(codexLoginRecovery ? { presentation: codexLoginRecovery.presentation } : {}),
  };

  transportFailureAlert(state, {
    job: params.job,
    payload,
    runAtMs: params.runAtMs,
    route: params.route,
  });
}

function requestFailureNotification(
  state: CronServiceState,
  job: CronJob,
  alertConfig: ResolvedFailureAlert,
): boolean {
  const now = state.deps.nowMs();
  const lastAlert = job.state.lastFailureAlertAtMs;
  // Cooldown is stored on job state so process restarts and service reloads do
  // not spam operators. Future timestamps cannot prove a recent prior alert.
  const inCooldown =
    typeof lastAlert === "number" &&
    lastAlert <= now &&
    now - lastAlert < Math.max(0, alertConfig.cooldownMs);
  if (inCooldown) {
    return false;
  }
  job.state.lastFailureNotificationDelivered = undefined;
  job.state.lastFailureNotificationDeliveryStatus = "unknown";
  job.state.lastFailureNotificationDeliveryError = undefined;
  job.state.lastFailureNotificationAttemptId = randomUUID();
  job.state.lastFailureAlertAtMs = now;
  return true;
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
    failureNotificationDetail?: CronFailureNotificationDetail;
    runAtMs?: number;
    consecutiveCount: number;
    deferredNotifications?: DeferredCronNotifications;
  },
) {
  const alertConfig = params.alertConfig;
  if (!alertConfig || params.consecutiveCount < alertConfig.after) {
    return;
  }
  // Best-effort delivery suppresses inherited alert noise, not an independently
  // configured job alert that the operator explicitly requested.
  if (params.job.delivery?.bestEffort === true && !params.job.failureAlert) {
    return;
  }
  if (!requestFailureNotification(state, params.job, alertConfig)) {
    return;
  }

  const job = structuredClone(params.job);
  const notify = () =>
    emitFailureAlert(state, {
      job,
      error: params.error,
      errorReason: params.errorReason,
      failureNotificationDetail: params.failureNotificationDetail,
      runAtMs: params.runAtMs,
      consecutiveErrors: params.consecutiveCount,
      route: alertConfig,
      status: params.status,
    });
  if (params.deferredNotifications) {
    params.deferredNotifications.push(notify);
  } else {
    notify();
  }
}

/** Finalizes execution or required-delivery alerts after scheduling policy settles. */
export function finalizeCronFailureNotifications(
  state: CronServiceState,
  params: {
    job: CronJob;
    alertConfig: ResolvedFailureAlert | null;
    result: {
      status: "ok" | "error" | "skipped";
      error?: string;
      failureNotificationDetail?: CronFailureNotificationDetail;
      startedAt: number;
    };
    completionFailed: boolean;
    autoDisableNotificationOwnsFailure: boolean;
    replay?: boolean;
    deferredNotifications?: DeferredCronNotifications;
  },
): void {
  // Finalized history owns notification facts and cooldown; recovery never requests an alert.
  if (params.replay) {
    return;
  }
  if (params.result.status === "error" && !params.autoDisableNotificationOwnsFailure) {
    maybeEmitFailureAlert(state, {
      job: params.job,
      alertConfig: params.alertConfig,
      status: "error",
      error: params.result.error,
      errorReason: params.job.state.lastErrorReason,
      failureNotificationDetail: params.result.failureNotificationDetail,
      runAtMs: params.result.startedAt,
      consecutiveCount: params.job.state.consecutiveErrors ?? 0,
      deferredNotifications: params.deferredNotifications,
    });
  } else if (
    params.result.status === "ok" &&
    params.completionFailed &&
    params.job.state.lastDeliveryStatus === "not-delivered" &&
    params.alertConfig?.alternateRoute
  ) {
    if (!requestFailureNotification(state, params.job, params.alertConfig)) {
      return;
    }
    const job = structuredClone(params.job);
    const route = params.alertConfig;
    const detailLines =
      route.mode === "webhook"
        ? [
            `Last error: ${truncateUtf16Safe(job.state.lastDeliveryError?.trim() || "unknown reason", 200)}`,
          ]
        : cronFailureDetailLines(job.state.lastErrorReason);
    const payload: ReplyPayload = {
      text: [`Automation "${job.name || job.id}" delivery failed`, ...detailLines].join("\n"),
    };
    const notify = () =>
      transportFailureAlert(state, {
        job,
        payload,
        runAtMs: params.result.startedAt,
        route,
      });
    if (params.deferredNotifications) {
      params.deferredNotifications.push(notify);
    } else {
      notify();
    }
  }
}
