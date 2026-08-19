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
  if (!jobConfig && globalConfig?.enabled !== true) {
    return null;
  }

  const mode = jobConfig?.mode ?? globalConfig?.mode;
  const inheritsGlobalMode =
    !jobConfig?.mode || jobConfig.mode === (globalConfig?.mode ?? "announce");
  const jobTo = normalizeOptionalString(jobConfig?.to);
  const jobChannel = resolveFailureAlertChannel(jobConfig?.channel, jobTo);
  const configuredGlobalTo = inheritsGlobalMode
    ? normalizeOptionalString(globalConfig?.to)
    : undefined;
  const globalChannel = inheritsGlobalMode
    ? resolveFailureAlertChannel(globalConfig?.channel, configuredGlobalTo)
    : undefined;
  // Webhook destinations have no chat-channel identity. Announce destinations
  // must stay on their original channel when a job overrides its route.
  const inheritsGlobalRoute =
    inheritsGlobalMode && (mode === "webhook" || !jobChannel || jobChannel === globalChannel);
  const globalTo = inheritsGlobalRoute ? configuredGlobalTo : undefined;
  const deliveryTo = normalizeOptionalString(job.delivery?.to);
  const deliveryChannel = resolveFailureAlertChannel(job.delivery?.channel, deliveryTo);
  const channel = jobChannel ?? globalChannel ?? deliveryChannel ?? "last";
  const inheritsDeliveryChannel =
    channel === deliveryChannel || (channel === "last" && !deliveryChannel);
  const compatibleDeliveryTo = inheritsDeliveryChannel ? deliveryTo : undefined;
  const explicitTo = jobTo ?? globalTo;
  const inheritsDeliveryRoute =
    inheritsDeliveryChannel &&
    (explicitTo === undefined ||
      explicitTo === deliveryTo ||
      (deliveryTo !== undefined &&
        normalizeFailureAlertRecipient(channel, explicitTo) ===
          normalizeFailureAlertRecipient(channel, deliveryTo)));
  const inheritedDeliveryAccountId =
    mode !== "webhook" && inheritsDeliveryRoute ? job.delivery?.accountId : undefined;
  const accountId =
    jobConfig?.accountId ??
    (inheritsGlobalRoute ? globalConfig?.accountId : undefined) ??
    inheritedDeliveryAccountId;
  // A topic belongs to its channel, peer, and account; never attach the
  // primary topic to an independently routed failure destination.
  const inheritsDeliveryThread =
    mode !== "webhook" && inheritsDeliveryRoute && accountId === job.delivery?.accountId;

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
    failureNotificationDetail?: CronFailureNotificationDetail;
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
  const errorReason = params.status === "error" ? params.errorReason : undefined;
  // Keep alert bodies compact because they may route through chat channels
  // with notification previews and provider-specific message limits.
  const statusVerb = params.status === "skipped" ? "skipped" : "failed";
  const detailLabel = params.status === "skipped" ? "Skip reason" : "Last error";
  const detailLines =
    params.mode === "webhook"
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

  if (state.deps.sendCronFailureAlert) {
    void state.deps
      .sendCronFailureAlert({
        job: params.job,
        payload,
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

  enqueueCronSystemEvent(state, payload.text ?? "", {
    agentId: params.job.agentId,
    sessionKey: params.job.sessionKey,
  });
  if (params.job.wakeMode === "now") {
    requestCronHeartbeat(state, {
      intent: "immediate",
      reason: `cron:${params.job.id}:failure-alert`,
      agentId: params.job.agentId,
      sessionKey: params.job.sessionKey,
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
    typeof lastAlert === "number" && now - lastAlert < Math.max(0, alertConfig.cooldownMs);
  if (inCooldown) {
    return;
  }
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
      channel: alertConfig.channel,
      to: alertConfig.to,
      mode: alertConfig.mode,
      accountId: alertConfig.accountId,
      threadId: alertConfig.threadId,
      status: params.status,
    });
  if (params.deferredNotifications) {
    params.deferredNotifications.push(notify);
  } else {
    notify();
  }
}
