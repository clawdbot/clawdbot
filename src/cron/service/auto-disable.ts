/** Shared state and owner-notification policy for cron auto-disable transitions. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { cronFailureDetailLines } from "../failure-notification-text.js";
import type { CronJob, CronJobState } from "../types.js";
import { normalizeOptionalAgentId } from "./normalize.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";

type CronAutoDisableReason = NonNullable<CronJobState["autoDisabled"]>["reason"];

/**
 * Run failures get more room than schedule errors (10 vs. 3) because provider
 * and network errors are often transient, and restart-interrupted runs count too.
 */
const MAX_CONSECUTIVE_RUN_FAILURES = 10;

function autoDisableReasonLabel(reason: CronAutoDisableReason): string {
  return reason === "consecutive-failures" ? "run failures" : "schedule errors";
}

/** Records one canonical auto-disable fact and queues its owning-agent notification. */
export function autoDisableCronJob(params: {
  state: CronServiceState;
  job: CronJob;
  reason: CronAutoDisableReason;
  atMs: number;
  consecutiveErrors: number;
  deferredNotifications?: DeferredCronNotifications;
}): boolean {
  const { state, job } = params;
  if (!job.enabled || job.state.autoDisabled) {
    return false;
  }

  job.enabled = false;
  job.state.nextRunAtMs = undefined;
  job.state.autoDisabled = {
    reason: params.reason,
    atMs: params.atMs,
    consecutiveErrors: params.consecutiveErrors,
  };

  const name = truncateUtf16Safe((job.name || job.id).replace(/\s+/g, " ").trim(), 120);
  const errorReason =
    params.reason === "consecutive-failures" ? job.state.lastErrorReason : undefined;
  const text = [
    `⚠️ Automation "${name}" was auto-disabled after ${params.consecutiveErrors} consecutive ${autoDisableReasonLabel(params.reason)}.`,
    ...cronFailureDetailLines(errorReason),
    `Fix the underlying cause, then run \`openclaw automations enable ${job.id}\` to re-enable it.`,
  ].join("\n");
  const notify = () => {
    const agentId =
      normalizeOptionalAgentId(job.agentId) ??
      normalizeOptionalAgentId(parseAgentSessionKey(job.sessionKey)?.agentId) ??
      normalizeOptionalAgentId(state.deps.resolveDefaultAgentId?.()) ??
      normalizeOptionalAgentId(state.deps.defaultAgentId);
    const deliveryContext =
      agentId || job.sessionKey
        ? state.deps.resolveOriginDeliveryContext?.({
            agentId,
            sessionKey: job.sessionKey,
          })
        : undefined;
    state.deps.enqueueSystemEvent(text, {
      agentId,
      sessionKey: job.sessionKey,
      contextKey: `cron:${job.id}:auto-disabled`,
      ...(deliveryContext ? { deliveryContext } : {}),
    });
    state.deps.requestHeartbeat({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      agentId,
      sessionKey: job.sessionKey,
    });
  };

  if (params.deferredNotifications) {
    params.deferredNotifications.push(notify);
  } else {
    // Production mutations always supply a post-persist queue; this fallback
    // remains only for direct unit callers that have no durable owner.
    notify();
  }
  return true;
}

/** Auto-disables only time-based recurring jobs once their run-error streak reaches the limit. */
export function maybeAutoDisableCronJobAfterRunFailure(params: {
  state: CronServiceState;
  job: CronJob;
  atMs: number;
  deferredNotifications?: DeferredCronNotifications;
}): boolean {
  const consecutiveErrors = params.job.state.consecutiveErrors ?? 0;
  if (
    (params.job.schedule.kind !== "cron" && params.job.schedule.kind !== "every") ||
    consecutiveErrors < MAX_CONSECUTIVE_RUN_FAILURES
  ) {
    return false;
  }
  return autoDisableCronJob({
    ...params,
    reason: "consecutive-failures",
    consecutiveErrors,
  });
}
