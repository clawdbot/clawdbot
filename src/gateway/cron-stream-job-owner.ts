import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { errorBackoffMs } from "../cron/service/jobs.js";
import { cronStreamScheduleKey } from "../cron/stream-schedule.js";
import type { CronJob, CronJobState } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { markOpenClawExecEnv } from "../infra/openclaw-exec-env.js";
import type { ManagedRun, ProcessSupervisor } from "../process/supervisor/index.js";
import type { RunExit } from "../process/supervisor/types.js";
import {
  CronStreamOutput,
  type CronStreamFireDisposition,
  type CronStreamJob,
  type CronStreamLogger,
  type CronStreamLossReason,
  type CronStreamOwnerState,
} from "./cron-stream-output.js";

const SCOPE_PREFIX = "cron-stream";
const STABLE_RUN_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const COUNTER_MAX = 2_147_483_647;
const STOP_SETTLE_TIMEOUT_MS = 10_000;
const OWNER_STOP_TIMEOUT_MS = STOP_SETTLE_TIMEOUT_MS * 2;

type DisableStop = "disabled" | "trust-disabled" | "cron-disabled";
type LifecycleStop =
  | "removed"
  | "shutdown"
  | "schedule-update"
  | "restart-exhausted"
  | "trigger-disabled";

export type CronStreamStopReason = DisableStop | LifecycleStop;

export type CronStreamOwnerParams = {
  getProcessSupervisor: () => ProcessSupervisor;
  minIntervalMs: number;
  retryBackoffMs?: number[];
  updateState: (
    jobId: string,
    patch: Partial<CronJobState>,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ) => Promise<boolean | void>;
  retireSource: (
    jobId: string,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ) => Promise<string | undefined>;
  updateCounters?: (
    jobId: string,
    counters: Pick<CronJobState, "streamDroppedBatches" | "streamCoalescedBatches">,
  ) => Promise<void>;
  recordFailure: (
    jobId: string,
    error: string,
    patch: Partial<CronJobState>,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ) => Promise<void>;
  fireBatch: (
    job: CronJob,
    batch: string,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ) => Promise<CronStreamFireDisposition>;
  logger: CronStreamLogger;
  nowMs: () => number;
};

export function isCronStreamJob(job: CronJob): job is CronStreamJob {
  return job.schedule.kind === "stream";
}

function sourceIdentityFor(job: CronStreamJob): string {
  const identity = job.state.streamSourceIdentity?.trim();
  if (!identity) {
    throw new Error(`stream job ${job.id} is missing its source identity`);
  }
  return identity;
}

const scopeKey = (jobId: string): string => `${SCOPE_PREFIX}:${jobId}`;

function stopRequiresSourceRetirement(reason: CronStreamStopReason): boolean {
  return (
    reason === "removed" ||
    reason === "shutdown" ||
    reason === "trust-disabled" ||
    reason === "cron-disabled"
  );
}

function clearTimer(timer: NodeJS.Timeout | undefined): void {
  if (timer) {
    clearTimeout(timer);
  }
}

function boundedCounter(value: number | undefined, increment = 0): number {
  return Math.min(COUNTER_MAX, Math.max(0, Math.floor(value ?? 0)) + increment);
}

async function stopManagedRun(run: ManagedRun): Promise<void> {
  // Detach first so pipe drains cannot enqueue after the owner starts stopping.
  run.detachOutput?.();
  run.cancel("manual-cancel");
  let timeout: NodeJS.Timeout | undefined;
  try {
    const exited = await Promise.race([
      run.wait().then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), STOP_SETTLE_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
    if (!exited) {
      throw new Error(`stream source did not exit within ${STOP_SETTLE_TIMEOUT_MS}ms`);
    }
  } finally {
    clearTimer(timeout);
  }
}

/** Owns one stream job's serialized process lifecycle and durable counters. */
export class CronStreamJobOwner {
  private state: CronStreamOwnerState = "idle";
  // Process generation changes across child restarts; logical identity does not.
  private generation = 0;
  private desiredRunning = false;
  private retired = false;
  private removalRequested = false;
  // Preserve terminal restart exhaustion across a normal shutdown state write.
  private restartExhausted = false;
  private requestEpoch = 0;
  private opTail: Promise<void> = Promise.resolve();
  private job: CronStreamJob;
  private scheduleKey: string;
  private sourceIdentity: string;
  private run?: ManagedRun;
  private restartTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private consecutiveFailures: number;
  private droppedBatches: number;
  private coalescedBatches: number;
  private readonly output: CronStreamOutput;

  constructor(
    job: CronStreamJob,
    private readonly params: CronStreamOwnerParams,
  ) {
    this.job = job;
    this.scheduleKey = cronStreamScheduleKey(job.schedule);
    this.sourceIdentity = sourceIdentityFor(job);
    this.consecutiveFailures = job.state.streamConsecutiveFailures ?? 0;
    this.droppedBatches = job.state.streamDroppedBatches ?? 0;
    this.coalescedBatches = job.state.streamCoalescedBatches ?? 0;
    this.restartExhausted = job.state.streamRestartExhausted === true;
    this.output = new CronStreamOutput({
      job,
      scheduleKey: this.scheduleKey,
      sourceIdentity: this.sourceIdentity,
      minIntervalMs: params.minIntervalMs,
      settleTimeoutMs: STOP_SETTLE_TIMEOUT_MS,
      nowMs: params.nowMs,
      fireBatch: params.fireBatch,
      recordLoss: async (reason) => await this.recordLoss(reason),
      enqueue: (label, operation) => this.enqueue(label, operation),
      requestTriggerDisabledStop: () => {
        void this.stop("trigger-disabled").catch((error: unknown) => {
          this.params.logger.warn(
            { jobId: this.job.id, err: formatErrorMessage(error) },
            "cron-stream: trigger-disabled stop failed",
          );
        });
      },
      getGeneration: () => this.generation,
      getState: () => this.state,
      isDesiredRunning: () => this.desiredRunning,
      isRetired: () => this.retired,
      logger: params.logger,
    });
  }

  get id(): string {
    return this.job.id;
  }

  acceptsStart(): boolean {
    return !this.removalRequested;
  }

  snapshot() {
    return {
      state: this.state,
      generation: this.generation,
      sourceIdentity: this.sourceIdentity,
      processAlive: this.run !== undefined,
      restartTimerPending: this.restartTimer !== undefined,
      ...this.output.snapshot(),
      droppedBatches: this.droppedBatches,
      coalescedBatches: this.coalescedBatches,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  start(job: CronStreamJob): Promise<void> {
    if (this.removalRequested) {
      return Promise.resolve();
    }
    const requestEpoch = ++this.requestEpoch;
    return this.enqueue("start", async () => {
      if (this.removalRequested || requestEpoch !== this.requestEpoch) {
        return;
      }
      const nextScheduleKey = cronStreamScheduleKey(job.schedule);
      const nextSourceIdentity = sourceIdentityFor(job);
      if (!this.ownsSource(nextScheduleKey, nextSourceIdentity)) {
        await this.stopOperation("schedule-update");
      }
      // A newer stop can arrive while replacement waits for the old child.
      if (this.removalRequested || requestEpoch !== this.requestEpoch) {
        return;
      }
      if (this.run && this.state !== "running") {
        await this.stopOperation("schedule-update");
        if (this.removalRequested || requestEpoch !== this.requestEpoch) {
          return;
        }
      }
      this.retired = false;
      this.desiredRunning = true;
      this.adoptJob(job, nextScheduleKey, nextSourceIdentity);
      this.droppedBatches = Math.max(
        this.droppedBatches,
        boundedCounter(job.state.streamDroppedBatches),
      );
      this.coalescedBatches = Math.max(
        this.coalescedBatches,
        boundedCounter(job.state.streamCoalescedBatches),
      );
      if (job.state.streamRestartExhausted) {
        this.desiredRunning = false;
        this.state = "stopped";
        return;
      }
      if (this.state === "running" || this.state === "starting" || this.state === "backoff") {
        return;
      }
      this.consecutiveFailures = job.state.streamConsecutiveFailures ?? 0;
      await this.spawnSource();
    });
  }

  stop(reason: CronStreamStopReason, job?: CronStreamJob): Promise<void> {
    // Fence output and queued starts synchronously, before the stop operation runs.
    ++this.requestEpoch;
    this.desiredRunning = false;
    if (reason === "removed") {
      this.removalRequested = true;
    }
    this.params.getProcessSupervisor().cancelScope(scopeKey(this.job.id), "manual-cancel");
    const queuedStop = this.enqueue("stop", async () => await this.stopOperation(reason, job));
    return this.awaitBoundedStop(queuedStop);
  }

  processExited(exit: RunExit, generation: number): Promise<void> {
    return this.enqueue("process-exited", async () => {
      // desiredRunning is the synchronous stop fence: an exit that queued
      // ahead of a requested stop belongs to that stop, not to the failure
      // counters — counting it could fabricate restart exhaustion for a
      // deliberate disable/removal/shutdown.
      if (generation !== this.generation || this.state !== "running" || !this.desiredRunning) {
        return;
      }
      this.run?.detachOutput?.();
      this.run = undefined;
      clearTimer(this.stableTimer);
      this.stableTimer = undefined;
      // Drain accepted tail output before this child loses callback ownership.
      await this.output.drainBufferedOutput(generation);
      await this.output.flushSourceOutput(generation);
      // Both drains can yield while stop() closes desiredRunning synchronously;
      // let its already-queued teardown own the exit instead of counting failure.
      if (generation !== this.generation || this.state !== "running" || !this.desiredRunning) {
        return;
      }
      const backoffGeneration = ++this.generation;

      const stable = exit.durationMs >= STABLE_RUN_MS;
      this.consecutiveFailures = stable ? 0 : boundedCounter(this.consecutiveFailures, 1);
      const message = `stream source exited (${exit.reason}, code ${exit.exitCode ?? "none"})`;
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await this.output.dropPendingForTerminalStop();
        this.desiredRunning = false;
        this.state = "stopped";
        this.restartExhausted = true;
        await this.persistFailure(message, {
          streamStatus: "error",
          streamError: message,
          streamConsecutiveFailures: this.consecutiveFailures,
          streamRestartExhausted: true,
          streamLastExitAtMs: this.params.nowMs(),
        });
        return;
      }

      this.state = "backoff";
      await this.persistState({
        streamStatus: "restarting",
        streamError: message,
        streamConsecutiveFailures: this.consecutiveFailures,
        streamLastExitAtMs: this.params.nowMs(),
      });
      void this.scheduleRestart(
        stable ? 0 : errorBackoffMs(this.consecutiveFailures, this.params.retryBackoffMs),
        backoffGeneration,
      );
    });
  }

  private ownsSource(scheduleKey: string, sourceIdentity: string): boolean {
    return scheduleKey === this.scheduleKey && sourceIdentity === this.sourceIdentity;
  }

  private adoptJob(job: CronStreamJob, scheduleKey: string, sourceIdentity: string): void {
    this.job = job;
    this.scheduleKey = scheduleKey;
    this.sourceIdentity = sourceIdentity;
    this.output.updateSource(job, scheduleKey, sourceIdentity);
  }

  private enqueue(label: string, operation: () => Promise<void>): Promise<void> {
    const result = this.opTail.then(operation, operation);
    this.opTail = result.catch((error: unknown) => {
      this.params.logger.warn(
        { jobId: this.job.id, operation: label, err: formatErrorMessage(error) },
        "cron-stream: owner operation failed",
      );
    });
    return result;
  }

  private async awaitBoundedStop(stop: Promise<void>): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        stop,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            this.params.getProcessSupervisor().cancelScope(scopeKey(this.job.id), "manual-cancel");
            reject(new Error(`stream owner stop did not settle within ${OWNER_STOP_TIMEOUT_MS}ms`));
          }, OWNER_STOP_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } finally {
      clearTimer(timeout);
    }
  }

  private async spawnSource(): Promise<void> {
    if (!this.desiredRunning || this.retired) {
      this.state = "stopped";
      return;
    }
    this.state = "starting";
    this.restartExhausted = false;
    const generation = ++this.generation;
    this.output.resetSourceBuffers();
    const ownsPersistedJob = await this.persistState({
      streamStatus: this.consecutiveFailures > 0 ? "restarting" : "starting",
      streamError: undefined,
      streamConsecutiveFailures: this.consecutiveFailures,
      streamRestartExhausted: undefined,
    });
    if (
      !ownsPersistedJob ||
      generation !== this.generation ||
      !this.desiredRunning ||
      this.retired ||
      this.state !== "starting"
    ) {
      this.state = "stopped";
      return;
    }

    let run: ManagedRun;
    try {
      run = await this.params.getProcessSupervisor().spawn({
        sessionId: `cron-stream:${this.job.id}`,
        backendId: "cron-stream-source",
        scopeKey: scopeKey(this.job.id),
        replaceExistingScope: true,
        mode: "child",
        argv: this.job.schedule.command,
        ...(this.job.schedule.cwd ? { cwd: this.job.schedule.cwd } : {}),
        env: markOpenClawExecEnv({ ...process.env }),
        stdinMode: "pipe-closed",
        captureOutput: false,
        onStdout: (chunk) => this.output.enqueueChunk("stdout", chunk, generation),
        onStderr: (chunk) => this.output.enqueueChunk("stderr", chunk, generation),
      });
    } catch (error) {
      if (generation !== this.generation || !this.desiredRunning || this.retired) {
        this.state = "stopped";
        return;
      }
      this.consecutiveFailures = boundedCounter(this.consecutiveFailures, 1);
      const message = `stream source failed to start: ${String(error)}`;
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await this.output.dropPendingForTerminalStop();
        this.desiredRunning = false;
        this.state = "stopped";
        this.restartExhausted = true;
        await this.persistFailure(message, {
          streamStatus: "error",
          streamError: message,
          streamConsecutiveFailures: this.consecutiveFailures,
          streamRestartExhausted: true,
        });
        return;
      }
      this.state = "backoff";
      await this.persistState({
        streamStatus: "restarting",
        streamError: message,
        streamConsecutiveFailures: this.consecutiveFailures,
      });
      void this.scheduleRestart(
        errorBackoffMs(this.consecutiveFailures, this.params.retryBackoffMs),
        generation,
      );
      return;
    }

    if (generation !== this.generation || !this.desiredRunning || this.retired) {
      // Retain a late spawn until exit is confirmed so a later stop can retry it.
      this.run = run;
      await stopManagedRun(run);
      if (this.run === run) {
        this.run = undefined;
      }
      this.state = "stopped";
      return;
    }
    this.run = run;
    this.state = "running";
    this.stableTimer = setTimeout(() => {
      void this.markStable(generation);
    }, STABLE_RUN_MS);
    this.stableTimer.unref?.();
    const ownsRunningJob = await this.persistState({
      streamStatus: "running",
      streamError: undefined,
      streamLastStartedAtMs: run.startedAtMs,
    });
    if (
      !ownsRunningJob ||
      generation !== this.generation ||
      !this.desiredRunning ||
      this.retired ||
      this.state !== "running"
    ) {
      await this.stopOperation("schedule-update");
      return;
    }
    this.params.logger.info(
      { jobId: this.job.id, runId: run.runId, generation },
      "cron-stream: source running",
    );
    this.output.schedulePendingIfNeeded(generation);
    void run.wait().then(
      (exit) => this.processExited(exit, generation),
      (error: unknown) => {
        this.params.logger.warn(
          { jobId: this.job.id, err: formatErrorMessage(error) },
          "cron-stream: supervised wait failed",
        );
        return this.processExited(
          {
            reason: "spawn-error",
            exitCode: null,
            exitSignal: null,
            durationMs: Math.max(0, this.params.nowMs() - run.startedAtMs),
            stdout: "",
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          },
          generation,
        );
      },
    );
  }

  private async stopOperation(reason: CronStreamStopReason, job?: CronStreamJob): Promise<void> {
    this.desiredRunning = false;
    if (reason === "removed") {
      this.retired = true;
    }
    if (job) {
      this.adoptJob(job, cronStreamScheduleKey(job.schedule), sourceIdentityFor(job));
    }
    this.state = "stopping";
    ++this.generation;

    let retirementError: unknown;
    if (stopRequiresSourceRetirement(reason)) {
      try {
        const retiredIdentity = await this.params.retireSource(
          this.job.id,
          this.scheduleKey,
          this.sourceIdentity,
        );
        if (retiredIdentity !== undefined) {
          const retiredJob = {
            ...this.job,
            state: { ...this.job.state, streamSourceIdentity: retiredIdentity },
          };
          this.adoptJob(retiredJob, this.scheduleKey, retiredIdentity);
        }
      } catch (error) {
        // Teardown continues, but the caller still sees the failed durable fence.
        retirementError = error;
      }
    }
    clearTimer(this.restartTimer);
    this.restartTimer = undefined;
    clearTimer(this.stableTimer);
    this.stableTimer = undefined;
    const outputStopState = this.output.beginStop();

    const run = this.run;
    let stopError: unknown;
    if (run) {
      try {
        await stopManagedRun(run);
        if (this.run === run) {
          this.run = undefined;
        }
      } catch (error) {
        stopError = error;
      }
    } else {
      this.params.getProcessSupervisor().cancelScope(scopeKey(this.job.id), "manual-cancel");
    }
    await this.output.finishStop(outputStopState);

    if (stopError !== undefined) {
      // Keep ownership while the child is still retryable; do not claim stopped.
      this.state = "stopping";
      this.restartExhausted = true;
      const message = `stream source failed to stop: ${formatErrorMessage(stopError)}`;
      await this.persistFailure(message, {
        streamStatus: "error",
        streamError: message,
        streamRestartExhausted: true,
      });
      if (retirementError !== undefined) {
        throw new AggregateError(
          [retirementError, stopError],
          "stream source retirement and stop both failed",
        );
      }
      throw toErrorObject(stopError, "stream source failed to stop");
    }
    this.state = "stopped";
    await this.persistState(
      reason === "trust-disabled"
        ? {
            streamStatus: "disabled",
            streamError: "stream sources require cron.triggers.enabled=true",
          }
        : reason === "cron-disabled"
          ? { streamStatus: "disabled", streamError: "cron is disabled" }
          : reason === "restart-exhausted" || (reason === "shutdown" && this.restartExhausted)
            ? {}
            : { streamStatus: "stopped", streamError: undefined },
    );
    if (retirementError !== undefined) {
      throw toErrorObject(retirementError, "stream source retirement failed");
    }
  }

  private scheduleRestart(delayMs: number, generation: number): Promise<void> {
    return this.enqueue("schedule-restart", async () => {
      if (
        !this.desiredRunning ||
        this.retired ||
        this.state !== "backoff" ||
        generation !== this.generation
      ) {
        return;
      }
      clearTimer(this.restartTimer);
      if (delayMs <= 0) {
        void this.restartAfterBackoff(generation);
        return;
      }
      this.restartTimer = setTimeout(() => {
        void this.restartAfterBackoff(generation);
      }, delayMs);
      this.restartTimer.unref?.();
    });
  }

  private markStable(generation: number): Promise<void> {
    return this.enqueue("mark-stable", async () => {
      if (generation !== this.generation || this.state !== "running") {
        return;
      }
      this.stableTimer = undefined;
      this.consecutiveFailures = 0;
      const ownsPersistedJob = await this.persistState({
        streamStatus: "running",
        streamError: undefined,
        streamConsecutiveFailures: 0,
      });
      if (!ownsPersistedJob) {
        await this.stopOperation("schedule-update");
      }
    });
  }

  private restartAfterBackoff(generation: number): Promise<void> {
    return this.enqueue("restart", async () => {
      if (
        generation !== this.generation ||
        this.state !== "backoff" ||
        !this.desiredRunning ||
        this.retired
      ) {
        return;
      }
      clearTimer(this.restartTimer);
      this.restartTimer = undefined;
      await this.spawnSource();
    });
  }

  private async recordLoss(reason: CronStreamLossReason): Promise<void> {
    if (reason === "coalesced") {
      this.coalescedBatches = boundedCounter(this.coalescedBatches, 1);
    } else {
      this.droppedBatches = boundedCounter(this.droppedBatches, 1);
    }
    try {
      const counters = {
        streamDroppedBatches: this.droppedBatches,
        streamCoalescedBatches: this.coalescedBatches,
      };
      if (this.params.updateCounters) {
        await this.params.updateCounters(this.job.id, counters);
      } else {
        await this.params.updateState(this.job.id, counters, this.scheduleKey, this.sourceIdentity);
      }
    } catch (error) {
      this.params.logger.warn(
        { jobId: this.job.id, err: String(error) },
        "cron-stream: failed to persist loss counters",
      );
    }
  }

  private async persistState(patch: Partial<CronJobState>): Promise<boolean> {
    try {
      const result = await this.params.updateState(
        this.job.id,
        patch,
        this.scheduleKey,
        this.sourceIdentity,
      );
      if (result === false) {
        this.desiredRunning = false;
        return false;
      }
      return true;
    } catch (error) {
      this.params.logger.warn(
        { jobId: this.job.id, err: String(error) },
        "cron-stream: failed to persist source state",
      );
      // Only an explicit false retires ownership; diagnostics are non-authoritative.
      return true;
    }
  }

  private async persistFailure(error: string, patch: Partial<CronJobState>): Promise<void> {
    try {
      await this.params.recordFailure(
        this.job.id,
        error,
        patch,
        this.scheduleKey,
        this.sourceIdentity,
      );
    } catch (failureError) {
      this.params.logger.warn(
        { jobId: this.job.id, err: String(failureError) },
        "cron-stream: failed to persist terminal source failure",
      );
    }
  }
}

export type CronStreamOwnerSnapshot = ReturnType<CronStreamJobOwner["snapshot"]>;
