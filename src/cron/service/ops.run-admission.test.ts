// Shared cron run-admission regressions cover cross-trigger limits and queued-run cleanup.
import { describe, expect, it, vi } from "vitest";
import {
  createDeferred,
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  setCommandLaneConcurrency,
  waitForActiveTasks,
} from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import * as cronStoreModule from "../store.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStreamScheduleKey } from "../stream-schedule.js";
import { recomputeNextRunsForMaintenance } from "./jobs.js";
import { enqueueRun, list, run, stop, update } from "./ops.js";
import { createCronServiceState } from "./state.js";
import { onTimer } from "./timer.test-support.js";

const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-run-admission-",
});

type CronStateParams = Parameters<typeof createCronServiceState>[0] & {
  testAdmissionLimit?: number;
};

function createAdmissionTestState(params: CronStateParams) {
  const { testAdmissionLimit, ...stateParams } = params;
  const state = createCronServiceState(stateParams);
  if (testAdmissionLimit !== undefined) {
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - testAdmissionLimit;
  }
  return state;
}

function expectQueuedRunAck(result: unknown) {
  const ack = result as { ok?: unknown; enqueued?: unknown; runId?: unknown };
  expect(ack.ok).toBe(true);
  expect(ack.enqueued).toBe(true);
  expect(typeof ack.runId).toBe("string");
  return ack.runId as string;
}

describe("cron service run admission", () => {
  it("rechecks a queued manual run after the job is disabled", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:04.000Z");
    const job = createDueIsolatedJob({
      id: "queued-disabled-before-admission",
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
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    expectQueuedRunAck(await enqueueRun(state, job.id, "due"));
    await update(state, job.id, { enabled: false });
    releaseBlocker.resolve();
    await blocker;
    await waitForActiveTasks(5_000);

    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    clearCommandLane(CommandLane.Cron);
  });

  it("drains a burst of scheduled jobs without exceeding shared admission", async () => {
    vi.useRealTimers();
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:05.250Z");
    const jobs = Array.from({ length: 40 }, (_, index) =>
      createDueIsolatedJob({
        id: `scheduled-admission-burst-${index}`,
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      }),
    );
    await saveCronStore(store.storePath, { version: 1, jobs });

    let active = 0;
    let peakActive = 0;
    const completed = new Set<string>();
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 4,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async ({ job }: { job: { id: string } }) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise((resolve) => {
          setTimeout(resolve, 2);
        });
        active -= 1;
        completed.add(job.id);
        return { status: "ok" as const, summary: job.id };
      }),
    });

    await onTimer(state);

    expect(completed).toEqual(new Set(jobs.map((job) => job.id)));
    expect(peakActive).toBe(4);
    const persisted = await loadCronStore(store.storePath);
    expect(
      persisted.jobs.every(
        (job) => job.state.queuedAtMs === undefined && job.state.runningAtMs === undefined,
      ),
    ).toBe(true);
  });

  it("finalizes an admitted scheduled sibling before surfacing an activation failure", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:05.500Z");
    const completingJob = createDueIsolatedJob({
      id: "a-completing-before-batch-failure",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    const failingJob = createDueIsolatedJob({
      id: "b-failing-batch-activation",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    const queuedJob = createDueIsolatedJob({
      id: "c-queued-after-batch-failure",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [completingJob, failingJob, queuedJob],
    });

    let now = dueAt;
    const completingStarted = createDeferred<void>();
    const releaseCompleting = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: { id: string } }) => {
      expect(job.id).toBe(completingJob.id);
      completingStarted.resolve();
      return await releaseCompleting.promise;
    });
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 2,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    const realSave = cronStoreModule.saveCronJobsStore;
    let reservationsPersisted = false;
    const saveSpy = vi
      .spyOn(cronStoreModule, "saveCronJobsStore")
      .mockImplementation(async (storePath, nextStore, opts) => {
        const nextFailingJob = nextStore.jobs.find((job) => job.id === failingJob.id);
        if (reservationsPersisted && nextFailingJob?.state.runningAtMs === dueAt + 1) {
          throw new Error("scheduled sibling activation failed");
        }
        await realSave(storePath, nextStore, opts);
        if (
          !reservationsPersisted &&
          nextStore.jobs.every((job) => job.state.queuedAtMs === dueAt)
        ) {
          reservationsPersisted = true;
          now = dueAt + 1;
        }
      });

    try {
      const timerRun = onTimer(state);
      await completingStarted.promise;
      releaseCompleting.resolve({ status: "ok", summary: "completed sibling" });
      await expect(timerRun).rejects.toThrow();
    } finally {
      saveSpy.mockRestore();
    }

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    const persisted = await loadCronStore(store.storePath);
    expect(persisted.jobs.find((job) => job.id === completingJob.id)?.state.lastRunStatus).toBe(
      "ok",
    );
    expect(
      persisted.jobs.find((job) => job.id === completingJob.id)?.state.runningAtMs,
    ).toBeUndefined();
    expect(
      persisted.jobs.find((job) => job.id === failingJob.id)?.state.runningAtMs,
    ).toBeUndefined();
    expect(
      persisted.jobs.find((job) => job.id === queuedJob.id)?.state.lastRunStatus,
    ).toBeUndefined();
    expect(
      persisted.jobs.find((job) => job.id === queuedJob.id)?.state.runningAtMs,
    ).toBeUndefined();
  });

  it("cancels a queued manual run before validating a disabled replacement", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.000Z");
    const activeJob = createDueIsolatedJob({
      id: "active-manual-admission",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    const waitingJob = createDueIsolatedJob({
      id: "disabled-manual-admission",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    waitingJob.state.lastError = "prior failure";
    await saveCronStore(store.storePath, { version: 1, jobs: [activeJob, waitingJob] });

    const activeStarted = createDeferred<void>();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ job: runningJob }: { job: { id: string } }) => {
      if (runningJob.id === activeJob.id) {
        activeStarted.resolve();
        return await releaseActive.promise;
      }
      return { status: "ok" as const, summary: "should not run" };
    });
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const activeRun = run(state, activeJob.id, "force");
    await activeStarted.promise;
    const waitingRun = run(state, waitingJob.id, "force");
    await vi.waitFor(() => {
      expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.queuedAtMs).toBe(
        dueAt,
      );
    });
    await update(state, waitingJob.id, { enabled: false });
    const disabledStore = await loadCronStore(store.storePath);
    const disabledJob = disabledStore.jobs.find((job) => job.id === waitingJob.id);
    expect(disabledJob).toBeDefined();
    if (disabledJob) {
      disabledJob.sessionTarget = "main";
    }
    await saveCronStore(store.storePath, disabledStore);

    releaseActive.resolve({ status: "ok", summary: "active" });
    await activeRun;
    await expect(waitingRun).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.lastError).toBe(
      "prior failure",
    );
    expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.lastRunStatus).toBe(
      undefined,
    );
  });

  it("cancels a queued stream batch after an A-to-B-to-A source replacement", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.100Z");
    const activeJob = createDueIsolatedJob({
      id: "active-before-stream-replacement",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    const streamJob = createDueIsolatedJob({
      id: "queued-stream-replacement",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    streamJob.schedule = { kind: "stream", command: ["old-source"] };
    streamJob.state.streamSourceIdentity = "source-a";
    await saveCronStore(store.storePath, { version: 1, jobs: [activeJob, streamJob] });

    const activeStarted = createDeferred<void>();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ job: runningJob }: { job: { id: string } }) => {
      if (runningJob.id === activeJob.id) {
        activeStarted.resolve();
        return await releaseActive.promise;
      }
      return { status: "ok" as const, summary: "stale stream batch" };
    });
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      cronConfig: { triggers: { enabled: true } },
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const activeRun = run(state, activeJob.id, "force");
    await activeStarted.promise;
    const streamScheduleKey = cronStreamScheduleKey(streamJob.schedule);
    const waitingRun = run(state, streamJob.id, "force", {
      streamBatch: "stale",
      streamScheduleKey,
      streamSourceIdentity: "source-a",
    });
    await vi.waitFor(() => {
      expect(state.queuedRunReservationsByJobId.has(streamJob.id)).toBe(true);
    });
    await update(state, streamJob.id, {
      schedule: { kind: "stream", command: ["new-source"] },
    });
    const restored = await update(state, streamJob.id, {
      schedule: { kind: "stream", command: ["old-source"] },
    });
    expect(restored.state.streamSourceIdentity).not.toBe("source-a");

    releaseActive.resolve({ status: "ok", summary: "active" });
    await activeRun;
    await expect(waitingRun).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
    await expect(
      run(state, streamJob.id, "force", {
        streamBatch: "stale-after-replacement",
        streamScheduleKey,
        streamSourceIdentity: "source-a",
      }),
    ).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("skips an immediately-executed stream batch whose schedule key is stale", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.150Z");
    const streamJob = createDueIsolatedJob({
      id: "immediate-stale-stream",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    streamJob.schedule = { kind: "stream", command: ["current-source"] };
    streamJob.state.streamSourceIdentity = "current-source-identity";
    await saveCronStore(store.storePath, { version: 1, jobs: [streamJob] });

    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "ran" }));
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      cronConfig: { triggers: { enabled: true } },
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    // A batch tagged with a schedule key that never matched the current
    // schedule must be dropped at the execution guard, not fired.
    await expect(
      run(state, streamJob.id, "force", {
        streamBatch: "from-a-retired-schedule",
        streamScheduleKey: cronStreamScheduleKey({ kind: "stream", command: ["retired-source"] }),
        streamSourceIdentity: "current-source-identity",
      }),
    ).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();

    // The definition key alone is not an ownership claim; identity is mandatory.
    await expect(
      run(state, streamJob.id, "force", {
        streamBatch: "missing-source-identity",
        streamScheduleKey: cronStreamScheduleKey(streamJob.schedule),
      }),
    ).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });

    // A batch tagged with the current source definition and identity still fires.
    await run(state, streamJob.id, "force", {
      streamBatch: "from-current-schedule",
      streamScheduleKey: cronStreamScheduleKey(streamJob.schedule),
      streamSourceIdentity: "current-source-identity",
    });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("assigns a source identity to a persisted stream row that lacks one", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.155Z");
    const streamJob = createDueIsolatedJob({
      id: "missing-source-identity",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    streamJob.schedule = { kind: "stream", command: ["legacy-source"] };
    // Hand-imported/pre-identity row: identity is store-owned state, so load
    // normalization must assign one instead of failing the watcher closed.
    streamJob.state.streamSourceIdentity = undefined;
    await saveCronStore(store.storePath, { version: 1, jobs: [streamJob] });

    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      cronConfig: { triggers: { enabled: true } },
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    // The watcher reconcile feed (cron.list) runs tick normalization and
    // persists the repaired row durably.
    await list(state, { includeDisabled: true });
    const healed = state.store?.jobs.find((entry) => entry.id === streamJob.id);
    expect(healed?.state.streamSourceIdentity).toEqual(expect.any(String));
    expect(healed?.state.streamSourceIdentity?.length).toBeGreaterThan(0);
    const reloaded = await loadCronStore(store.storePath);
    expect(
      reloaded.jobs.find((entry) => entry.id === streamJob.id)?.state.streamSourceIdentity,
    ).toBe(healed?.state.streamSourceIdentity);
  });

  it("skips a stream batch from a retired source identity under an unchanged schedule key", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.160Z");
    const streamJob = createDueIsolatedJob({
      id: "stale-source-identity",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    streamJob.schedule = { kind: "stream", command: ["current-source"] };
    // The live source identity currently owning this job's batches. A
    // disable→re-enable or A→B→A edit leaves the schedule key identical but
    // advances this token, so the schedule-key guard alone cannot tell a retired
    // retired batch from a live one.
    streamJob.state.streamSourceIdentity = "2.5";
    await saveCronStore(store.storePath, { version: 1, jobs: [streamJob] });

    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "ran" }));
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      cronConfig: { triggers: { enabled: true } },
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const scheduleKey = cronStreamScheduleKey(streamJob.schedule);
    // Same schedule key, retired source identity: must be dropped, not fired.
    await expect(
      run(state, streamJob.id, "force", {
        streamBatch: "from-a-retired-epoch",
        streamScheduleKey: scheduleKey,
        streamSourceIdentity: "1.4",
      }),
    ).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();

    // Same schedule key, current source identity: still fires.
    await run(state, streamJob.id, "force", {
      streamBatch: "from-the-live-epoch",
      streamScheduleKey: scheduleKey,
      streamSourceIdentity: "2.5",
    });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("revalidates a manual job changed to an unsupported spec while queued", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.125Z");
    const activeJob = createDueIsolatedJob({
      id: "active-before-invalid-manual",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    const waitingJob = createDueIsolatedJob({
      id: "invalid-while-queued-manual",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [activeJob, waitingJob] });

    const activeStarted = createDeferred<void>();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: { id: string } }) => {
      if (job.id === activeJob.id) {
        activeStarted.resolve();
        return await releaseActive.promise;
      }
      return { status: "ok" as const, summary: "should not run" };
    });
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const activeRun = run(state, activeJob.id, "force");
    await activeStarted.promise;
    const waitingRun = run(state, waitingJob.id, "force");
    await vi.waitFor(() => {
      expect(state.queuedRunReservationsByJobId.has(waitingJob.id)).toBe(true);
    });
    const persistedStore = await loadCronStore(store.storePath);
    const persistedWaitingJob = persistedStore.jobs.find((job) => job.id === waitingJob.id);
    expect(persistedWaitingJob).toBeDefined();
    if (persistedWaitingJob) {
      persistedWaitingJob.sessionTarget = "main";
    }
    await saveCronStore(store.storePath, persistedStore);

    releaseActive.resolve({ status: "ok", summary: "active" });
    await activeRun;
    await expect(waitingRun).resolves.toEqual({ ok: true, ran: false, reason: "invalid-spec" });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(state.queuedRunReservationsByJobId.has(waitingJob.id)).toBe(false);
    const completedJob = (await loadCronStore(store.storePath)).jobs.find(
      (job) => job.id === waitingJob.id,
    );
    expect(completedJob?.state.runningAtMs).toBeUndefined();
    expect(completedJob?.state.lastRunStatus).toBe("skipped");
  });

  it("keeps a same-millisecond replacement reservation when stale cleanup runs", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.250Z");
    const activeJob = createDueIsolatedJob({
      id: "active-before-replacement-reservation",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    const waitingJob = createDueIsolatedJob({
      id: "same-ms-replacement-reservation",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [activeJob, waitingJob] });

    const activeStarted = createDeferred<void>();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const replacementStarted = createDeferred<void>();
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: { id: string } }) => {
      if (job.id === activeJob.id) {
        activeStarted.resolve();
        return await releaseActive.promise;
      }
      replacementStarted.resolve();
      return { status: "ok" as const, summary: "replacement" };
    });
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const activeRun = run(state, activeJob.id, "force");
    await activeStarted.promise;
    const staleRun = run(state, waitingJob.id, "force");
    await vi.waitFor(() => {
      expect(state.queuedRunReservationsByJobId.has(waitingJob.id)).toBe(true);
    });
    const staleIdentity = state.queuedRunReservationsByJobId.get(waitingJob.id)?.identity;
    await update(state, waitingJob.id, { enabled: false });

    const replacementRun = run(state, waitingJob.id, "force");
    await vi.waitFor(() => {
      expect(state.queuedRunReservationsByJobId.get(waitingJob.id)?.identity).not.toBe(
        staleIdentity,
      );
      expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.queuedAtMs).toBe(
        dueAt,
      );
    });

    releaseActive.resolve({ status: "ok", summary: "active" });
    await expect(staleRun).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
    await replacementStarted.promise;
    await Promise.all([activeRun, replacementRun]);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("keeps force runs available for jobs disabled before reservation", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.500Z");
    const job = createDueIsolatedJob({
      id: "force-disabled-before-admission",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    job.enabled = false;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("keeps queued force runs for jobs disabled before reservation through maintenance", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.625Z");
    const activeJob = createDueIsolatedJob({
      id: "active-before-disabled-force",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    const waitingJob = createDueIsolatedJob({
      id: "queued-disabled-force",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    waitingJob.enabled = false;
    await saveCronStore(store.storePath, { version: 1, jobs: [activeJob, waitingJob] });

    const activeStarted = createDeferred<void>();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const waitingStarted = createDeferred<void>();
    const releaseWaiting = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: { id: string } }) => {
      if (job.id === activeJob.id) {
        activeStarted.resolve();
        return await releaseActive.promise;
      }
      waitingStarted.resolve();
      return await releaseWaiting.promise;
    });
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const activeRun = run(state, activeJob.id, "force");
    await activeStarted.promise;
    const waitingRun = run(state, waitingJob.id, "force");
    await vi.waitFor(() => {
      expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.queuedAtMs).toBe(
        dueAt,
      );
    });
    recomputeNextRunsForMaintenance(state);
    expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.queuedAtMs).toBe(dueAt);

    releaseActive.resolve({ status: "ok", summary: "active" });
    await waitingStarted.promise;
    expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.runningAtMs).toBe(
      dueAt,
    );
    recomputeNextRunsForMaintenance(state);
    expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.runningAtMs).toBe(
      dueAt,
    );
    releaseWaiting.resolve({ status: "ok", summary: "waiting" });
    await Promise.all([activeRun, waitingRun]);

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("keeps queued manual reservations out of stuck-marker cleanup", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.750Z");
    const activeJob = createDueIsolatedJob({
      id: "active-before-manual-duration",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    const waitingJob = createDueIsolatedJob({
      id: "queued-manual-duration",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [activeJob, waitingJob] });

    let now = dueAt;
    const activeStarted = createDeferred<void>();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const waitingStarted = createDeferred<void>();
    const releaseWaiting = createDeferred<{ status: "ok"; summary: string }>();
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async ({ job: runningJob }: { job: { id: string } }) => {
        if (runningJob.id === activeJob.id) {
          activeStarted.resolve();
          return await releaseActive.promise;
        }
        waitingStarted.resolve();
        return await releaseWaiting.promise;
      }),
    });

    const activeRun = run(state, activeJob.id, "force");
    await activeStarted.promise;
    const waitingRun = run(state, waitingJob.id, "force");
    await vi.waitFor(() => {
      expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.queuedAtMs).toBe(
        dueAt,
      );
    });
    now += 2 * 60 * 60 * 1000 + 1;
    recomputeNextRunsForMaintenance(state);
    expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.queuedAtMs).toBe(dueAt);
    releaseActive.resolve({ status: "ok", summary: "active" });
    await waitingStarted.promise;
    const waitingStartedAt = now;
    expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.runningAtMs).toBe(
      waitingStartedAt,
    );
    expect(
      (await loadCronStore(store.storePath))?.jobs.find((job) => job.id === waitingJob.id)?.state
        .runningAtMs,
    ).toBe(waitingStartedAt);
    expect(state.queuedRunReservationsByJobId.has(waitingJob.id)).toBe(true);
    now += 2 * 60 * 60 * 1000 + 1;
    recomputeNextRunsForMaintenance(state);
    expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.runningAtMs).toBe(
      waitingStartedAt,
    );
    now += 100;
    releaseWaiting.resolve({ status: "ok", summary: "queued" });

    await Promise.all([activeRun, waitingRun]);
    const completedWaitingJob = state.store?.jobs.find((job) => job.id === waitingJob.id);
    expect(completedWaitingJob?.state.lastRunAtMs).toBe(waitingStartedAt);
    expect(completedWaitingJob?.state.lastDurationMs).toBe(2 * 60 * 60 * 1000 + 101);
    expect(state.queuedRunReservationsByJobId.has(waitingJob.id)).toBe(false);
  });

  it("releases a manual reservation when activation reload fails", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.875Z");
    const job = createDueIsolatedJob({
      id: "manual-activation-reload-failure",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const realLoad = cronStoreModule.loadCronJobsStoreWithConfigJobs;
    let loadCount = 0;
    const loadSpy = vi
      .spyOn(cronStoreModule, "loadCronJobsStoreWithConfigJobs")
      .mockImplementation(async (storePath) => {
        loadCount += 1;
        if (loadCount === 2) {
          throw new Error("activation reload failed");
        }
        return await realLoad(storePath);
      });

    try {
      await expect(run(state, job.id, "force")).rejects.toThrow("activation reload failed");
    } finally {
      loadSpy.mockRestore();
    }

    expect(
      state.store?.jobs.find((entry) => entry.id === job.id)?.state.runningAtMs,
    ).toBeUndefined();
    expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
    expect(
      (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id)?.state
        .runningAtMs,
    ).toBeUndefined();
  });

  it("retries a stopped manual reservation cleanup after reload fails", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.906Z");
    const job = createDueIsolatedJob({
      id: "stopped-manual-cleanup-reload-failure",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const realSave = cronStoreModule.saveCronJobsStore;
    const saveSpy = vi
      .spyOn(cronStoreModule, "saveCronJobsStore")
      .mockImplementation(async (storePath, nextStore, opts) => {
        await realSave(storePath, nextStore, opts);
        if (nextStore.jobs.find((entry) => entry.id === job.id)?.state.queuedAtMs === dueAt) {
          stop(state);
        }
      });
    const realLoad = cronStoreModule.loadCronJobsStoreWithConfigJobs;
    let cleanupReloadFailed = false;
    const loadSpy = vi
      .spyOn(cronStoreModule, "loadCronJobsStoreWithConfigJobs")
      .mockImplementation(async (storePath) => {
        if (state.stopped && !cleanupReloadFailed) {
          cleanupReloadFailed = true;
          throw new Error("cleanup reload failed");
        }
        return await realLoad(storePath);
      });

    try {
      await expect(run(state, job.id, "force")).resolves.toEqual({
        ok: true,
        ran: false,
        reason: "stopped",
      });
    } finally {
      loadSpy.mockRestore();
      saveSpy.mockRestore();
    }

    expect(cleanupReloadFailed).toBe(true);
    expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
    expect(
      (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id)?.state
        .runningAtMs,
    ).toBeUndefined();
  });

  it("keeps an activated same-millisecond marker when finalization reload fails", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.937Z");
    const job = createDueIsolatedJob({
      id: "manual-finalization-reload-failure",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const realSave = cronStoreModule.saveCronJobsStore;
    let saveCount = 0;
    const saveSpy = vi
      .spyOn(cronStoreModule, "saveCronJobsStore")
      .mockImplementation(async (storePath, nextStore, opts) => {
        saveCount += 1;
        if (saveCount === 3) {
          throw new Error("finalization persist failed");
        }
        await realSave(storePath, nextStore, opts);
      });

    try {
      await expect(run(state, job.id, "force")).rejects.toThrow("finalization persist failed");
    } finally {
      saveSpy.mockRestore();
    }

    expect(state.store?.jobs.find((entry) => entry.id === job.id)?.state.runningAtMs).toBe(dueAt);
    expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
    expect(
      (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id)?.state
        .runningAtMs,
    ).toBe(dueAt);
  });

  it("releases a direct manual reservation when stop wins its admission wait", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:07.000Z");
    const activeJob = createDueIsolatedJob({
      id: "active-before-manual-stop",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    const waitingJob = createDueIsolatedJob({
      id: "stopped-manual-admission",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [activeJob, waitingJob] });

    const activeStarted = createDeferred<void>();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async ({ job: runningJob }: { job: { id: string } }) => {
        if (runningJob.id === activeJob.id) {
          activeStarted.resolve();
          return await releaseActive.promise;
        }
        return { status: "ok" as const, summary: "should not run" };
      }),
    });

    const activeRun = run(state, activeJob.id, "force");
    await activeStarted.promise;
    const waitingRun = run(state, waitingJob.id, "force");
    await vi.waitFor(() => {
      expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.queuedAtMs).toBe(
        dueAt,
      );
    });
    stop(state);
    await expect(waitingRun).resolves.toEqual({ ok: true, ran: false, reason: "stopped" });
    expect(
      state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.runningAtMs,
    ).toBeUndefined();
    expect(state.queuedRunReservationsByJobId.has(waitingJob.id)).toBe(false);
    releaseActive.resolve({ status: "ok", summary: "active" });
    await activeRun;
  });

  it("skips a scheduled reservation rescheduled while it waits for admission", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:08.000Z");
    const activeJob = createDueIsolatedJob({
      id: "active-before-scheduled-admission",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    const scheduledJob = createDueIsolatedJob({
      id: "rescheduled-scheduled-admission",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [activeJob, scheduledJob] });

    const activeStarted = createDeferred<void>();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ job: runningJob }: { job: { id: string } }) => {
      if (runningJob.id === activeJob.id) {
        activeStarted.resolve();
        return await releaseActive.promise;
      }
      return { status: "ok" as const, summary: "should not run" };
    });
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const activeRun = run(state, activeJob.id, "force");
    await activeStarted.promise;
    const timerRun = onTimer(state);
    await vi.waitFor(() => {
      expect(state.store?.jobs.find((job) => job.id === scheduledJob.id)?.state.queuedAtMs).toBe(
        dueAt,
      );
    });
    await update(state, scheduledJob.id, {
      schedule: { kind: "at", at: new Date(dueAt + 3_600_000).toISOString() },
    });

    releaseActive.resolve({ status: "ok", summary: "active" });
    await Promise.all([activeRun, timerRun]);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(
      state.store?.jobs.find((job) => job.id === scheduledJob.id)?.state.runningAtMs,
    ).toBeUndefined();
  });
});
