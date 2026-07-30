import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../cron/types.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { ManagedRun, ProcessSupervisor, RunExit } from "../process/supervisor/types.js";
import { resolveStreamStopReason } from "./cron-stream-watchers.js";
import {
  createWatchers,
  exitResult,
  fakeSupervisor,
  job,
  settle,
} from "./cron-stream-watchers.test-helpers.js";

describe("cron stream watchers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps lifecycle ownership when a diagnostic state write fails", async () => {
    const fake = fakeSupervisor();
    const watchers = createWatchers({
      getProcessSupervisor: () => fake.supervisor,
      updateState: vi.fn(async () => {
        throw new Error("state write failed");
      }),
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await watchers.reconcile([job()], true);
    await settle();

    expect(fake.spawn).toHaveBeenCalledOnce();
    expect(watchers.inspect("stream-job")?.state).toBe("running");
    await watchers.stopAll("shutdown");
  });

  it("does not spawn after the cron store explicitly rejects schedule ownership", async () => {
    const fake = fakeSupervisor();
    const watchers = createWatchers({
      getProcessSupervisor: () => fake.supervisor,
      updateState: vi.fn(async () => false),
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await watchers.start(job());

    expect(fake.spawn).not.toHaveBeenCalled();
    expect(watchers.inspect("stream-job")?.state).toBe("stopped");
  });

  it("detaches output and awaits exit on disable, removal, and shutdown", async () => {
    const fake = fakeSupervisor();
    const watchers = createWatchers({
      getProcessSupervisor: () => fake.supervisor,
      minIntervalMs: 1,
      updateState: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile([job()], true);
    await settle();
    await watchers.reconcile([job({ enabled: false })], true);
    expect(fake.runs[0]?.detachOutput).toHaveBeenCalled();
    expect(fake.runs[0]?.cancel).toHaveBeenCalled();

    await watchers.reconcile([job({ id: "remove-me" })], true);
    await settle();
    await watchers.reconcile([], true);
    expect(watchers.activeJobIds()).toEqual([]);

    await watchers.reconcile([job({ id: "shutdown-me" })], true);
    await settle();
    await watchers.stopAll("shutdown");
    expect(watchers.activeJobIds()).toEqual([]);
  });

  it("does not spawn and records a clear status when trigger trust is disabled", async () => {
    const fake = fakeSupervisor();
    const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
    const watchers = createWatchers({
      getProcessSupervisor: () => fake.supervisor,
      updateState,
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await watchers.reconcile([job()], false);

    expect(fake.spawn).not.toHaveBeenCalled();
    expect(updateState).toHaveBeenCalledWith(
      "stream-job",
      expect.objectContaining({
        streamStatus: "disabled",
        streamError: "stream sources require cron.triggers.enabled=true",
      }),
      expect.any(String),
      expect.any(String),
    );
  });

  it("reports cron-disabled remediation when only cron itself is off", async () => {
    const fake = fakeSupervisor();
    const updateState = vi.fn(async () => {});
    const watchers = createWatchers({
      getProcessSupervisor: () => fake.supervisor,
      updateState,
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    // cron globally disabled but triggers enabled: the remediation must name
    // cron, not point the operator at an already-enabled trigger flag.
    await watchers.reconcile([job()], false, true);

    expect(fake.spawn).not.toHaveBeenCalled();
    expect(updateState).toHaveBeenCalledWith(
      "stream-job",
      expect.objectContaining({ streamStatus: "disabled", streamError: "cron is disabled" }),
      expect.any(String),
      expect.any(String),
    );
  });

  it("creates a quiescent owner to persist disabled status for an inactive stream job", async () => {
    const fake = fakeSupervisor();
    const updateState = vi.fn(async () => {});
    const watchers = createWatchers({
      getProcessSupervisor: () => fake.supervisor,
      updateState,
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await watchers.stop("stream-job", "trust-disabled", job());

    expect(fake.spawn).not.toHaveBeenCalled();
    expect(updateState).toHaveBeenCalledWith(
      "stream-job",
      expect.objectContaining({
        streamStatus: "disabled",
        streamError: "stream sources require cron.triggers.enabled=true",
      }),
      expect.any(String),
      expect.any(String),
    );
  });

  it("fences every source during a disable sweep even when one stop fails", async () => {
    vi.useFakeTimers();
    const inputs: Array<{ jobId: string }> = [];
    const cancels: Record<string, ReturnType<typeof vi.fn>> = {};
    const spawn = vi.fn(async (input: { sessionId: string }) => {
      const jobId = input.sessionId.replace("cron-stream:", "");
      inputs.push({ jobId });
      const stubborn = jobId === "stubborn-job";
      let resolveWait!: (result: RunExit) => void;
      const wait = new Promise<RunExit>((resolve) => {
        resolveWait = resolve;
      });
      const cancel = vi.fn(() => {
        if (!stubborn) {
          resolveWait(exitResult({ reason: "manual-cancel" }));
        }
      });
      cancels[jobId] = cancel;
      return {
        runId: `run-${jobId}`,
        startedAtMs: Date.now(),
        cancel,
        detachOutput: vi.fn(),
        wait: () => wait,
      } satisfies ManagedRun;
    });
    const supervisor = {
      spawn,
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      getRecord: vi.fn(),
    } as unknown as ProcessSupervisor;
    const watchers = createWatchers({
      getProcessSupervisor: () => supervisor,
      minIntervalMs: 1,
      updateState: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const jobs = [job({ id: "stubborn-job" }), job({ id: "healthy-job" })];
    await watchers.reconcile(jobs, true);
    await settle();
    expect(spawn).toHaveBeenCalledTimes(2);

    // Trust disable: the stubborn child never exits, so its bounded stop
    // rejects. The sweep must contain that failure and still fence and stop
    // the healthy sibling instead of aborting the loop.
    const sweep = watchers.reconcile(jobs, false, false);
    await vi.advanceTimersByTimeAsync(60_000);
    await sweep;
    expect(cancels["healthy-job"]).toHaveBeenCalled();
    expect(watchers.inspect("healthy-job")?.state).toBe("stopped");
  });

  it("continues reconciling after a stubborn schedule replacement fails", async () => {
    vi.useFakeTimers();
    const cancels: Record<string, ReturnType<typeof vi.fn>> = {};
    const spawn = vi.fn(async (input: { sessionId: string; argv: string[] }) => {
      const jobId = input.sessionId.replace("cron-stream:", "");
      const stubborn = jobId === "stubborn-job" && input.argv[0] === "stream-source";
      let resolveWait!: (result: RunExit) => void;
      const wait = new Promise<RunExit>((resolve) => {
        resolveWait = resolve;
      });
      const cancel = vi.fn(() => {
        if (!stubborn) {
          resolveWait(exitResult({ reason: "manual-cancel" }));
        }
      });
      cancels[jobId] = cancel;
      return {
        runId: `run-${jobId}-${input.argv[0]}`,
        startedAtMs: Date.now(),
        cancel,
        detachOutput: vi.fn(),
        wait: () => wait,
      } satisfies ManagedRun;
    });
    const supervisor = {
      spawn,
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      getRecord: vi.fn(),
    } as unknown as ProcessSupervisor;
    const watchers = createWatchers({
      getProcessSupervisor: () => supervisor,
      minIntervalMs: 1,
      updateState: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile([job({ id: "stubborn-job" })], true);
    await settle();
    expect(spawn).toHaveBeenCalledTimes(1);

    // The stubborn child refuses to exit, so its schedule replacement rejects
    // after the bounded stop. The sweep must still start the sibling job.
    const replaced = job({
      id: "stubborn-job",
      schedule: { kind: "stream", command: ["replacement"], batchMs: 50 },
    });
    const sweep = watchers.reconcile([replaced, job({ id: "healthy-job" })], true);
    await vi.advanceTimersByTimeAsync(120_000);
    await sweep;
    expect(spawn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(watchers.inspect("healthy-job")?.state).toBe("running");
    // The stubborn child also fails shutdown; advance its bounded stop.
    const shutdown = watchers.stopAll("shutdown").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    await shutdown;
  });

  it("leaves an exit queued ahead of a requested stop to the stop operation", async () => {
    const fake = fakeSupervisor();
    const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
    const recordFailure = vi.fn(async () => {});
    const watchers = createWatchers({
      getProcessSupervisor: () => fake.supervisor,
      minIntervalMs: 1,
      updateState,
      recordFailure,
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.start(job());

    // The child exits and the operator stop lands before the exit callback is
    // processed: the exit belongs to the stop, not the failure counters.
    fake.exits[0]?.(exitResult({ reason: "exit", exitCode: 1 }));
    const stopping = watchers.stop("stream-job", "disabled");
    await stopping;

    expect(watchers.inspect("stream-job")).toMatchObject({
      state: "stopped",
      consecutiveFailures: 0,
      restartTimerPending: false,
    });
    expect(recordFailure).not.toHaveBeenCalled();
    expect(updateState.mock.calls.some(([, patch]) => patch.streamStatus === "restarting")).toBe(
      false,
    );
  });

  it("restarts fast exits and records terminal failure after five attempts", async () => {
    vi.useFakeTimers();
    const spawn = vi.fn(async () => {
      const result = exitResult();
      return {
        runId: `run-${spawn.mock.calls.length}`,
        startedAtMs: Date.now(),
        cancel: vi.fn(),
        detachOutput: vi.fn(),
        wait: async () => result,
      } satisfies ManagedRun;
    });
    const supervisor = {
      spawn,
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      getRecord: vi.fn(),
    } satisfies ProcessSupervisor;
    const recordFailure = vi.fn(async () => {});
    const watchers = createWatchers({
      getProcessSupervisor: () => supervisor,
      minIntervalMs: 1,
      retryBackoffMs: [1],
      updateState: vi.fn(async () => {}),
      recordFailure,
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile([job()], true);
    await vi.advanceTimersByTimeAsync(10);
    expect(spawn).toHaveBeenCalledTimes(5);
    expect(recordFailure).toHaveBeenCalledWith(
      "stream-job",
      expect.stringContaining("stream source exited"),
      expect.objectContaining({ streamRestartExhausted: true, streamConsecutiveFailures: 5 }),
      expect.any(String),
      expect.any(String),
    );
    await watchers.start(job({ state: { streamRestartExhausted: false } }));
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn.mock.calls.length).toBeGreaterThan(5);
    await watchers.stopAll("shutdown");
  });

  describe("serialized owner interleavings", () => {
    it("starts unrelated jobs without cross-job mutation fencing", async () => {
      const fake = fakeSupervisor();
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });

      await Promise.all([
        watchers.start(job({ id: "stream-a" })),
        watchers.start(job({ id: "stream-b" })),
      ]);

      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(watchers.activeJobIds()).toEqual(expect.arrayContaining(["stream-a", "stream-b"]));
      await watchers.stopAll("shutdown");
    });

    it("rechecks the stop fence after a slow starting-state write and persists stopped", async () => {
      const fake = fakeSupervisor();
      let releaseStarting!: () => void;
      const startingWrite = new Promise<void>((resolve) => {
        releaseStarting = resolve;
      });
      let markStarting!: () => void;
      const starting = new Promise<void>((resolve) => {
        markStarting = resolve;
      });
      const updateState = vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
        if (patch.streamStatus === "starting") {
          markStarting();
          await startingWrite;
        }
      });
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });

      const start = watchers.start(job());
      await starting;
      const shutdown = watchers.stopAll("shutdown");
      releaseStarting();
      await Promise.all([start, shutdown]);

      expect(fake.spawn).not.toHaveBeenCalled();
      expect(updateState.mock.calls.at(-1)?.[1]).toMatchObject({ streamStatus: "stopped" });
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        processAlive: false,
        restartTimerPending: false,
      });
    });

    it("bounds shutdown outside a stalled owner operation and pre-cancels its scope", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      let markStarting!: () => void;
      const starting = new Promise<void>((resolve) => {
        markStarting = resolve;
      });
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
          if (patch.streamStatus === "starting") {
            markStarting();
            await new Promise<never>(() => {});
          }
        }),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });

      void watchers.start(job());
      await starting;
      const shutdown = watchers.stopAll("shutdown");
      const shutdownFailure = expect(shutdown).rejects.toThrow("stream owner stop did not settle");

      expect(fake.supervisor.cancelScope).toHaveBeenCalledWith(
        "cron-stream:stream-job",
        "manual-cancel",
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await shutdownFailure;
      expect(fake.spawn).not.toHaveBeenCalled();
    });

    it("holds shutdown open until every owner stop settles before surfacing a failure", async () => {
      const fake = fakeSupervisor();
      let releaseSlowStop!: () => void;
      const slowStopWrite = new Promise<void>((resolve) => {
        releaseSlowStop = resolve;
      });
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async (jobId: string, patch: Partial<CronJob["state"]>) => {
          if (jobId === "slow-job" && patch.streamStatus === "stopped") {
            await slowStopWrite;
          }
        }),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        retireSource: vi.fn(async (jobId: string) => {
          if (jobId === "fail-job") {
            throw new Error("retirement write lost");
          }
          return undefined;
        }),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job({ id: "slow-job" }));
      await watchers.start(job({ id: "fail-job" }));

      // fail-job's stop rejects quickly (failed durable retirement) while
      // slow-job's final persist is still gated. Shutdown must stay a barrier:
      // no settlement, success or failure, until both owners tore down.
      const shutdown = watchers.stopAll("shutdown");
      let settled = false;
      shutdown.catch(() => {
        settled = true;
      });
      const shutdownFailure = expect(shutdown).rejects.toThrow("retirement write lost");
      await settle();
      expect(settled).toBe(false);
      releaseSlowStop();
      await shutdownFailure;
      expect(settled).toBe(true);
    });

    it("discards a queued replacement start superseded by shutdown", async () => {
      const fake = fakeSupervisor();
      let blockStops = false;
      let releaseStop!: () => void;
      const stopWrite = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      let markStop!: () => void;
      const stopStarted = new Promise<void>((resolve) => {
        markStop = resolve;
      });
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
          if (blockStops && patch.streamStatus === "stopped") {
            markStop();
            await stopWrite;
          }
        }),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      blockStops = true;

      const replacement = watchers.start(
        job({ schedule: { kind: "stream", command: ["replacement"], batchMs: 50 } }),
      );
      await stopStarted;
      const shutdown = watchers.stopAll("shutdown");
      releaseStop();
      await Promise.all([replacement, shutdown]);

      expect(fake.spawn).toHaveBeenCalledOnce();
      expect(watchers.activeJobIds()).toEqual([]);
    });

    it("retains a late spawn handle until a later stop confirms its exit", async () => {
      vi.useFakeTimers();
      let resolveSpawn!: (run: ManagedRun) => void;
      const spawned = new Promise<ManagedRun>((resolve) => {
        resolveSpawn = resolve;
      });
      let resolveWait!: (exit: RunExit) => void;
      const wait = new Promise<RunExit>((resolve) => {
        resolveWait = resolve;
      });
      let cancelAttempts = 0;
      const run: ManagedRun = {
        runId: "late-run",
        startedAtMs: Date.now(),
        cancel: vi.fn(() => {
          cancelAttempts += 1;
          if (cancelAttempts === 2) {
            resolveWait(exitResult({ reason: "manual-cancel" }));
          }
        }),
        detachOutput: vi.fn(),
        wait: () => wait,
      };
      const supervisor = {
        spawn: vi.fn(async () => await spawned),
        cancel: vi.fn(),
        cancelScope: vi.fn(),
        getRecord: vi.fn(),
      } satisfies ProcessSupervisor;
      const watchers = createWatchers({
        getProcessSupervisor: () => supervisor,
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });

      const starting = watchers.start(job());
      await settle();
      const stopping = watchers.stop("stream-job", "shutdown");
      resolveSpawn(run);
      const startFailure = expect(starting).rejects.toThrow("stream source did not exit");
      await vi.advanceTimersByTimeAsync(10_000);

      await startFailure;
      await stopping;
      expect(run.cancel).toHaveBeenCalledTimes(2);
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        processAlive: false,
        restartTimerPending: false,
      });
    });

    it("treats process exit during stopping as expected and never restarts", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 1,
        retryBackoffMs: [10],
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());

      await watchers.stop("stream-job", "disabled");
      await vi.advanceTimersByTimeAsync(100);

      expect(fake.spawn).toHaveBeenCalledOnce();
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        processAlive: false,
        restartTimerPending: false,
      });
    });

    it("cancels old backoff before starting an updated schedule", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 1,
        retryBackoffMs: [100],
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      fake.exits[0]?.(exitResult());
      await settle();
      await settle();
      expect(watchers.inspect("stream-job")?.state).toBe("backoff");

      await watchers.start(
        job({ schedule: { kind: "stream", command: ["replacement"], batchMs: 50 } }),
      );
      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(fake.inputs[1]).toMatchObject({ argv: ["replacement"] });
      await vi.advanceTimersByTimeAsync(200);
      expect(fake.spawn).toHaveBeenCalledTimes(2);
      await watchers.stopAll("shutdown");
    });

    it("replaces same-schedule owners when logical source identity changes", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const fake = fakeSupervisor();
      const fireBatch = vi.fn(async () => "fired" as const);
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 100,
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(
        job({ state: { lastRunAtMs: 1_000, streamSourceIdentity: "source-a" } }),
      );
      fake.inputs[0]?.onStdout?.("old pending\n");
      await settle();
      await vi.advanceTimersByTimeAsync(50);
      await settle();

      await watchers.start(job({ state: { streamSourceIdentity: "source-b" } }));
      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(watchers.inspect("stream-job")).toMatchObject({
        sourceIdentity: "source-b",
        droppedBatches: 1,
      });
      expect(fireBatch).not.toHaveBeenCalled();

      fake.inputs[1]?.onStdout?.("fresh\n");
      await settle();
      await vi.advanceTimersByTimeAsync(50);
      await settle();
      expect(fireBatch).toHaveBeenLastCalledWith(
        expect.any(Object),
        "fresh",
        expect.any(String),
        "source-b",
      );
      await watchers.stopAll("shutdown");
    });

    it("serializes rapid enable-disable-enable into one final running owner", async () => {
      const fake = fakeSupervisor();
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 1,
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });

      const enabled = watchers.start(job());
      const disabled = watchers.stop("stream-job", "disabled");
      const reenabled = watchers.start(job());
      await Promise.all([enabled, disabled, reenabled]);

      expect(fake.spawn).toHaveBeenCalledOnce();
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "running",
        processAlive: true,
        restartTimerPending: false,
      });
      await watchers.stopAll("shutdown");
    });

    it("fences a stale reconcile that is overtaken by shutdown", async () => {
      const fake = fakeSupervisor();
      let releaseStopWrite!: () => void;
      const stopWrite = new Promise<void>((resolve) => {
        releaseStopWrite = resolve;
      });
      let markStopWriteStarted!: () => void;
      const stopWriteStarted = new Promise<void>((resolve) => {
        markStopWriteStarted = resolve;
      });
      const updateState = vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
        if (patch.streamStatus === "stopped") {
          markStopWriteStarted();
          await stopWrite;
        }
      });
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job({ id: "old-job" }));

      const staleReconcile = watchers.reconcile([job({ id: "new-job" })], true);
      await stopWriteStarted;
      const shutdown = watchers.stopAll("shutdown");
      releaseStopWrite();
      await Promise.all([staleReconcile, shutdown]);

      expect(fake.spawn).toHaveBeenCalledOnce();
      expect(watchers.activeJobIds()).toEqual([]);
      expect(watchers.inspect("new-job")).toBeUndefined();
    });

    it("fences a stale reconcile snapshot after a newer direct update", async () => {
      const fake = fakeSupervisor();
      let releaseStopWrite!: () => void;
      const stopWrite = new Promise<void>((resolve) => {
        releaseStopWrite = resolve;
      });
      let markStopWriteStarted!: () => void;
      const stopWriteStarted = new Promise<void>((resolve) => {
        markStopWriteStarted = resolve;
      });
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
          if (patch.streamStatus === "stopped") {
            markStopWriteStarted();
            await stopWrite;
          }
        }),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job({ id: "blocking-job" }));

      const staleReconcile = watchers.reconcile(
        [
          job({
            id: "target-job",
            schedule: { kind: "stream", command: ["stale-source"], batchMs: 50 },
          }),
        ],
        true,
      );
      await stopWriteStarted;
      await watchers.start(
        job({
          id: "target-job",
          schedule: { kind: "stream", command: ["current-source"], batchMs: 50 },
        }),
      );
      releaseStopWrite();
      await staleReconcile;

      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(fake.inputs[1]).toMatchObject({ argv: ["current-source"] });
      expect(watchers.inspect("target-job")?.state).toBe("running");
      await watchers.stopAll("shutdown");
    });

    it("replaces an owner retired by an older reconcile when a newer snapshot wants it", async () => {
      const fake = fakeSupervisor();
      let releaseStopWrite!: () => void;
      const stopWrite = new Promise<void>((resolve) => {
        releaseStopWrite = resolve;
      });
      let markStopWriteStarted!: () => void;
      const stopWriteStarted = new Promise<void>((resolve) => {
        markStopWriteStarted = resolve;
      });
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
          if (patch.streamStatus === "stopped") {
            markStopWriteStarted();
            await stopWrite;
          }
        }),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());

      const staleReconcile = watchers.reconcile([], true);
      await stopWriteStarted;
      const currentReconcile = watchers.reconcile([job()], true);
      releaseStopWrite();
      await Promise.all([staleReconcile, currentReconcile]);

      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "running",
        processAlive: true,
      });
      await watchers.stopAll("shutdown");
    });

    it("lets a newer explicit start replace an owner being removed", async () => {
      const fake = fakeSupervisor();
      const retireSource = vi.fn(async (_jobId: string, _scheduleKey: string, identity: string) => {
        return `${identity}:retired`;
      });
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        retireSource,
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());

      const removal = watchers.stop("stream-job", "removed");
      const replacement = watchers.start(job());
      await Promise.all([removal, replacement]);

      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "running",
        processAlive: true,
        // Only the durable removal retires; disposing the obsolete owner for
        // the replacement start must not rotate the incoming identity.
        sourceIdentity: "source:stream-job",
      });
      expect(retireSource).toHaveBeenCalledTimes(1);
      await watchers.stopAll("shutdown");
    });

    it("does not leak owner or mutation-epoch state across unique-id churn", async () => {
      const fake = fakeSupervisor();
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      // Push far past MAX_MUTATION_EPOCHS (1024) distinct job ids through
      // start+remove so the LRU eviction path runs many times; a broken cap
      // would grow unbounded (or spin). Removed jobs must leave no live owner.
      for (let i = 0; i < 2_100; i++) {
        const id = `churn-${i}`;
        await watchers.start(job({ id }));
        await watchers.stop(id, "removed");
      }
      expect(watchers.activeJobIds()).toEqual([]);
      await watchers.stopAll("shutdown");
    });

    it("retires logical source identity before waiting on an in-flight batch", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      let releasePayload!: () => void;
      const payload = new Promise<void>((resolve) => {
        releasePayload = resolve;
      });
      const retireSource = vi.fn(async () => "source-retired");
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 1,
        retireSource,
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => {
          await payload;
          return "fired" as const;
        }),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      fake.inputs[0]?.onStdout?.("in flight\n");
      await settle();
      await vi.advanceTimersByTimeAsync(50);
      await settle();

      const stopping = watchers.stop("stream-job", "removed");
      await settle();
      expect(retireSource).toHaveBeenCalledWith(
        "stream-job",
        expect.any(String),
        "source:stream-job",
      );
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopping",
        sourceIdentity: "source-retired",
      });

      await vi.advanceTimersByTimeAsync(10_000);
      await stopping;
      releasePayload();
      await settle();
    });
  });

  it("supervises a real Node line source and tears it down", async () => {
    vi.useRealTimers();
    const supervisor = createProcessSupervisor();
    const fireBatch = vi.fn(async () => "fired" as const);
    const watchers = createWatchers({
      getProcessSupervisor: () => supervisor,
      minIntervalMs: 1,
      updateState: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      fireBatch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile(
      [
        job({
          schedule: {
            kind: "stream",
            command: [
              process.execPath,
              "-e",
              "console.log('live-line'); setInterval(() => {}, 1000)",
            ],
            batchMs: 50,
          },
        }),
      ],
      true,
    );
    await vi.waitFor(
      () =>
        expect(fireBatch).toHaveBeenCalledWith(
          expect.any(Object),
          "live-line",
          expect.any(String),
          expect.any(String),
        ),
      {
        timeout: 3_000,
      },
    );
    await watchers.stopAll("shutdown");
    expect(watchers.activeJobIds()).toEqual([]);
  });
});

describe("resolveStreamStopReason", () => {
  const base = {
    triggersEnabled: true,
    cronEnabled: true,
    restartExhausted: false,
    isStream: true,
  };

  it("selects trust-disabled when triggers are off, even if cron is also off", () => {
    expect(resolveStreamStopReason({ ...base, triggersEnabled: false, cronEnabled: false })).toBe(
      "trust-disabled",
    );
  });

  it("selects the remediable cron-disabled when only global cron is off", () => {
    // Direct-mutation regression: cron off + triggers on must not fall through to
    // the generic stopped reason, matching reconcile's cron-disabled remediation.
    expect(resolveStreamStopReason({ ...base, cronEnabled: false })).toBe("cron-disabled");
  });

  it("prefers restart-exhausted over the generic disabled reason", () => {
    expect(resolveStreamStopReason({ ...base, restartExhausted: true })).toBe("restart-exhausted");
  });

  it("uses disabled for a live stream job and schedule-update otherwise", () => {
    expect(resolveStreamStopReason(base)).toBe("disabled");
    expect(resolveStreamStopReason({ ...base, isStream: false })).toBe("schedule-update");
  });
});
