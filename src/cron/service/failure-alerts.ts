/** Resolves and emits cron failure-alert notifications. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { classifyOAuthRefreshFailure } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import type { FailoverReason } from "../../agents/failover/signal.js";
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
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { enqueueCronSystemEvent, requestCronHeartbeat } from "./wake.js";

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
  const primaryRouteMatches =
    primaryRecipientMatches && accountId === primaryAnnounceRoute?.accountId;

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

function enqueueFailureAlertFallback(state: CronServiceState, job: CronJob, text: string): void {
  enqueueCronSystemEvent(state, text, {
    agentId: job.agentId,
    sessionKey: job.sessionKey,
  });
  if (job.wakeMode === "now") {
    requestCronHeartbeat(state, {
      intent: "immediate",
      reason: `cron:${job.id}:failure-alert`,
      agentId: job.agentId,
      sessionKey: job.sessionKey,
    });
  }
}

function markFailureNotificationRequested(job: CronJob): void {
  job.state.lastFailureNotificationDelivered = undefined;
  job.state.lastFailureNotificationDeliveryStatus = "unknown";
  job.state.lastFailureNotificationDeliveryError = undefined;
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
  const fallback = () => enqueueFailureAlertFallback(state, params.job, params.payload.text ?? "");
  if (!state.deps.sendCronFailureAlert) {
    fallback();
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
    })
    .catch((err: unknown) => {
      state.deps.log.warn(
        { jobId: params.job.id, err: String(err) },
        "cron: failure alert delivery failed",
      );
      fallback();
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
  const payload: ReplyPayload = {
    text,
    ...(params.status === "error" &&
    (errorReason === "auth" || errorReason === "auth_permanent") &&
    oauthRefreshFailure?.provider === "openai"
      ? {
          presentation: {
            blocks: [
              {
                type: "buttons" as const,
                buttons: [
                  {
                    label: "Log in to Codex",
                    action: { type: "command" as const, command: "/login codex" },
                  },
                ],
              },
            ],
          },
        }
      : {}),
  };

  transportFailureAlert(state, {
    job: params.job,
    payload,
    runAtMs: params.runAtMs,
    route: params.route,
  });
}

/** Emits a required-completion delivery failure only to an alternate route. */
function maybeEmitDeliveryFailureAlert(
  state: CronServiceState,
  params: {
    job: CronJob;
    alertConfig: ResolvedFailureAlert | null;
    error?: string;
    runAtMs?: number;
    deferredNotifications?: DeferredCronNotifications;
  },
): void {
  if (!params.alertConfig?.alternateRoute) {
    return;
  }
  markFailureNotificationRequested(params.job);
  const job = structuredClone(params.job);
  const safeJobName = job.name || job.id;
  const detailLines =
    params.alertConfig.mode === "webhook"
      ? [`Last error: ${truncateUtf16Safe(params.error?.trim() || "unknown reason", 200)}`]
      : cronFailureDetailLines(job.state.lastErrorReason);
  const payload: ReplyPayload = {
    text: [`Automation "${safeJobName}" delivery failed`, ...detailLines].join("\n"),
  };
  const notify = () =>
    transportFailureAlert(state, {
      job,
      payload,
      runAtMs: params.runAtMs,
      route: params.alertConfig!,
    });
  if (params.deferredNotifications) {
    params.deferredNotifications.push(notify);
  } else {
    notify();
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
    failureNotificationDetail?: CronFailureNotificationDetail;
    runAtMs?: number;
    consecutiveCount: number;
    delivery?: "emit" | "record-only";
    occurredAtMs?: number;
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
  const now = params.occurredAtMs ?? state.deps.nowMs();
  const lastAlert = params.job.state.lastFailureAlertAtMs;
  // Cooldown is stored on job state so process restarts and service reloads do
  // not spam operators with repeated alerts for the same failing job.
  const inCooldown =
    typeof lastAlert === "number" && now - lastAlert < Math.max(0, alertConfig.cooldownMs);
  if (inCooldown) {
    return;
  }
  markFailureNotificationRequested(params.job);
  params.job.state.lastFailureAlertAtMs = now;
  if (params.delivery === "record-only") {
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
      deliveryError?: string;
      failureNotificationDetail?: CronFailureNotificationDetail;
      startedAt: number;
    };
    completionFailed: boolean;
    autoDisableNotificationOwnsFailure: boolean;
    replayFailureAlertAtMs?: number;
    deferredNotifications?: DeferredCronNotifications;
  },
): void {
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
      ...(params.replayFailureAlertAtMs !== undefined
        ? { delivery: "record-only" as const, occurredAtMs: params.replayFailureAlertAtMs }
        : {}),
      deferredNotifications: params.deferredNotifications,
    });
  } else if (params.result.status === "ok" && params.completionFailed) {
    maybeEmitDeliveryFailureAlert(state, {
      job: params.job,
      alertConfig: params.alertConfig,
      error: params.result.deliveryError,
      runAtMs: params.result.startedAt,
      deferredNotifications: params.deferredNotifications,
    });
  }
}
