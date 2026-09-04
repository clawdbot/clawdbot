import type { NormalizeReplySkipReason } from "../../auto-reply/reply/normalize-reply-skip-reason.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import {
  HEARTBEAT_IDLE_RETRY_GRACE_MS,
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  HEARTBEAT_SKIP_PREEMPTED,
  type HeartbeatRunResult,
  isRetryableHeartbeatSkipReason,
} from "../../infra/heartbeat-wake.js";
import type { CommandLaneTaskMarker } from "../../process/command-queue.js";
import {
  type CronActiveJobMarker,
  isCronActiveJobMarkerCurrent,
  markCronJobWaitingForHeartbeat,
} from "../active-jobs.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { isHeartbeatTaskCronJob } from "../heartbeat-task.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import { resolveCronToolsAllowExecTargetRecoveryError } from "../scheduled-tool-policy.js";
import { cronScriptFailureMetadata } from "../script-failure.js";
import { appendCronPayloadText, cronStreamScheduleKey } from "../stream-schedule.js";
import type {
  CronDeliveryTrace,
  CronResolvedDeliveryState,
  CronJob,
  CronStoredJob,
  CronNextCheckProposal,
  CronRunOutcome,
  CronRunTelemetry,
} from "../types.js";
import { abortErrorMessage, timeoutErrorMessage } from "./execution-errors.js";
import { resolveJobPayloadTextForMain } from "./jobs-scheduling.js";
import type { CronServiceState } from "./state.js";
import {
  type CronTriggerEvalOutcome,
  type ExecuteJobCoreOptions,
  resolveMainSessionCronDeliveryContext,
} from "./timer-execution-timeout.js";
import {
  normalizeQueuedSystemEventHandle,
  removeQueuedSystemEventHandle,
} from "./timer-trigger.js";
import { enqueueCronSystemEvent, requestCronHeartbeat } from "./wake.js";

/** Executes a cron job without mutating persisted job state. */
export async function executeJobCore(
  state: CronServiceState,
  job: CronStoredJob,
  abortSignal?: AbortSignal,
  options?: ExecuteJobCoreOptions,
): Promise<
  CronRunOutcome &
    CronRunTelemetry & {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      deliveryError?: string;
      deliverySuppressionReason?: NormalizeReplySkipReason;
      deliveryState?: CronResolvedDeliveryState;
      delivery?: CronDeliveryTrace;
      nextCheck?: CronNextCheckProposal;
      scriptStateChanged?: boolean;
      scriptState?: unknown;
      triggerEval?: CronTriggerEvalOutcome;
    }
> {
  const resolveAbortError = () => ({
    status: "error" as const,
    error: abortErrorMessage(abortSignal),
  });
  if (abortSignal?.aborted) {
    return resolveAbortError();
  }
  const execTargetRecoveryError = resolveCronToolsAllowExecTargetRecoveryError({
    jobId: job.id,
    requirement: job.toolsAllowExecTargetRequirement,
    execTarget: job.toolsAllowExecTarget,
  });
  if (execTargetRecoveryError) {
    return {
      status: "error",
      error: execTargetRecoveryError,
      diagnostics: createCronRunDiagnosticsFromError("cron-preflight", execTargetRecoveryError, {
        nowMs: state.deps.nowMs,
      }),
    };
  }
  if (options?.streamScheduleKey !== undefined || options?.streamSourceIdentity !== undefined) {
    // Defense in depth over the locked admission checks: stream-origin work must
    // carry both the source definition and logical identity, and both must still
    // match the execution snapshot.
    const currentKey =
      job.schedule.kind === "stream" ? cronStreamScheduleKey(job.schedule) : undefined;
    if (
      options.streamScheduleKey === undefined ||
      options.streamSourceIdentity === undefined ||
      currentKey !== options.streamScheduleKey ||
      job.state.streamSourceIdentity !== options.streamSourceIdentity
    ) {
      return { status: "skipped", error: "stream batch source no longer current" };
    }
  }
  let effectiveJob = job;
  let triggerEval: CronTriggerEvalOutcome | undefined;
  if (job.trigger) {
    const evaluator = state.deps.evaluateCronTrigger;
    if (!evaluator) {
      return {
        status: "error",
        error: "cron trigger evaluator is unavailable",
        ...cronScriptFailureMetadata("trigger", "runtime_unavailable"),
      };
    }
    const evaluation = await evaluator({
      job,
      script: job.trigger.script,
      state: job.state.triggerState,
      streamBatch: options?.streamBatch,
      abortSignal,
    });
    // Trigger scripts may settle after cancellation; never start payload work
    // or persist trigger results for a run that has already been aborted.
    if (abortSignal?.aborted) {
      return resolveAbortError();
    }
    if (evaluation.kind === "busy") {
      state.deps.log.debug({ jobId: job.id }, "cron: trigger evaluation skipped while busy");
      return {
        status: "ok",
        triggerEval: { fired: false, stateChanged: false, busy: true },
      };
    }
    if (evaluation.kind === "error") {
      return {
        status: "error",
        error: `cron trigger evaluation failed (${evaluation.code}): ${evaluation.error}`,
        ...cronScriptFailureMetadata("trigger", evaluation.code),
        triggerEval: { fired: false, stateChanged: false },
      };
    }
    const stateChanged = Object.hasOwn(evaluation, "state");
    triggerEval = {
      fired: evaluation.fire,
      stateChanged,
      ...(stateChanged ? { state: evaluation.state } : {}),
    };
    if (!evaluation.fire) {
      return { status: "ok", triggerEval };
    }
    if (evaluation.message !== undefined) {
      effectiveJob = { ...job, payload: appendCronPayloadText(job.payload, evaluation.message) };
    }
  }
  options?.assertRunCurrent?.();
  options?.onPayloadExecutionStarted?.();
  if (effectiveJob.payload.kind === "script") {
    const result = await executeScriptCronJob(
      state,
      effectiveJob,
      abortSignal,
      options?.activeJobMarker,
      options?.streamBatch,
      options?.assertRunCurrent,
    );
    return triggerEval ? { ...result, triggerEval } : result;
  }
  if (options?.streamBatch !== undefined) {
    effectiveJob = {
      ...effectiveJob,
      payload: appendCronPayloadText(effectiveJob.payload, options.streamBatch),
    };
  }
  if (effectiveJob.payload.kind === "skillCollectionReview") {
    const result = state.deps.runSkillCollectionReview
      ? await state.deps.runSkillCollectionReview({
          agentId: resolveCronJobEffectiveAgentId(
            effectiveJob,
            state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId,
          ),
          ...(abortSignal ? { abortSignal } : {}),
        })
      : { status: "skipped" as const, summary: "skill collection review runner unavailable" };
    return triggerEval ? { ...result, triggerEval } : result;
  }

  const heartbeatTask = isHeartbeatTaskCronJob(effectiveJob) ? effectiveJob : undefined;
  if (effectiveJob.payload.kind === "heartbeat" || heartbeatTask) {
    // Monitors and migrated tasks share the wake bus, keeping coalescing,
    // quiet hours, cooldown, flood, and busy guards in the heartbeat runner.
    const agentId = resolveCronJobEffectiveAgentId(
      effectiveJob,
      state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId,
    );
    const heartbeatWake = heartbeatTask
      ? {
          source: "interval" as const,
          intent: "task" as const,
          reason: `heartbeat-task:${heartbeatTask.id}`,
          agentId,
          tasks: [
            {
              jobId: heartbeatTask.id,
              name: heartbeatTask.name,
              prompt: heartbeatTask.payload.text,
            },
          ],
        }
      : {
          source: "interval" as const,
          intent: "scheduled" as const,
          reason: "interval",
          agentId,
          scheduledEveryMs:
            effectiveJob.schedule.kind === "every" ? effectiveJob.schedule.everyMs : undefined,
        };
    options?.onHeartbeatExecutionStarted?.(heartbeatWake);
    const releaseHeartbeatWait = markCronJobWaitingForHeartbeat(
      options?.activeJobMarker,
      options?.owningCronLaneTaskMarker,
    );
    let heartbeatResult: HeartbeatRunResult;
    try {
      heartbeatResult = await (state.deps.requestHeartbeatAndWait?.(
        heartbeatWake,
        abortSignal ? { abortSignal } : {},
      ) ?? { status: "failed", reason: "heartbeat wake settlement unavailable" });
    } finally {
      releaseHeartbeatWait();
    }
    if (abortSignal?.aborted) {
      return resolveAbortError();
    }
    const result =
      heartbeatResult.status === "ran"
        ? {
            status: "ok" as const,
            summary: heartbeatTask ? "heartbeat task completed" : "heartbeat completed",
          }
        : heartbeatResult.status === "failed"
          ? { status: "error" as const, error: `heartbeat failed: ${heartbeatResult.reason}` }
          : { status: "skipped" as const, error: `heartbeat skipped: ${heartbeatResult.reason}` };
    return triggerEval ? { ...result, triggerEval } : result;
  }
  if (effectiveJob.sessionTarget === "main") {
    const result = await executeMainSessionCronJob(
      state,
      effectiveJob,
      abortSignal,
      options?.onHeartbeatExecutionStarted,
      options?.activeJobMarker,
      options?.owningCronLaneTaskMarker,
    );
    return triggerEval ? { ...result, triggerEval } : result;
  }

  const result = await executeDetachedCronJob(state, effectiveJob, abortSignal, options);
  return triggerEval ? { ...result, triggerEval } : result;
}

async function executeMainSessionCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal: AbortSignal | undefined,
  onHeartbeatExecutionStarted?: ExecuteJobCoreOptions["onHeartbeatExecutionStarted"],
  activeJobMarker?: CronActiveJobMarker,
  owningCronLaneTaskMarker?: CommandLaneTaskMarker,
): Promise<
  CronRunOutcome &
    CronRunTelemetry & {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      deliveryError?: string;
      delivery?: CronDeliveryTrace;
    }
> {
  const text = resolveJobPayloadTextForMain(job);
  if (!text) {
    const kind = job.payload.kind;
    return {
      status: "skipped",
      error:
        kind === "systemEvent"
          ? "main job requires non-empty systemEvent text"
          : 'main job requires payload.kind="systemEvent"',
    };
  }
  const agentId = resolveCronJobEffectiveAgentId(
    job,
    state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId,
  );
  const deliveryContext = resolveMainSessionCronDeliveryContext(state, job);
  const queuedSystemEvent = normalizeQueuedSystemEventHandle(
    enqueueCronSystemEvent(state, text, {
      agentId,
      contextKey: `cron:${job.id}`,
      ...(deliveryContext ? { deliveryContext } : {}),
    }),
  );
  const heartbeatWake = {
    source: "cron" as const,
    intent: job.wakeMode === "now" ? ("immediate" as const) : ("event" as const),
    reason: `cron:${job.id}`,
    agentId,
    heartbeat: { target: "last" as const },
  };
  const removeQueuedSystemEvent = () =>
    removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
  if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
    onHeartbeatExecutionStarted?.(heartbeatWake);
    const maxWaitMs = state.deps.wakeNowHeartbeatBusyMaxWaitMs ?? 2 * 60_000;
    const retryDelayMs = state.deps.wakeNowHeartbeatBusyRetryDelayMs ?? 250;
    const waitStartedAt = state.deps.nowMs();

    let heartbeatResult: HeartbeatRunResult;
    for (;;) {
      if (abortSignal?.aborted) {
        removeQueuedSystemEvent();
        return { status: "error", error: timeoutErrorMessage() };
      }
      try {
        heartbeatResult = await state.deps.runHeartbeatOnce({
          ...heartbeatWake,
          owningCronJobMarker: activeJobMarker,
          owningCronLaneTaskMarker,
        });
      } catch (error) {
        // A failed immediate heartbeat must not leave its failed run's
        // reminder queued for an unrelated future heartbeat.
        removeQueuedSystemEvent();
        throw error;
      }
      if (abortSignal?.aborted) {
        removeQueuedSystemEvent();
        return { status: "error", error: timeoutErrorMessage() };
      }
      if (
        heartbeatResult.status !== "skipped" ||
        !isRetryableHeartbeatSkipReason(heartbeatResult.reason)
      ) {
        break;
      }
      // A competing cron owner cannot clear until this run finishes, so it must
      // requeue immediately rather than waiting through the normal busy budget.
      const elapsedMs =
        heartbeatResult.reason === HEARTBEAT_SKIP_CRON_IN_PROGRESS
          ? maxWaitMs
          : state.deps.nowMs() - waitStartedAt;
      const delayMs =
        heartbeatResult.retryAtMs !== undefined
          ? Math.max(0, heartbeatResult.retryAtMs - state.deps.nowMs())
          : heartbeatResult.reason === HEARTBEAT_SKIP_PREEMPTED
            ? HEARTBEAT_IDLE_RETRY_GRACE_MS
            : retryDelayMs;
      // A caller's wait budget cannot shorten the runner's retry deadline.
      // Hand unfinished work to the wake owner with its original retry facts.
      if (elapsedMs >= maxWaitMs || delayMs > maxWaitMs - elapsedMs) {
        requestCronHeartbeat(state, heartbeatWake, heartbeatResult);
        return { status: "ok", summary: text };
      }
      try {
        // Keep a one-millisecond turn for expired deadlines; the loop owns abort cleanup.
        await sleepWithAbort(Math.max(1, delayMs), abortSignal);
      } catch (error) {
        if (!isAbortError(error)) {
          throw error;
        }
      }
    }

    if (heartbeatResult.status === "ran") {
      return { status: "ok", summary: text };
    }
    removeQueuedSystemEvent();
    return {
      status: heartbeatResult.status === "skipped" ? "skipped" : "error",
      error: heartbeatResult.reason,
      summary: text,
    };
  }

  if (abortSignal?.aborted) {
    removeQueuedSystemEvent();
    return { status: "error", error: timeoutErrorMessage() };
  }
  requestCronHeartbeat(state, heartbeatWake);
  return { status: "ok", summary: text };
}

async function executeDetachedCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal: AbortSignal | undefined,
  options?: ExecuteJobCoreOptions,
): Promise<
  CronRunOutcome &
    CronRunTelemetry & {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      deliveryError?: string;
      deliverySuppressionReason?: NormalizeReplySkipReason;
      deliveryState?: CronResolvedDeliveryState;
      delivery?: CronDeliveryTrace;
      nextCheck?: CronNextCheckProposal;
    }
> {
  const interrupted = () => {
    const error = abortErrorMessage(abortSignal);
    return {
      status: "error" as const,
      error,
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
        nowMs: state.deps.nowMs,
      }),
    };
  };
  if (job.payload.kind === "command") {
    if (!state.deps.runCommandJob) {
      const error = "cron command runner is not configured";
      return {
        status: "skipped",
        error,
        diagnostics: createCronRunDiagnosticsFromError("cron-preflight", error, {
          severity: "warn",
          nowMs: state.deps.nowMs,
        }),
      };
    }
    const res = await state.deps.runCommandJob({
      job,
      abortSignal,
    });
    if (abortSignal?.aborted) {
      return interrupted();
    }
    return {
      status: res.status,
      error: res.error,
      errorClassification: res.errorClassification,
      deliveryError: res.deliveryError,
      deliverySuppressionReason: res.deliverySuppressionReason,
      deliveryState: res.deliveryState,
      summary: res.summary,
      delivered: res.delivered,
      deliveryAttempted: res.deliveryAttempted,
      delivery: res.delivery,
      diagnostics: res.diagnostics,
      failureNotificationDetail: res.failureNotificationDetail,
    };
  }

  if (job.payload.kind !== "agentTurn") {
    const error = 'isolated job requires payload.kind="agentTurn" or "command"';
    return {
      status: "skipped",
      error,
      diagnostics: createCronRunDiagnosticsFromError("cron-preflight", error, {
        severity: "warn",
        nowMs: state.deps.nowMs,
      }),
    };
  }
  if (abortSignal?.aborted) {
    return interrupted();
  }

  const res = await state.deps.runIsolatedAgentJob({
    job,
    message: job.payload.message,
    abortSignal,
    onExecutionStarted: options?.onExecutionStarted,
    onExecutionPhase: options?.onExecutionPhase,
    onLaneWait: options?.onLaneWait,
    executionIdentity: options?.executionIdentity,
  });

  if (abortSignal?.aborted) {
    return interrupted();
  }

  return {
    status: res.status,
    error: res.error,
    errorClassification: res.errorClassification,
    executionStarted: res.executionStarted,
    // Forward the post-run delivery failure recorded on an otherwise
    // successful run so the service can persist it as `lastDeliveryError` and
    // emit it on the finished event for CLI/UI/API run logs (#95419).
    deliveryError: res.deliveryError,
    deliverySuppressionReason: res.deliverySuppressionReason,
    deliveryState: res.deliveryState,
    nextCheck: res.nextCheck,
    summary: res.summary,
    delivered: res.delivered,
    deliveryAttempted: res.deliveryAttempted,
    delivery: res.delivery,
    sessionId: res.sessionId,
    sessionKey: res.sessionKey,
    diagnostics: res.diagnostics,
    failureNotificationDetail: res.failureNotificationDetail,
    model: res.model,
    provider: res.provider,
    usage: res.usage,
  };
}

async function executeScriptCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal: AbortSignal | undefined,
  activeJobMarker?: CronActiveJobMarker,
  streamBatch?: string,
  assertRunCurrent?: () => void,
) {
  if (state.deps.cronConfig?.triggers?.enabled === false) {
    return {
      status: "error" as const,
      error:
        "cron script payload execution is disabled because the operator set cron.triggers.enabled: false; remove it or set it to true to allow unattended scripts",
    };
  }
  if (!state.deps.runScriptJob) {
    return {
      status: "error" as const,
      error: "cron script payload executor is unavailable",
      ...cronScriptFailureMetadata("payload", "runtime_unavailable"),
    };
  }
  const result = await state.deps.runScriptJob({ job, streamBatch, abortSignal });
  // Script runners may settle after ignoring an abort. Recheck both operator
  // cancellation and scheduler ownership before any notify/wake side effect.
  if (!isCronActiveJobMarkerCurrent(activeJobMarker)) {
    return { status: "error" as const, error: "Gateway restarting." };
  }
  if (abortSignal?.aborted) {
    return { status: "error" as const, error: abortErrorMessage(abortSignal) };
  }
  assertRunCurrent?.();
  if (result.status !== "ok") {
    return result;
  }
  if (result.nextCheck && !job.pacing) {
    return {
      status: "error" as const,
      error: "cron script payload returned nextCheck, but this job has no pacing bounds",
      ...cronScriptFailureMetadata("payload", "invalid_input"),
    };
  }

  const notify = result.notify?.trim() ? result.notify : undefined;
  if ((job.sessionTarget === "main" && notify) || result.wake) {
    const agentId = resolveCronJobEffectiveAgentId(
      job,
      state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId,
    );
    const deliveryContext =
      job.sessionTarget === "main" ? resolveMainSessionCronDeliveryContext(state, job) : undefined;
    const eventOptions = { agentId, ...(deliveryContext ? { deliveryContext } : {}) };
    if (job.sessionTarget === "main" && notify) {
      enqueueCronSystemEvent(state, notify, {
        ...eventOptions,
        contextKey: `cron:${job.id}:script`,
      });
    }
    if (result.wake) {
      if (job.sessionTarget !== "main" || !notify) {
        enqueueCronSystemEvent(state, notify ?? `script job ${job.name} completed`, {
          ...eventOptions,
          contextKey: `cron:${job.id}:script-wake`,
        });
      }
      requestCronHeartbeat(state, {
        source: result.wake === "now" ? "notifications-event" : "cron",
        intent: result.wake === "now" ? "immediate" : "event",
        reason: result.wake === "now" ? "wake" : `cron:${job.id}:script`,
        agentId,
      });
    }
  }
  return {
    status: "ok" as const,
    ...(notify ? { summary: notify } : {}),
    delivered: result.delivered,
    deliveryAttempted: result.deliveryAttempted,
    deliveryError: result.deliveryError,
    deliverySuppressionReason: result.deliverySuppressionReason,
    deliveryState: result.deliveryState,
    delivery: result.delivery,
    nextCheck: result.nextCheck,
    scriptStateChanged: result.stateChanged === true,
    ...(result.stateChanged === true ? { scriptState: result.state } : {}),
  };
}

/** Clears the currently armed cron timer. */
export function stopTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
}
