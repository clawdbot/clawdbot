import type { CronJob } from "../cron/types.js";
import { markOpenClawExecEnv } from "../infra/openclaw-exec-env.js";
import type { ManagedRun, ProcessSupervisor } from "../process/supervisor/index.js";
import { resolveExitWatchShell } from "./cron-exit-watch-shell.js";

/**
 * Safety bound for a watched command, so a hung/never-exiting command cannot
 * keep a gateway-owned process alive forever. Generous (24h) because on-exit
 * legitimately watches long-running commands (builds, deploys); on timeout the
 * watch ends and the job fires like any other exit.
 */
const ON_EXIT_WATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const ON_EXIT_WATCH_RETRY_BACKOFF_MS = [1_000, 5_000, 30_000, 5 * 60_000] as const;

type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

type OnExitCronJob = CronJob & { schedule: Extract<CronJob["schedule"], { kind: "on-exit" }> };

export type CronExitResult = {
  exitCode: number | null;
  reason: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
};

type CronExitWatchers = {
  reconcile: (jobs: CronJob[]) => void;
  cancel: (jobId: string) => void;
  cancelAll: () => void;
  activeJobIds: () => string[];
};

const SCOPE_PREFIX = "cron-exit";

function scopeKey(jobId: string): string {
  return `${SCOPE_PREFIX}:${jobId}`;
}

function isWatchableExitJob(job: CronJob): job is OnExitCronJob {
  return job.enabled && job.schedule.kind === "on-exit";
}

export function createCronExitWatchers(params: {
  getProcessSupervisor: () => ProcessSupervisor;
  persistCompletion: (job: OnExitCronJob) => Promise<(() => void) | void>;
  fireOnExit: (job: CronJob, exit: CronExitResult) => void | Promise<void>;
  updateWatcherState?: (
    job: OnExitCronJob,
    patch: Pick<CronJob["state"], "lastError" | "consecutiveErrors">,
  ) => Promise<CronJob | void>;
  logger: Logger;
  shell?: { command: string; argsFor: (command: string) => string[] };
  retryBackoffMs?: readonly number[];
}): CronExitWatchers {
  const shell = params.shell ?? resolveExitWatchShell();
  const retryBackoffMs =
    params.retryBackoffMs && params.retryBackoffMs.length > 0
      ? params.retryBackoffMs
      : ON_EXIT_WATCH_RETRY_BACKOFF_MS;
  // jobId -> watcher state. `armToken` identifies the current arm so an async
  // spawn/wait that loses ownership (the job was cancelled or re-armed for a
  // changed command) becomes a no-op. The slot is reserved synchronously in
  // arm() BEFORE the spawn awaits, so a concurrent cancel can act on an
  // in-flight spawn. `fired` marks one-shot completion.
  type WatcherSlot = {
    armToken: object;
    job: OnExitCronJob;
    run: ManagedRun | undefined;
    fired: boolean;
    terminalPersisting: boolean;
    cancelled: boolean;
    lifecycleSettled: boolean;
    command: string;
    cwd: string | undefined;
    consecutiveFailures: number;
    retryTimer: NodeJS.Timeout | undefined;
  };
  const active = new Map<string, WatcherSlot>();
  // A cancelled child can keep running until the supervisor observes exit.
  // Retain those slots separately so replacement arms can own the job id while
  // suspension still sees every predecessor that is settling.
  const settlingCancelledSlots = new Set<WatcherSlot>();

  const cancel = (jobId: string) => {
    const slot = active.get(jobId);
    if (!slot) {
      return;
    }
    slot.cancelled = true;
    if (slot.retryTimer) {
      clearTimeout(slot.retryTimer);
      slot.retryTimer = undefined;
    }
    if (!slot.lifecycleSettled) {
      settlingCancelledSlots.add(slot);
    }
    // Terminal persistence is user-visible state. Keep the slot as a suspend
    // blocker until that write settles even when hot reload cancels the watcher.
    if (!slot.terminalPersisting) {
      active.delete(jobId);
    }
    // Cancel an already-spawned child; an in-flight spawn (run undefined) is
    // killed by the arm() ownership check once it resolves.
    slot.run?.cancel("manual-cancel");
    try {
      params.getProcessSupervisor().cancelScope(scopeKey(jobId), "manual-cancel");
    } catch (err) {
      params.logger.warn({ err: String(err), jobId }, "cron-exit: cancel watcher failed");
    }
  };

  const arm = (job: OnExitCronJob, consecutiveFailures = 0) => {
    const command = job.schedule.command;
    const cwd = job.schedule.cwd;
    const armToken: object = {};
    // Reserve the slot synchronously so a concurrent cancel/replace can observe
    // and act on this arm before the child is spawned.
    const slot: WatcherSlot = {
      armToken,
      job,
      run: undefined,
      fired: false,
      terminalPersisting: false,
      cancelled: false,
      lifecycleSettled: false,
      command,
      cwd,
      consecutiveFailures,
      retryTimer: undefined,
    };
    active.set(job.id, slot);
    const owns = () => active.get(job.id) === slot && slot.armToken === armToken;
    const persistWatcherState = async (
      patch: Pick<CronJob["state"], "lastError" | "consecutiveErrors">,
    ) => {
      if (!params.updateWatcherState) {
        return;
      }
      try {
        const updated = await params.updateWatcherState(slot.job, patch);
        if (owns() && updated && isWatchableExitJob(updated)) {
          slot.job = updated;
        }
      } catch (err) {
        params.logger.warn(
          { err: String(err), jobId: slot.job.id },
          "cron-exit: failed to persist watcher state",
        );
      }
    };
    const scheduleRetry = async (error: unknown, phase: "spawn" | "wait") => {
      if (!owns() || slot.cancelled) {
        return;
      }
      slot.consecutiveFailures += 1;
      const errorText = `${phase} failed: ${String(error)}`;
      await persistWatcherState({
        lastError: `cron on-exit watcher ${errorText}`,
        consecutiveErrors: slot.consecutiveFailures,
      });
      if (!owns() || slot.cancelled) {
        return;
      }
      const delayMs =
        retryBackoffMs[Math.min(slot.consecutiveFailures - 1, retryBackoffMs.length - 1)]!;
      slot.retryTimer = setTimeout(() => {
        slot.retryTimer = undefined;
        if (!owns() || slot.cancelled) {
          return;
        }
        active.delete(slot.job.id);
        arm(slot.job, slot.consecutiveFailures);
      }, delayMs);
      slot.retryTimer.unref?.();
      params.logger.warn(
        { err: String(error), jobId: slot.job.id, retryInMs: delayMs },
        `cron-exit: watcher ${phase} failed; retry scheduled`,
      );
    };
    void (async () => {
      let run: ManagedRun;
      try {
        run = await params.getProcessSupervisor().spawn({
          sessionId: `cron-exit:${job.id}`,
          backendId: "cron-exit-watch",
          scopeKey: scopeKey(job.id),
          replaceExistingScope: true,
          mode: "child",
          argv: [shell.command, ...shell.argsFor(command)],
          ...(cwd ? { cwd } : {}),
          // Mark the child as an OpenClaw-launched subprocess (loop protection /
          // detection) and bound its lifetime — consistent with how cron
          // command-payload jobs run via runCommandWithTimeout.
          env: markOpenClawExecEnv({ ...process.env }),
          timeoutMs: ON_EXIT_WATCH_TIMEOUT_MS,
          captureOutput: true,
        });
      } catch (err) {
        // Keep the slot reserved as the retry placeholder; scheduleRetry re-arms
        // with backoff so a transient supervisor failure cannot silently drop
        // the watch (the job would otherwise never fire with no recorded cause).
        await scheduleRetry(err, "spawn");
        return;
      }
      if (!owns()) {
        // Cancelled or re-armed (changed command/cwd) while the spawn was in
        // flight — kill this now-orphaned child instead of leaking it. Wait for
        // supervisor settlement so suspension cannot snapshot a live child.
        run.cancel("manual-cancel");
        try {
          await run.wait();
        } catch {
          // The watcher was already cancelled; settlement, not outcome, matters.
        }
        return;
      }
      slot.run = run;
      params.logger.info({ jobId: job.id, runId: run.runId, command }, "cron-exit: watcher armed");
      let exit: Awaited<ReturnType<ManagedRun["wait"]>>;
      try {
        exit = await run.wait();
      } catch (err) {
        // run.wait() rejected (e.g. supervisor error) rather than resolving with
        // an exit. FAIL CLOSED: do not fire on an unknown outcome; scheduleRetry
        // re-arms the watch with backoff instead of dropping it silently.
        await scheduleRetry(err, "wait");
        return;
      }
      if (!owns()) {
        return;
      }
      params.logger.info(
        { jobId: job.id, exitCode: exit.exitCode, reason: exit.reason },
        "cron-exit: watched command exited; firing job",
      );
      slot.terminalPersisting = true;
      // Persist the terminal one-shot state BEFORE firing. FAIL CLOSED: if the
      // store write fails we do NOT wake — waking without a persisted terminal
      // state would let a gateway restart re-arm and re-run the command.
      let releaseCompletion: (() => void) | void;
      try {
        releaseCompletion = await params.persistCompletion(slot.job);
      } catch (err) {
        if (owns()) {
          active.delete(job.id);
        }
        params.logger.warn(
          { err: String(err), jobId: job.id },
          "cron-exit: persistCompletion failed; NOT firing (fail closed to avoid replay)",
        );
        return;
      }
      slot.terminalPersisting = false;
      try {
        if (!owns() || slot.cancelled) {
          if (active.get(job.id) === slot) {
            active.delete(job.id);
          }
          return;
        }
        slot.fired = true;
        try {
          await params.fireOnExit(slot.job, {
            exitCode: exit.exitCode,
            reason: exit.reason,
            stdout: exit.stdout,
            stderr: exit.stderr,
            timedOut: exit.timedOut,
            noOutputTimedOut: exit.noOutputTimedOut,
          });
        } catch (err) {
          params.logger.warn(
            { err: String(err), jobId: job.id },
            "cron-exit: fireOnExit after exit failed",
          );
        }
      } finally {
        releaseCompletion?.();
      }
    })().finally(() => {
      slot.lifecycleSettled = true;
      settlingCancelledSlots.delete(slot);
      if (slot.cancelled && active.get(job.id) === slot) {
        active.delete(job.id);
      }
    });
  };

  const reconcile = (jobs: CronJob[]) => {
    const want = new Map(jobs.filter(isWatchableExitJob).map((j) => [j.id, j] as const));
    // Cancel watchers whose job is gone or no longer watchable.
    for (const jobId of Array.from(active.keys())) {
      if (!want.has(jobId)) {
        cancel(jobId);
      }
    }
    for (const [jobId, job] of want) {
      const slot = active.get(jobId);
      if (slot) {
        // Already tracked. A fired one-shot stays put (re-watch = re-add). If
        // the watched command/cwd changed, cancel the stale watcher and re-arm.
        if (slot.fired) {
          continue;
        }
        const { command, cwd } = job.schedule;
        if (slot.command === command && slot.cwd === cwd) {
          slot.job = job;
          continue;
        }
        cancel(jobId);
      }
      arm(job);
    }
  };

  const cancelAll = () => {
    for (const jobId of Array.from(active.keys())) {
      cancel(jobId);
    }
  };

  return {
    reconcile,
    cancel,
    cancelAll,
    activeJobIds: () =>
      Array.from(
        new Set([
          ...Array.from(active.entries())
            .filter(([, slot]) => !slot.fired)
            .map(([jobId]) => jobId),
          ...Array.from(settlingCancelledSlots, (slot) => slot.job.id),
        ]),
      ),
  };
}
