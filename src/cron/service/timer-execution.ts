import {
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  type HeartbeatRunResult,
  isRetryableHeartbeatBusySkipReason,
} from "../../infra/heartbeat-wake.js";
import type { CommandLaneTaskMarker } from "../../process/command-queue.js";
import { type CronActiveJobMarker, isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import { isHeartbeatTaskCronJob } from "../heartbeat-task.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import { appendCronPayloadText, cronStreamScheduleKey } from "../stream-schedule.js";
import type {
  CronDeliveryTrace,
  CronJob,
  CronNextCheckProposal,
  CronRunOutcome,
  CronRunTelemetry,
} from "../types.js";
import { abortErrorMessage, timeoutErrorMessage } from "./execution-errors.js";
import { resolveJobPayloadTextForMain } from "./jobs.js";
import type { CronServiceState } from "./state.js";
import { resolveMainSessionCronRunSessionKey } from "./task-runs.js";
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
  job: CronJob,
  abortSignal?: AbortSignal,
  options?: ExecuteJobCoreOptions,
): Promise<
  CronRunOutcome &
    CronRunTelemetry & {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      deliveryError?: string;
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
  const waitWithAbort = async (ms: number) => {
    if (!abortSignal) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
      return;
    }
    if (abortSignal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  };

  if (abortSignal?.aborted) {
    return resolveAbortError();
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
      return { status: "error", error: "cron trigger evaluator is unavailable" };
    }
    const evaluation = await evaluator({
      job,
      script: job.trigger.script,
      state: job.state.triggerState,
      streamBatch: options?.streamBatch,
      abortSignal,
    });
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
  if (effectiveJob.payload.kind === "script") {
    const result = await executeScriptCronJob(
      state,
      effectiveJob,
      abortSignal,
      options?.activeJobMarker,
      options?.streamBatch,
    );
    return triggerEval ? { ...result, triggerEval } : result;
  }
  if (options?.streamBatch !== undefined) {
    effectiveJob = {
      ...effectiveJob,
      payload: appendCronPayloadText(effectiveJob.payload, options.streamBatch),
    };
  }
  if (effectiveJob.payload.kind === "heartbeat") {
    // The monitor only pokes the wake queue: coalescing, busy-retry, and the
    // quiet-hours guard all live in the heartbeat runner, exactly as they did
    // for the dedicated interval timer this job replaces.
    state.deps.requestHeartbeat({
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      agentId: effectiveJob.agentId,
      scheduledEveryMs:
        effectiveJob.schedule.kind === "every" ? effectiveJob.schedule.everyMs : undefined,
      scheduledAnchorMs:
        effectiveJob.schedule.kind === "every" ? effectiveJob.schedule.anchorMs : undefined,
    });
    const result = { status: "ok" as const, summary: "heartbeat wake requested" };
    return triggerEval ? { ...result, triggerEval } : result;
  }
  if (isHeartbeatTaskCronJob(effectiveJob)) {
    // Migrated tasks stay editable public cron jobs, but execution uses the
    // heartbeat wake bus so active-hours, cooldown, flood, and busy guards remain authoritative.
    state.deps.requestHeartbeat({
      source: "interval",
      intent: "task",
      reason: `heartbeat-task:${effectiveJob.id}`,
      agentId: effectiveJob.agentId,
      tasks: [
        {
          jobId: effectiveJob.id,
          name: effectiveJob.name,
          prompt: effectiveJob.payload.text,
        },
      ],
    });
    const result = { status: "ok" as const, summary: "heartbeat task wake requested" };
    return triggerEval ? { ...result, triggerEval } : result;
  }
  if (effectiveJob.sessionTarget === "main") {
    const result = await executeMainSessionCronJob(
      state,
      effectiveJob,
      abortSignal,
      waitWithAbort,
      options?.activeJobMarker,
      options?.owningCronLaneTaskMarker,
    );
    return triggerEval ? { ...result, triggerEval } : result;
  }

  const result = await executeDetachedCronJob(
    state,
    effectiveJob,
    abortSignal,
    resolveAbortError,
    options,
  );
  return triggerEval ? { ...result, triggerEval } : result;
}

async function executeMainSessionCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal: AbortSignal | undefined,
  waitWithAbort: (ms: number) => Promise<void>,
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
  const cronStartedAt =
    typeof job.state.runningAtMs === "number" ? job.state.runningAtMs : state.deps.nowMs();
  const cronRunSessionKey = resolveMainSessionCronRunSessionKey(job, cronStartedAt);
  const deliveryContext = resolveMainSessionCronDeliveryContext(state, job);
  // Main-session jobs enqueue text into a per-run child session so each cron
  // execution has its own transcript and task drill-down target.
  const queuedSystemEvent = normalizeQueuedSystemEventHandle(
    enqueueCronSystemEvent(state, text, {
      agentId: job.agentId,
      sessionKey: cronRunSessionKey,
      contextKey: `cron:${job.id}`,
      ...(deliveryContext ? { deliveryContext } : {}),
    }),
  );
  if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
    const reason = `cron:${job.id}`;
    const maxWaitMs = state.deps.wakeNowHeartbeatBusyMaxWaitMs ?? 2 * 60_000;
    const retryDelayMs = state.deps.wakeNowHeartbeatBusyRetryDelayMs ?? 250;
    const waitStartedAt = state.deps.nowMs();

    let heartbeatResult: HeartbeatRunResult;
    for (;;) {
      if (abortSignal?.aborted) {
        removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
        return { status: "error", error: timeoutErrorMessage() };
      }
      heartbeatResult = await state.deps.runHeartbeatOnce({
        source: "cron",
        intent: "immediate",
        reason,
        agentId: job.agentId,
        sessionKey: cronRunSessionKey,
        owningCronJobMarker: activeJobMarker,
        owningCronLaneTaskMarker,
        heartbeat: { target: "last" },
      });
      if (abortSignal?.aborted) {
        removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
        return { status: "error", error: timeoutErrorMessage() };
      }
      if (
        heartbeatResult.status !== "skipped" ||
        !isRetryableHeartbeatBusySkipReason(heartbeatResult.reason)
      ) {
        break;
      }
      if (heartbeatResult.reason === HEARTBEAT_SKIP_CRON_IN_PROGRESS) {
        // Only another cron run or lane pressure reaches here. Requeue instead of
        // waiting on markers that cannot clear until both runs finish.
        state.deps.requestHeartbeat({
          source: "cron",
          intent: "immediate",
          reason,
          agentId: job.agentId,
          sessionKey: cronRunSessionKey,
          heartbeat: { target: "last" },
        });
        return { status: "ok", summary: text, sessionKey: cronRunSessionKey };
      }
      if (abortSignal?.aborted) {
        removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
        return { status: "error", error: timeoutErrorMessage() };
      }
      if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
        if (abortSignal?.aborted) {
          removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
          return { status: "error", error: timeoutErrorMessage() };
        }
        state.deps.requestHeartbeat({
          source: "cron",
          intent: "immediate",
          reason,
          agentId: job.agentId,
          sessionKey: cronRunSessionKey,
          heartbeat: { target: "last" },
        });
        return { status: "ok", summary: text, sessionKey: cronRunSessionKey };
      }
      await waitWithAbort(retryDelayMs);
    }

    if (heartbeatResult.status === "ran") {
      return { status: "ok", summary: text, sessionKey: cronRunSessionKey };
    }
    if (heartbeatResult.status === "skipped") {
      removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
      return {
        status: "skipped",
        error: heartbeatResult.reason,
        summary: text,
        sessionKey: cronRunSessionKey,
      };
    }
    removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
    return {
      status: "error",
      error: heartbeatResult.reason,
      summary: text,
      sessionKey: cronRunSessionKey,
    };
  }

  if (abortSignal?.aborted) {
    removeQueuedSystemEventHandle(state, job, queuedSystemEvent);
    return { status: "error", error: timeoutErrorMessage() };
  }
  requestCronHeartbeat(state, {
    intent: job.wakeMode === "now" ? "immediate" : "event",
    reason: `cron:${job.id}`,
    agentId: job.agentId,
    sessionKey: cronRunSessionKey,
    heartbeat: { target: "last" },
  });
  return { status: "ok", summary: text, sessionKey: cronRunSessionKey };
}

async function executeDetachedCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal: AbortSignal | undefined,
  resolveAbortError: () => { status: "error"; error: string },
  options?: ExecuteJobCoreOptions,
): Promise<
  CronRunOutcome &
    CronRunTelemetry & {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      deliveryError?: string;
      delivery?: CronDeliveryTrace;
      nextCheck?: CronNextCheckProposal;
    }
> {
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
      const error = abortErrorMessage(abortSignal);
      return {
        status: "error",
        error,
        diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
          nowMs: state.deps.nowMs,
        }),
      };
    }
    return {
      status: res.status,
      error: res.error,
      deliveryError: res.deliveryError,
      summary: res.summary,
      delivered: res.delivered,
      deliveryAttempted: res.deliveryAttempted,
      delivery: res.delivery,
      diagnostics: res.diagnostics,
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
    const aborted = resolveAbortError();
    return {
      ...aborted,
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", aborted.error, {
        nowMs: state.deps.nowMs,
      }),
    };
  }

  const res = await state.deps.runIsolatedAgentJob({
    job,
    message: job.payload.message,
    abortSignal,
    onExecutionStarted: options?.onExecutionStarted,
    onExecutionPhase: options?.onExecutionPhase,
    onLaneWait: options?.onLaneWait,
  });

  if (abortSignal?.aborted) {
    const error = abortErrorMessage(abortSignal);
    return {
      status: "error",
      error,
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
        nowMs: state.deps.nowMs,
      }),
    };
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
    nextCheck: res.nextCheck,
    summary: res.summary,
    delivered: res.delivered,
    deliveryAttempted: res.deliveryAttempted,
    delivery: res.delivery,
    sessionId: res.sessionId,
    sessionKey: res.sessionKey,
    diagnostics: res.diagnostics,
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
) {
  if (state.deps.cronConfig?.triggers?.enabled !== true) {
    return {
      status: "error" as const,
      error:
        "cron script payload execution is disabled; set cron.triggers.enabled=true to allow unattended scripts",
    };
  }
  if (!state.deps.runScriptJob) {
    return { status: "error" as const, error: "cron script payload executor is unavailable" };
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
  if (result.status !== "ok") {
    return result;
  }
  if (result.nextCheck && !job.pacing) {
    return {
      status: "error" as const,
      error: "cron script payload returned nextCheck, but this job has no pacing bounds",
    };
  }

  const notify = result.notify?.trim() ? result.notify : undefined;
  if (job.sessionTarget === "main" && notify) {
    enqueueCronSystemEvent(state, notify, {
      agentId: job.agentId,
      contextKey: `cron:${job.id}:script`,
    });
  }
  if (result.wake) {
    const eventText = notify ?? `script job ${job.name} completed`;
    if (job.sessionTarget !== "main" || !notify) {
      enqueueCronSystemEvent(state, eventText, {
        agentId: job.agentId,
        contextKey: `cron:${job.id}:script-wake`,
      });
    }
    requestCronHeartbeat(state, {
      intent: result.wake === "now" ? "immediate" : "event",
      reason: `cron:${job.id}:script`,
      agentId: job.agentId,
    });
  }
  return {
    status: "ok" as const,
    ...(notify ? { summary: notify } : {}),
    delivered: result.delivered,
    deliveryAttempted: result.deliveryAttempted,
    deliveryError: result.deliveryError,
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
