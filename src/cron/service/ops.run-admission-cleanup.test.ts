// Queued cron reservation cleanup regressions across every trigger.
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  getTotalQueueSize,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { locked } from "./locked.js";
import { start, stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { enqueueRun, run } from "./ops-run.js";
import { runWithCronAdmission } from "./run-admission.js";
import { createCronServiceState } from "./state.js";
import { runMissedJobs } from "./timer.js";
import { onTimer } from "./timer.test-support.js";

const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-run-admission-cleanup-",
});
let cronJobWriteObserverId = 0;

function observeCronJobWrites(
  jobId: string,
  observer: (state: { queuedAtMs?: number; runningAtMs?: number }) => void,
): () => void {
  const database = openOpenClawStateDatabase().db;
  const suffix = ++cronJobWriteObserverId;
  const functionName = `observe_cron_job_write_${suffix}`;
  const triggerName = `observe_cron_job_write_${suffix}`;
  database.function(functionName, (writtenJobId, stateJson) => {
    if (writtenJobId !== jobId || typeof stateJson !== "string") {
      return 0;
    }
    const state = JSON.parse(stateJson) as { queuedAtMs?: number; runningAtMs?: number };
    observer({
      ...(typeof state.queuedAtMs === "number" ? { queuedAtMs: state.queuedAtMs } : {}),
      ...(typeof state.runningAtMs === "number" ? { runningAtMs: state.runningAtMs } : {}),
    });
    return 0;
  });
  database.exec(`
    CREATE TEMP TRIGGER ${triggerName}
    AFTER UPDATE ON cron_jobs
    BEGIN
      SELECT ${functionName}(NEW.job_id, NEW.state_json);
    END;
  `);
  return () => database.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
}

describe("cron service run admission cleanup", () => {
  it("clears the exact running marker when a manual run is superseded", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const startedAt = Date.parse("2026-02-06T10:05:01.500Z");
    const job = createDueIsolatedJob({
      id: "manual-supersede-clears-running-marker",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const runnerStarted = createDeferred();
    const releaseRun = createDeferred<{ status: "ok"; summary: string }>();
    let ownerAvailable = true;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      isAgentAvailable: () => ownerAvailable,
      runIsolatedAgentJob: vi.fn(async () => {
        runnerStarted.resolve();
        return await releaseRun.promise;
      }),
    });

    const activeRun = run(state, job.id, "force");
    await runnerStarted.promise;
    ownerAvailable = false;
    releaseRun.resolve({ status: "ok", summary: "stale manual completion" });
    await expect(activeRun).resolves.toEqual({ ok: true, ran: true });

    expect((await loadCronStore(store.storePath)).jobs[0]?.state.runningAtMs).toBeUndefined();
    const receipt = openOpenClawStateDatabase()
      .db.prepare(
        "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
      )
      .get(cronStoreKey(store.storePath), job.id) as { status: string } | undefined;
    expect(receipt?.status).toBe("superseded");
  });

  it("does not trust an unavailable-agent execution error as a settlement guard", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const startedAt = Date.parse("2026-02-06T10:05:01.750Z");
    const job = createDueIsolatedJob({
      id: "manual-unavailable-error-is-not-authorization",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    job.agentId = "main";
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const runnerStarted = createDeferred();
    const releaseRun = createDeferred<{ status: "error"; error: string }>();
    let ownerAvailable = true;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      isAgentAvailable: () => ownerAvailable,
      runIsolatedAgentJob: vi.fn(async () => {
        runnerStarted.resolve();
        return await releaseRun.promise;
      }),
    });

    const activeRun = run(state, job.id, "force");
    await runnerStarted.promise;
    ownerAvailable = false;
    releaseRun.resolve({
      status: "error",
      error: "cron job agent is unavailable: main",
    });
    await expect(activeRun).resolves.toEqual({ ok: true, ran: true });

    expect((await loadCronStore(store.storePath)).jobs[0]?.state.lastRunStatus).toBeUndefined();
    const receipt = openOpenClawStateDatabase()
      .db.prepare(
        "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
      )
      .get(cronStoreKey(store.storePath), job.id) as { status: string } | undefined;
    expect(receipt?.status).toBe("superseded");
  });

  it.each([
    { entry: "enqueue", invalid: true },
    { entry: "enqueue", invalid: false },
    { entry: "run", invalid: true },
    { entry: "run", invalid: false },
  ] as const)(
    "rejects $entry preflight effects after authority closes (invalid: $invalid)",
    async ({ entry, invalid }) => {
      const store = opsRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
      const job = createDueIsolatedJob({
        id: "revoked-preflight",
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      });
      if (invalid) {
        job.sessionTarget = "main";
      } else {
        delete job.state.nextRunAtMs;
      }
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });
      const before = await loadCronStore(store.storePath);
      const onEvent = vi.fn();
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => dueAt,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
        onEvent,
      });
      const lockEntered = createDeferred();
      const releaseLock = createDeferred();
      const blocker = locked(state, async () => {
        lockEntered.resolve();
        await releaseLock.promise;
      });
      await lockEntered.promise;
      let authorityActive = true;
      const operation = (entry === "enqueue" ? enqueueRun : run)(state, job.id, "force", {
        commitGuard: () => {
          if (!authorityActive) {
            throw new TypeError("authority closed");
          }
        },
      });
      authorityActive = false;
      releaseLock.resolve();
      await blocker;
      try {
        await expect.soft(operation).rejects.toThrow("authority closed");
        expect.soft(await loadCronStore(store.storePath)).toEqual(before);
        expect.soft(onEvent).not.toHaveBeenCalled();
        expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      } finally {
        stop(state);
      }
    },
  );

  it("rejects queued manual reservation after caller authority closes", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
    const job = createDueIsolatedJob({
      id: "revoked-queued-run",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const blockerStarted = createDeferred();
    const releaseBlocker = createDeferred();
    const blocker = enqueueCommandInLane(CommandLane.Cron, async () => {
      blockerStarted.resolve();
      return await releaseBlocker.promise;
    });
    await blockerStarted.promise;
    let authorityActive = true;
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    const ack = await enqueueRun(state, job.id, "force", {
      commitGuard: () => {
        if (!authorityActive) {
          throw new TypeError("authority closed");
        }
      },
    });
    expect(ack).toMatchObject({ ok: true, enqueued: true, runId: expect.any(String) });
    authorityActive = false;
    releaseBlocker.resolve();
    await blocker;
    await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0), { timeout: 5_000 });

    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect((await loadCronStore(store.storePath)).jobs[0]?.state.queuedAtMs).toBeUndefined();
    clearCommandLane(CommandLane.Cron);
  });

  it.each([
    { mode: "force" as const, evaluation: "completed" as const },
    { mode: "due" as const, evaluation: "completed" as const },
    { mode: "force" as const, evaluation: "quiet" as const },
    { mode: "due" as const, evaluation: "quiet" as const },
  ])(
    "preserves an operator-edited schedule after an active $mode $evaluation manual run",
    async ({ mode, evaluation }) => {
      const store = opsRegressionFixtures.makeStorePath();
      const startedAt = Date.parse("2026-02-06T10:05:02.000Z");
      const job = createDueIsolatedJob({
        id: `manual-${mode}-${evaluation}-preserves-edited-schedule`,
        nowMs: startedAt,
        nextRunAtMs: startedAt,
      });
      job.schedule = { kind: "every", everyMs: 60_000, anchorMs: startedAt };
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      const runnerStarted = createDeferred();
      const releaseRun = createDeferred<{
        status: "ok";
        summary: string;
        triggerEval?: { fired: false; stateChanged: false };
      }>();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => startedAt,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => {
          runnerStarted.resolve();
          return await releaseRun.promise;
        }),
      });

      const activeRun = run(state, job.id, mode);
      await runnerStarted.promise;
      const editedJob = await update(state, job.id, {
        schedule: { kind: "every", everyMs: 3_600_000, anchorMs: startedAt },
      });
      const editedNextRunAtMs = editedJob.state.nextRunAtMs;
      expect(editedNextRunAtMs).toBe(startedAt + 3_600_000);

      releaseRun.resolve({
        status: "ok",
        summary: "manual run completed",
        ...(evaluation === "quiet" ? { triggerEval: { fired: false, stateChanged: false } } : {}),
      });
      await expect(activeRun).resolves.toMatchObject({ ok: true, ran: true });

      const persistedJob = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persistedJob?.schedule).toEqual(editedJob.schedule);
      expect(persistedJob?.state.nextRunAtMs).toBe(editedNextRunAtMs);
      expect(persistedJob?.state.forcePreservedNextRunAtMs).toBeUndefined();
    },
  );

  it("preserves a concurrent non-owner state edit during manual finalization", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const startedAt = Date.parse("2026-02-06T10:05:02.500Z");
    const job = createDueIsolatedJob({
      id: "manual-authoritative-row-edit",
      nowMs: startedAt,
      nextRunAtMs: startedAt + 3_600_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const runnerStarted = createDeferred();
    const releaseRun = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        runnerStarted.resolve();
        return await releaseRun.promise;
      }),
    });
    const activeRun = run(state, job.id, "force");
    await runnerStarted.promise;
    const databasePath = openOpenClawStateDatabase().path;
    const worker = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(workerData.databasePath);
        db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
        db.prepare(
          "UPDATE cron_jobs SET state_json = json_set(state_json, '$.streamDroppedBatches', 7), updated_at = updated_at + 1 WHERE store_key = ? AND job_id = ?",
        ).run(workerData.storeKey, workerData.jobId);
        parentPort.postMessage("locked");
        setTimeout(() => {
          db.exec("COMMIT");
          parentPort.postMessage("committed");
          db.close();
        }, 500);
      `,
      {
        eval: true,
        workerData: {
          databasePath,
          storeKey: cronStoreKey(store.storePath),
          jobId: job.id,
        },
      },
    );
    const waitForMessage = (expected: string) =>
      new Promise<void>((resolve, reject) => {
        const onMessage = (message: unknown) => {
          if (message === expected) {
            cleanup();
            resolve();
          }
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          worker.off("message", onMessage);
          worker.off("error", onError);
        };
        worker.on("message", onMessage);
        worker.on("error", onError);
      });

    try {
      await waitForMessage("locked");
      const committed = waitForMessage("committed");
      releaseRun.resolve({ status: "ok", summary: "done" });
      await activeRun;
      await committed;

      expect((await loadCronStore(store.storePath)).jobs[0]?.state.streamDroppedBatches).toBe(7);
    } finally {
      releaseRun.resolve({ status: "ok", summary: "done" });
      await worker.terminate();
    }
  });

  it("does not create a receipt when saturated scheduled work is disabled", async () => {
    vi.useRealTimers();
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:05.000Z");
    const job = createDueIsolatedJob({
      id: "queued-disable-before-admission",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    // Saturated scheduled work stays in the durable job row without claiming a
    // receipt or joining the waiter queue.
    const releaseBlockers = createDeferred();
    const blockers = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, () =>
      runWithCronAdmission(state, async () => {
        await releaseBlockers.promise;
      }),
    );
    await vi.waitFor(() => {
      expect(state.runAdmission.active).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS);
    });

    await onTimer(state);
    expect((await loadCronStore(store.storePath)).jobs[0]?.state.queuedAtMs).toBeUndefined();
    expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
    expect(state.runAdmission.waiters).toHaveLength(0);
    expect(state.runAdmission.capacityListener).toBeTypeOf("function");

    // Operator disabling the unreserved row leaves no receipt cleanup behind.
    await update(state, job.id, { enabled: false });
    releaseBlockers.resolve();
    await Promise.all(blockers);
    await vi.waitFor(() => expect(state.runAdmission.capacityListener).toBeNull());

    expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    const receipt = openOpenClawStateDatabase()
      .db.prepare(
        "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC, receipt_id DESC LIMIT 1",
      )
      .get(cronStoreKey(store.storePath), job.id) as { status: string } | undefined;
    expect(receipt).toBeUndefined();

    // The job stays claimable after re-enable because no receipt was leaked.
    await update(state, job.id, { enabled: true });
    await expect(run(state, job.id, "force")).resolves.toMatchObject({ ok: true, ran: true });
  });

  it("releases immediate and queued admission slots in FIFO order after failures", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const releaseFirst = createDeferred();
    const executionOrder: string[] = [];
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => 0,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1;

    const immediate = runWithCronAdmission(state, async () => {
      executionOrder.push("immediate");
      await releaseFirst.promise;
      return "immediate";
    });
    const failed = runWithCronAdmission(state, async () => {
      executionOrder.push("failed");
      throw new Error("queued admission failed");
    });
    const failure = expect(failed).rejects.toThrow("queued admission failed");
    const queued = runWithCronAdmission(state, async () => {
      executionOrder.push("queued");
      return "queued";
    });

    expect(state.runAdmission.active).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS);
    expect(state.runAdmission.waiters).toHaveLength(2);

    releaseFirst.resolve();

    await expect(immediate).resolves.toEqual({ kind: "admitted", value: "immediate" });
    await failure;
    await expect(queued).resolves.toEqual({ kind: "admitted", value: "queued" });
    expect(executionOrder).toEqual(["immediate", "failed", "queued"]);
    expect(state.runAdmission.active).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1);
    expect(state.runAdmission.waiters).toHaveLength(0);
  });

  it.each(["manual", "scheduled", "startup"] as const)(
    "does not start a %s run when stop wins the activation write",
    async (trigger) => {
      const store = opsRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
      const job = createDueIsolatedJob({
        id: `stopped-during-${trigger}-activation`,
        nowMs: dueAt,
        nextRunAtMs: trigger === "manual" ? dueAt + 3_600_000 : dueAt,
      });
      job.state.lastError = "prior failure";
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      let now = dueAt;
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });
      let reservationPersisted = false;
      const markerTransitions: Array<"queued" | "running" | "idle"> = [];
      const stopObserving = observeCronJobWrites(job.id, ({ queuedAtMs, runningAtMs }) => {
        if (!reservationPersisted && queuedAtMs === dueAt) {
          reservationPersisted = true;
          markerTransitions.push("queued");
          now = dueAt + 1;
        } else if (reservationPersisted && runningAtMs === dueAt + 1) {
          markerTransitions.push("running");
          stop(state);
        } else if (markerTransitions.length === 2 && !queuedAtMs && !runningAtMs) {
          markerTransitions.push("idle");
        }
      });

      try {
        if (trigger === "manual") {
          await expect(run(state, job.id, "force")).resolves.toEqual({
            ok: true,
            ran: false,
            reason: "stopped",
          });
        } else if (trigger === "scheduled") {
          await onTimer(state);
        } else {
          await runMissedJobs(state);
        }
      } finally {
        stopObserving();
      }

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(markerTransitions).toEqual(["queued", "running", "idle"]);
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      const persistedJob = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persistedJob?.state.runningAtMs).toBeUndefined();
      expect(persistedJob?.state.lastError).toBe("prior failure");
    },
  );

  it("does not revive a pre-stop manual activation when the scheduler immediately restarts", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:03.125Z");
    const job = createDueIsolatedJob({
      id: "manual-activation-retired-by-restart",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    job.state.lastError = "prior failure";
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    let now = dueAt;
    let restart: Promise<void> | undefined;
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    const stopObserving = observeCronJobWrites(job.id, ({ queuedAtMs, runningAtMs }) => {
      if (queuedAtMs === dueAt) {
        now = dueAt + 1;
      } else if (runningAtMs === dueAt + 1 && !restart) {
        stop(state);
        restart = start(state);
      }
    });

    try {
      await expect(run(state, job.id, "force")).resolves.toEqual({
        ok: true,
        ran: false,
        reason: "stopped",
      });
      await restart;

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      const persisted = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persisted?.state.runningAtMs).toBeUndefined();
      expect(persisted?.state.lastError).toBe("prior failure");
      const receipt = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
        )
        .get(cronStoreKey(store.storePath), job.id) as { status: string } | undefined;
      expect(receipt?.status).toBe("skipped");
    } finally {
      stopObserving();
      await restart;
      stop(state);
    }
  });

  it("rejects an activated manual run when its scheduler restarts before payload dispatch", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:03.150Z");
    const job = createDueIsolatedJob({
      id: "manual-dispatch-retired-by-restart",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    let restart: Promise<void> | undefined;
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      onEvent: (event) => {
        if (event.action === "started" && !restart) {
          stop(state);
          restart = start(state);
        }
      },
    });

    try {
      await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      await restart;

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      const receipt = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
        )
        .get(cronStoreKey(store.storePath), job.id) as { status: string } | undefined;
      expect(receipt?.status).toBe("error");
    } finally {
      await restart;
      stop(state);
    }
  });

  it.each(["manual", "scheduled", "startup"] as const)(
    "retries %s cleanup when stop wins the reservation write",
    async (trigger) => {
      const store = opsRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.250Z");
      const job = createDueIsolatedJob({
        id: `stopped-during-${trigger}-reservation`,
        nowMs: dueAt,
        nextRunAtMs: trigger === "manual" ? dueAt + 3_600_000 : dueAt,
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
      let reservationPersisted = false;
      let cleanupFailed = false;
      const stopObserving = observeCronJobWrites(job.id, ({ queuedAtMs }) => {
        if (reservationPersisted && !cleanupFailed && queuedAtMs === undefined) {
          cleanupFailed = true;
          throw new Error("reservation cleanup persist failed");
        }
        if (!reservationPersisted && queuedAtMs === dueAt) {
          reservationPersisted = true;
          stop(state);
        }
      });

      try {
        if (trigger === "manual") {
          await expect(run(state, job.id, "force")).resolves.toEqual({
            ok: true,
            ran: false,
            reason: "stopped",
          });
        } else if (trigger === "scheduled") {
          await onTimer(state);
        } else {
          await expect(runMissedJobs(state)).rejects.toThrow("reservation cleanup persist failed");
        }
      } finally {
        stopObserving();
      }

      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      expect(
        (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id)?.state
          .runningAtMs,
      ).toBeUndefined();
    },
  );

  it.each(["manual", "scheduled", "startup"] as const)(
    "cleans a %s reservation after activation persistence fails",
    async (trigger) => {
      const store = opsRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.500Z");
      const job = createDueIsolatedJob({
        id: `failed-${trigger}-activation-persist`,
        nowMs: dueAt,
        nextRunAtMs: trigger === "manual" ? dueAt + 3_600_000 : dueAt,
      });
      job.state.lastError = "prior failure";
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      let now = dueAt;
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });
      let reservationPersisted = false;
      let activationFailed = false;
      const stopObserving = observeCronJobWrites(job.id, ({ queuedAtMs, runningAtMs }) => {
        if (reservationPersisted && !activationFailed && runningAtMs === dueAt + 1) {
          activationFailed = true;
          throw new Error("activation persist failed");
        }
        if (!reservationPersisted && queuedAtMs === dueAt) {
          reservationPersisted = true;
          now = dueAt + 1;
        }
      });

      try {
        const operation =
          trigger === "manual"
            ? run(state, job.id, "force")
            : trigger === "scheduled"
              ? onTimer(state)
              : runMissedJobs(state);
        await expect(operation).rejects.toThrow("activation persist failed");
      } finally {
        stopObserving();
      }

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      const persistedJob = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persistedJob?.state.runningAtMs).toBeUndefined();
      expect(persistedJob?.state.lastError).toBe("prior failure");
    },
  );

  it.each(["manual", "scheduled", "startup"] as const)(
    "retries %s reservation cleanup after a persistence failure",
    async (trigger) => {
      const store = opsRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.750Z");
      const job = createDueIsolatedJob({
        id: `failed-${trigger}-cleanup-persist`,
        nowMs: dueAt,
        nextRunAtMs: trigger === "manual" ? dueAt + 3_600_000 : dueAt,
      });
      job.state.lastError = "prior failure";
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      let now = dueAt;
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });
      let reservationPersisted = false;
      let activationPersisted = false;
      let cleanupFailed = false;
      const stopObserving = observeCronJobWrites(job.id, ({ queuedAtMs, runningAtMs }) => {
        if (
          activationPersisted &&
          !cleanupFailed &&
          queuedAtMs === undefined &&
          runningAtMs === undefined
        ) {
          cleanupFailed = true;
          throw new Error("cleanup persist failed");
        }
        if (!reservationPersisted && queuedAtMs === dueAt) {
          reservationPersisted = true;
          now = dueAt + 1;
        } else if (reservationPersisted && runningAtMs === dueAt + 1) {
          activationPersisted = true;
          stop(state);
        }
      });

      try {
        const operation =
          trigger === "manual"
            ? run(state, job.id, "force")
            : trigger === "scheduled"
              ? onTimer(state)
              : runMissedJobs(state);
        await expect(operation).rejects.toThrow("cleanup persist failed");
      } finally {
        stopObserving();
      }

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      const persistedJob = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persistedJob?.state.runningAtMs).toBeUndefined();
      expect(persistedJob?.state.lastError).toBe("prior failure");
    },
  );

  it.each(["manual", "scheduled", "startup"] as const)(
    "releases a %s process claim after terminal cleanup failures",
    async (trigger) => {
      const store = opsRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.875Z");
      const job = createDueIsolatedJob({
        id: `terminal-${trigger}-cleanup-failure`,
        nowMs: dueAt,
        nextRunAtMs: trigger === "manual" ? dueAt + 3_600_000 : dueAt,
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      let now = dueAt;
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      let reservationPersisted = false;
      let activationPersisted = false;
      const stopObserving = observeCronJobWrites(job.id, ({ queuedAtMs, runningAtMs }) => {
        if (activationPersisted && queuedAtMs === undefined && runningAtMs === undefined) {
          throw new Error("terminal cleanup persist failed");
        }
        if (!reservationPersisted && queuedAtMs === dueAt) {
          reservationPersisted = true;
          now = dueAt + 1;
        } else if (reservationPersisted && runningAtMs === dueAt + 1) {
          activationPersisted = true;
          stop(state);
        }
      });

      try {
        const operation =
          trigger === "manual"
            ? run(state, job.id, "force")
            : trigger === "scheduled"
              ? onTimer(state)
              : runMissedJobs(state);
        await expect(operation).rejects.toThrow("terminal cleanup persist failed");
      } finally {
        stopObserving();
      }

      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      expect(
        (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id)?.state
          .runningAtMs,
      ).toBe(dueAt + 1);
    },
  );
});
