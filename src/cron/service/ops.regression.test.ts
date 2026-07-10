// Cron ops regression tests cover service operation regressions.
import { describe, expect, it, vi } from "vitest";
import {
  createAbortAwareIsolatedRunner,
  createDeferred,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  setCommandLaneConcurrency,
  waitForActiveTasks,
} from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { saveCronStore } from "../store.js";
import { enqueueRun, remove, run, start } from "./ops.js";
import type { CronEvent } from "./state.js";
import { createCronServiceState } from "./state.js";
import { onTimer } from "./timer.js";

const FAST_TIMEOUT_SECONDS = 1;
const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-ops-regressions-",
});

function expectQueuedRunAck(result: unknown) {
  const ack = result as { ok?: unknown; enqueued?: unknown; runId?: unknown };
  expect(ack.ok).toBe(true);
  expect(ack.enqueued).toBe(true);
  expect(typeof ack.runId).toBe("string");
  return ack.runId as string;
}

function requireMockCall(
  mock: { mock: { calls: unknown[][] } },
  callIndex: number,
  label: string,
): unknown[] {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call;
}

function expectIsolatedRunJobId(
  runIsolatedAgentJob: ReturnType<typeof vi.fn>,
  callIndex: number,
  jobId: string,
) {
  const [params] = requireMockCall(runIsolatedAgentJob, callIndex, "runIsolatedAgentJob") as [
    { job?: { id?: string } }?,
  ];
  expect(params?.job?.id).toBe(jobId);
}

describe("cron service ops regressions", () => {
  it("repairs missing job state during startup", async () => {
    const scheduledAt = Date.now() + 60_000;
    const store = opsRegressionFixtures.makeStorePath();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    state.store = {
      version: 1,
      jobs: [
        {
          ...createIsolatedRegressionJob({
            id: "missing-state-startup",
            name: "missing-state-startup",
            scheduledAt,
            schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
            payload: { kind: "agentTurn", message: "noop" },
          }),
          state: undefined as never,
        },
      ],
    };

    await expect(start(state)).resolves.toBeUndefined();
    expect(state.store.jobs[0]?.state.nextRunAtMs).toBe(scheduledAt);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  });

  it("records queued forced runs that lose a timer race as skipped", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.now() - 1;
    const job = createIsolatedRegressionJob({
      id: "timer-overlap",
      name: "timer-overlap",
      scheduledAt: dueAt,
      schedule: { kind: "at", at: new Date(dueAt).toISOString() },
      payload: { kind: "agentTurn", message: "long task" },
      state: { nextRunAtMs: dueAt },
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const blockerStarted = createDeferred<void>();
    const releaseBlocker = createDeferred<void>();
    const blocker = enqueueCommandInLane(CommandLane.Cron, async () => {
      blockerStarted.resolve();
      return await releaseBlocker.promise;
    });
    await blockerStarted.promise;

    let resolveRun:
      | ((value: { status: "ok" | "error" | "skipped"; summary?: string; error?: string }) => void)
      | undefined;
    const started = createDeferred<void>();
    const finished = createDeferred<void>();
    const events: CronEvent[] = [];
    const runIsolatedAgentJob = vi.fn(
      async () =>
        await new Promise<{ status: "ok" | "error" | "skipped"; summary?: string; error?: string }>(
          (resolve) => {
            resolveRun = resolve;
          },
        ),
    );

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      onEvent: (evt: CronEvent) => {
        events.push(evt);
        if (evt.jobId !== job.id) {
          return;
        }
        if (evt.action === "started") {
          started.resolve();
        } else if (evt.action === "finished" && evt.status === "ok") {
          finished.resolve();
        }
      },
    });

    const ack = await enqueueRun(state, job.id, "force");
    const runId = expectQueuedRunAck(ack);

    const timerPromise = onTimer(state);
    await started.promise;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    releaseBlocker.resolve();
    await blocker;
    await waitForActiveTasks(5_000);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        jobId: job.id,
        action: "finished",
        status: "skipped",
        error: "queued manual run skipped before execution: already-running",
        runId,
      }),
    );

    resolveRun?.({ status: "ok", summary: "done" });
    await finished.promise;
    await timerPromise;
    clearCommandLane(CommandLane.Cron);
  });

  it("does not double-run a job when cron.run overlaps a due timer tick", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const job = createIsolatedRegressionJob({
      id: "manual-overlap-no-double-run",
      name: "manual overlap no double run",
      scheduledAt: now,
      schedule: { kind: "at", at: new Date(now).toISOString() },
      payload: { kind: "agentTurn", message: "overlap" },
      state: { nextRunAtMs: now },
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const runStarted = createDeferred<void>();
    const runFinished = createDeferred<void>();
    const runResolvers: Array<
      (value: { status: "ok" | "error" | "skipped"; summary?: string }) => void
    > = [];
    const runIsolatedAgentJob = vi.fn(async () => {
      if (runIsolatedAgentJob.mock.calls.length === 1) {
        runStarted.resolve();
      }
      return await new Promise<{ status: "ok" | "error" | "skipped"; summary?: string }>(
        (resolve) => {
          runResolvers.push(resolve);
        },
      );
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      onEvent: (evt: CronEvent) => {
        if (evt.jobId === job.id && evt.action === "finished") {
          runFinished.resolve();
        }
      },
    });

    const manualRun = run(state, job.id, "force");
    await runStarted.promise;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    await onTimer(state);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    runResolvers[0]?.({ status: "ok", summary: "done" });
    await manualRun;
    await runFinished.promise;
  });

  it("manual cron.run preserves unrelated due jobs but advances already-executed stale slots", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const nowMs = Date.now();
    const dueNextRunAtMs = nowMs - 1_000;
    const staleExecutedNextRunAtMs = nowMs - 2_000;

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [
        createIsolatedRegressionJob({
          id: "manual-target",
          name: "manual target",
          scheduledAt: nowMs,
          schedule: { kind: "at", at: new Date(nowMs + 3_600_000).toISOString() },
          payload: { kind: "agentTurn", message: "manual target" },
          state: { nextRunAtMs: nowMs + 3_600_000 },
        }),
        createIsolatedRegressionJob({
          id: "unrelated-due",
          name: "unrelated due",
          scheduledAt: nowMs,
          schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
          payload: { kind: "agentTurn", message: "unrelated due" },
          state: { nextRunAtMs: dueNextRunAtMs },
        }),
        createIsolatedRegressionJob({
          id: "unrelated-stale-executed",
          name: "unrelated stale executed",
          scheduledAt: nowMs,
          schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
          payload: { kind: "agentTurn", message: "unrelated stale executed" },
          state: {
            nextRunAtMs: staleExecutedNextRunAtMs,
            lastRunAtMs: staleExecutedNextRunAtMs + 1,
          },
        }),
      ],
    });

    const state = createCronServiceState({
      cronEnabled: false,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });

    const runResult = await run(state, "manual-target", "force");
    expect(runResult).toEqual({ ok: true, ran: true });

    const jobs = state.store?.jobs ?? [];
    const unrelated = jobs.find((entry) => entry.id === "unrelated-due");
    const staleExecuted = jobs.find((entry) => entry.id === "unrelated-stale-executed");
    expect(unrelated?.state.nextRunAtMs).toBe(dueNextRunAtMs);
    expect((staleExecuted?.state.nextRunAtMs ?? 0) > nowMs).toBe(true);
  });

  it("passes the rehydrated agentTurn payload message to isolated manual runs", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const nowMs = Date.now();
    const marker =
      "SERIALIZATION_PROBE: reply exactly with the marker token you received and nothing else.";
    const job = createIsolatedRegressionJob({
      id: "manual-payload-message",
      name: "manual payload message",
      scheduledAt: nowMs,
      schedule: { kind: "at", at: new Date(nowMs + 3_600_000).toISOString() },
      payload: { kind: "agentTurn", message: marker },
      state: { nextRunAtMs: nowMs + 3_600_000 },
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "ok" });
    const state = createCronServiceState({
      cronEnabled: false,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const runResult = await run(state, job.id, "force");

    expect(runResult).toEqual({ ok: true, ran: true });
    expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
    const [params] = requireMockCall(runIsolatedAgentJob, 0, "runIsolatedAgentJob") as [
      { message?: unknown }?,
    ];
    expect(params?.message).toBe(marker);
  });

  it("applies timeoutSeconds to manual cron.run isolated executions", async () => {
    vi.useFakeTimers();
    try {
      const store = opsRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const job = createIsolatedRegressionJob({
        id: "manual-timeout",
        name: "manual timeout",
        scheduledAt,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: scheduledAt },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
        state: { nextRunAtMs: scheduledAt },
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      const abortAwareRunner = createAbortAwareIsolatedRunner();
      const state = createCronServiceState({
        cronEnabled: false,
        storePath: store.storePath,
        log: noopLogger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: abortAwareRunner.runIsolatedAgentJob,
      });

      const resultPromise = run(state, job.id, "force");
      await abortAwareRunner.waitForStart();
      await vi.advanceTimersByTimeAsync(Math.ceil(FAST_TIMEOUT_SECONDS * 1_000) + 10);
      const result = await resultPromise;
      expect(result).toEqual({ ok: true, ran: true });
      expect(abortAwareRunner.getObservedAbortSignal()?.aborted).toBe(true);

      const updated = state.store?.jobs.find((entry) => entry.id === job.id);
      expect(updated?.state.lastStatus).toBe("error");
      expect(updated?.state.lastError).toContain("timed out");
      expect(updated?.state.runningAtMs).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("#17554: run() clears stale runningAtMs and executes the job", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const staleRunningAtMs = now - 2 * 60 * 60 * 1000 - 1;

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [
        {
          id: "stale-running",
          name: "stale-running",
          enabled: true,
          createdAtMs: now - 3_600_000,
          updatedAtMs: now - 3_600_000,
          schedule: { kind: "at", at: new Date(now - 60_000).toISOString() },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "stale-running" },
          state: {
            runningAtMs: staleRunningAtMs,
            lastRunAtMs: now - 3_600_000,
            lastStatus: "ok",
            nextRunAtMs: now - 60_000,
          },
        },
      ],
    });

    const enqueueSystemEvent = vi.fn();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });

    const result = await run(state, "stale-running", "force");
    expect(result).toEqual({ ok: true, ran: true });
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    const [text, options] = requireMockCall(enqueueSystemEvent, 0, "enqueueSystemEvent") as [
      string,
      { agentId?: unknown }?,
    ];
    expect(text).toBe("stale-running");
    expect(options?.agentId).toBeUndefined();
  });

  it("queues manual cron.run requests behind the cron execution lane", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:02.000Z");
    const first = createDueIsolatedJob({ id: "queued-first", nowMs: dueAt, nextRunAtMs: dueAt });
    const second = createDueIsolatedJob({
      id: "queued-second",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [first, second] });

    let now = dueAt;
    let activeRuns = 0;
    let peakActiveRuns = 0;
    const firstStarted = createDeferred<void>();
    const firstRun = createDeferred<{ status: "ok"; summary: string }>();
    const secondRun = createDeferred<{ status: "ok"; summary: string }>();
    const secondStarted = createDeferred<void>();
    const bothFinished = createDeferred<void>();
    const runIsolatedAgentJob = vi.fn(async (params: { job: { id: string } }) => {
      activeRuns += 1;
      peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
      if (params.job.id === first.id) {
        firstStarted.resolve();
      }
      if (params.job.id === second.id) {
        secondStarted.resolve();
      }
      try {
        const result =
          params.job.id === first.id ? await firstRun.promise : await secondRun.promise;
        now += 10;
        return result;
      } finally {
        activeRuns -= 1;
      }
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      cronConfig: { maxConcurrentRuns: 1 },
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      onEvent: (evt) => {
        if (evt.action === "finished" && evt.jobId === second.id && evt.status === "ok") {
          bothFinished.resolve();
        }
      },
    });

    const firstAck = await enqueueRun(state, first.id, "force");
    const secondAck = await enqueueRun(state, second.id, "force");
    expectQueuedRunAck(firstAck);
    expectQueuedRunAck(secondAck);

    await firstStarted.promise;
    expectIsolatedRunJobId(runIsolatedAgentJob, 0, first.id);
    expect(peakActiveRuns).toBe(1);

    firstRun.resolve({ status: "ok", summary: "first queued run" });
    await secondStarted.promise;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    expectIsolatedRunJobId(runIsolatedAgentJob, 1, second.id);
    expect(peakActiveRuns).toBe(1);

    secondRun.resolve({ status: "ok", summary: "second queued run" });
    await bothFinished.promise;
    await waitForActiveTasks(5_000);
    const jobs = state.store?.jobs ?? [];
    expect(jobs.find((job) => job.id === first.id)?.state.lastStatus).toBe("ok");
    expect(jobs.find((job) => job.id === second.id)?.state.lastStatus).toBe("ok");

    clearCommandLane(CommandLane.Cron);
  });

  it("skips queued manual runs when the old cron service stops before lane admission", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
    const job = createDueIsolatedJob({
      id: "queued-stopped-manual",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const blockerStarted = createDeferred<void>();
    const releaseBlocker = createDeferred<void>();
    const blocker = enqueueCommandInLane(CommandLane.Cron, async () => {
      blockerStarted.resolve();
      return await releaseBlocker.promise;
    });

    await blockerStarted.promise;

    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const events: CronEvent[] = [];
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      onEvent: (evt) => events.push(evt),
    });

    const ack = await enqueueRun(state, job.id, "force");
    const runId = expectQueuedRunAck(ack);

    state.stopped = true;
    releaseBlocker.resolve();
    await blocker;
    await waitForActiveTasks(5_000);

    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(
      state.store?.jobs.find((entry) => entry.id === job.id)?.state.runningAtMs,
    ).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        jobId: job.id,
        action: "finished",
        status: "skipped",
        error: "queued manual run skipped before execution: stopped",
        runId,
      }),
    );

    clearCommandLane(CommandLane.Cron);
  });

  it("emits one terminal event when a queued job is removed during execution", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:04.000Z");
    const job = createDueIsolatedJob({
      id: "queued-removed-manual",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const started = createDeferred<void>();
    const execution = createDeferred<{ status: "ok"; summary: string }>();
    const events: CronEvent[] = [];
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        started.resolve();
        return await execution.promise;
      }),
      onEvent: (evt) => events.push(evt),
    });

    const ack = await enqueueRun(state, job.id, "force");
    const runId = expectQueuedRunAck(ack);
    await started.promise;

    await expect(remove(state, job.id)).resolves.toEqual({ ok: true, removed: true });
    execution.resolve({ status: "ok", summary: "completed after removal" });
    await waitForActiveTasks(5_000);

    const terminalEvents = events.filter((evt) => evt.action === "finished" && evt.runId === runId);
    expect(terminalEvents).toEqual([
      expect.objectContaining({
        jobId: job.id,
        status: "ok",
        summary: "completed after removal",
      }),
    ]);
    expect(state.store?.jobs.some((entry) => entry.id === job.id)).toBe(false);

    clearCommandLane(CommandLane.Cron);
  });
});
