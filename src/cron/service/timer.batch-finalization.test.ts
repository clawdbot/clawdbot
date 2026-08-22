// Completed cron work must become durable before unrelated batch work drains.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { listTaskRecordsUnsorted } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { isCronJobActive, markCronJobActive } from "../active-jobs.js";
import { createCronExecutionId } from "../run-id.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
import type { CronJob } from "../types.js";
import { start, stop } from "./ops-lifecycle.js";
import { add, remove } from "./ops-mutations.js";
import { createCronServiceState } from "./state.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";
import {
  createCompletedCronRunOutcomeDrain,
  finalizeCompletedCronRunOutcomes,
} from "./timer-outcome-finalization.js";
import { authorCronRunCompletion, runMissedJobs } from "./timer.js";
import { onTimer } from "./timer.test-support.js";

const fixtures = setupCronRegressionFixtures({
  prefix: "cron-service-batch-finalization-",
});

afterEach(() => {
  resetTaskRegistryForTests();
});

type BatchTrigger = "scheduled" | "startup";

function createBatchState(params: {
  storePath: string;
  nowMs: number;
  runIsolatedAgentJob: Parameters<typeof createCronServiceState>[0]["runIsolatedAgentJob"];
  concurrency?: number;
  onEvent?: Parameters<typeof createCronServiceState>[0]["onEvent"];
  isAgentAvailable?: Parameters<typeof createCronServiceState>[0]["isAgentAvailable"];
}) {
  const state = createCronServiceState({
    cronEnabled: true,
    storePath: params.storePath,
    log: noopLogger,
    nowMs: () => params.nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: params.runIsolatedAgentJob,
    isAgentAvailable: params.isAgentAvailable,
    maxMissedJobsPerRestart: 40,
    onEvent: params.onEvent,
  });
  if (params.concurrency !== undefined) {
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - params.concurrency;
  }
  return state;
}

function startBatch(
  trigger: BatchTrigger,
  state: ReturnType<typeof createCronServiceState>,
): Promise<void> {
  return trigger === "scheduled" ? onTimer(state) : runMissedJobs(state);
}

function findCronTask(jobId: string) {
  return listTaskRecordsUnsorted().find(
    (task) => task.runtime === "cron" && task.sourceId === jobId,
  );
}

function authorOutcome(
  state: ReturnType<typeof createCronServiceState>,
  outcome: Omit<TimedCronRunOutcome, "completionStatus" | "deliveryState">,
) {
  return authorCronRunCompletion(state, outcome.job, outcome);
}

describe("cron batch outcome finalization", () => {
  it.each([
    { trigger: "scheduled", installSuccessor: false },
    { trigger: "scheduled", installSuccessor: true },
    { trigger: "startup", installSuccessor: false },
    { trigger: "startup", installSuccessor: true },
  ] as const)(
    "supersedes a stale $trigger outcome (successor=$installSuccessor)",
    async ({ trigger, installSuccessor }) => {
      const store = fixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:04:59.750Z");
      const successorAt = dueAt + 1;
      const job = createDueIsolatedJob({
        id: `${trigger}-supersede-preserves-successor`,
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      const runStarted = createDeferred();
      const releaseRun = createDeferred<{ status: "ok"; summary: string }>();
      let ownerAvailable = true;
      const state = createBatchState({
        storePath: store.storePath,
        nowMs: dueAt,
        isAgentAvailable: () => ownerAvailable,
        runIsolatedAgentJob: vi.fn(async () => {
          runStarted.resolve();
          return await releaseRun.promise;
        }),
      });
      const batch = startBatch(trigger, state);

      try {
        await runStarted.promise;
        if (installSuccessor) {
          const successorStore = await loadCronStore(store.storePath);
          successorStore.jobs[0]!.state.runningAtMs = successorAt;
          await saveCronStore(store.storePath, successorStore);
        }
        ownerAvailable = false;
        releaseRun.resolve({ status: "ok", summary: "stale completion" });
        await batch;

        expect((await loadCronStore(store.storePath)).jobs[0]?.state.runningAtMs).toBe(
          installSuccessor ? successorAt : undefined,
        );
        const receipt = openOpenClawStateDatabase()
          .db.prepare(
            "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
          )
          .get(cronStoreKey(store.storePath), job.id) as { status: string } | undefined;
        expect(receipt?.status).toBe("superseded");
      } finally {
        ownerAvailable = false;
        releaseRun.resolve({ status: "ok", summary: "stale completion" });
        await batch;
        if (state.timer) {
          clearTimeout(state.timer);
        }
      }
    },
  );

  it.each(["scheduled", "startup"] as const)(
    "recovers one finalized %s run when admission advances its execution clock",
    async (trigger) => {
      const store = fixtures.makeStorePath();
      const reservedAt = Date.parse("2026-02-06T10:05:00.250Z");
      const startedAt = reservedAt + 7;
      const job = createDueIsolatedJob({
        id: `${trigger}-recover-advanced-execution-clock`,
        nowMs: reservedAt,
        nextRunAtMs: reservedAt,
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      let now = reservedAt;
      let reservationPersisted = false;
      let terminalWriteRejected = false;
      const events: Array<{ action: string; jobId: string; status?: string }> = [];
      const runIsolatedAgentJob = vi.fn(async () => ({
        status: "ok" as const,
        summary: "finished before terminal store failure",
      }));
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
        onEvent: (event) => events.push(event),
      });
      const database = openOpenClawStateDatabase().db;
      const functionName = `observe_advanced_clock_${trigger}`;
      const triggerName = `observe_advanced_clock_${trigger}`;
      database.function(functionName, (writtenJobId, stateJson) => {
        if (writtenJobId !== job.id || typeof stateJson !== "string") {
          return 0;
        }
        const persistedState = JSON.parse(stateJson) as CronJob["state"];
        if (!reservationPersisted && persistedState.queuedAtMs === reservedAt) {
          reservationPersisted = true;
          now = startedAt;
        } else if (!terminalWriteRejected && persistedState.lastRunStatus === "ok") {
          terminalWriteRejected = true;
          throw new Error("cron terminal write failed");
        }
        return 0;
      });
      database.exec(`
        CREATE TEMP TRIGGER ${triggerName}
        AFTER UPDATE ON cron_jobs
        BEGIN
          SELECT ${functionName}(NEW.job_id, NEW.state_json);
        END;
      `);

      let recoveryState: ReturnType<typeof createCronServiceState> | undefined;
      try {
        await expect(startBatch(trigger, state)).rejects.toThrow("cron terminal write failed");
        expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
        expect((await loadCronStore(store.storePath)).jobs[0]?.state.runningAtMs).toBe(startedAt);

        const task = findCronTask(job.id);
        expect(task).toMatchObject({
          runId: expect.stringMatching(new RegExp(`^${createCronExecutionId(job.id, startedAt)}:`)),
          startedAt,
          status: "succeeded",
          terminalSummary: "finished before terminal store failure",
        });
        expect(events.filter((event) => event.action === "finished")).toEqual([]);

        database.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
        recoveryState = createCronServiceState({
          cronEnabled: true,
          storePath: store.storePath,
          log: noopLogger,
          nowMs: () => startedAt + 1,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob,
          onEvent: (event) => events.push(event),
        });
        await start(recoveryState);

        expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
        expect(
          listTaskRecordsUnsorted().filter(
            (record) => record.runtime === "cron" && record.sourceId === job.id,
          ),
        ).toEqual([expect.objectContaining({ runId: task?.runId, status: "succeeded" })]);
        expect(
          readCronTaskRunHistoryPage({
            storeKey: cronStoreKey(store.storePath),
            jobId: job.id,
          }).entries,
        ).toEqual([
          expect.objectContaining({
            jobId: job.id,
            runAtMs: startedAt,
            status: "ok",
            summary: "finished before terminal store failure",
          }),
        ]);
        expect((await loadCronStore(store.storePath)).jobs[0]).toMatchObject({
          enabled: false,
          state: { lastRunAtMs: startedAt, lastRunStatus: "ok", lastStatus: "ok" },
        });
        expect(events.filter((event) => event.action === "finished")).toHaveLength(0);
      } finally {
        database.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
        stop(state);
        if (recoveryState) {
          stop(recoveryState);
        }
      }
    },
  );

  it.each([
    { trigger: "scheduled", deleteAfterRun: false },
    { trigger: "scheduled", deleteAfterRun: true },
    { trigger: "startup", deleteAfterRun: false },
    { trigger: "startup", deleteAfterRun: true },
  ] as const)(
    "does not apply a removed $trigger run to a same-id replacement (deleteAfterRun=$deleteAfterRun)",
    async ({ trigger, deleteAfterRun }) => {
      const store = fixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:00.750Z");
      const replacementAt = dueAt + 60 * 60_000;
      const original = createDueIsolatedJob({
        id: `removed-${trigger}-replacement-${deleteAfterRun}`,
        nowMs: dueAt,
        nextRunAtMs: dueAt,
        deleteAfterRun,
      });
      original.name = "removed original scheduled job";
      await saveCronStore(store.storePath, { version: 1, jobs: [original] });

      const started = createDeferred();
      const release = createDeferred<{ status: "ok"; summary: string }>();
      const events: Array<{ action: string; jobId: string; job?: CronJob }> = [];
      const state = createBatchState({
        storePath: store.storePath,
        nowMs: dueAt,
        runIsolatedAgentJob: vi.fn(async () => {
          started.resolve();
          return await release.promise;
        }),
        onEvent: (event) => events.push(event),
      });
      const batch = startBatch(trigger, state);

      try {
        await started.promise;
        await expect(remove(state, original.id)).resolves.toEqual({ ok: true, removed: true });
        await add(state, {
          id: original.id,
          name: "independent replacement scheduled job",
          enabled: true,
          deleteAfterRun,
          schedule: { kind: "at", at: new Date(replacementAt).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "run only the replacement occurrence" },
          delivery: { mode: "none" },
        });

        release.resolve({ status: "ok", summary: "removed original completed" });
        await batch;

        for (const jobs of [state.store?.jobs ?? [], (await loadCronStore(store.storePath)).jobs]) {
          const replacement = jobs.find((job) => job.id === original.id);
          expect(replacement).toMatchObject({
            id: original.id,
            name: "independent replacement scheduled job",
            enabled: true,
            deleteAfterRun,
            state: { nextRunAtMs: replacementAt },
          });
          expect(replacement?.state.lastRunAtMs).toBeUndefined();
          expect(replacement?.state.lastRunStatus).toBeUndefined();
          expect(replacement?.state.lastStatus).toBeUndefined();
          expect(replacement?.state.runningAtMs).toBeUndefined();
        }
        expect(
          events.filter((event) => event.action === "finished" && event.jobId === original.id),
        ).toEqual([
          expect.objectContaining({
            job: expect.objectContaining({ name: "removed original scheduled job" }),
          }),
        ]);
        expect(isCronJobActive(original.id)).toBe(false);
      } finally {
        release.resolve({ status: "ok", summary: "removed original completed" });
        await batch;
        if (state.timer) {
          clearTimeout(state.timer);
        }
      }
    },
  );

  it("coalesces simultaneously finished outcomes into one durable write", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
    const jobs = ["coalesced-first", "coalesced-second"].map((id) => {
      const job = createDueIsolatedJob({ id, nowMs: dueAt, nextRunAtMs: dueAt });
      job.state.runningAtMs = dueAt;
      return job;
    });
    await saveCronStore(store.storePath, { version: 1, jobs });

    const state = createBatchState({
      storePath: store.storePath,
      nowMs: dueAt,
      runIsolatedAgentJob: vi.fn(),
    });
    const outcomeDrain = createCompletedCronRunOutcomeDrain(state);

    for (const job of jobs) {
      outcomeDrain.enqueue(
        authorOutcome(state, {
          jobId: job.id,
          job,
          activeJobMarker: markCronJobActive(job.id),
          status: "ok",
          startedAt: dueAt,
          endedAt: dueAt,
        }),
      );
    }

    expect(await outcomeDrain.flush()).toHaveLength(jobs.length);
    for (const job of jobs) {
      expect(isCronJobActive(job.id)).toBe(false);
    }
  });

  it("notifies the owning agent once after a recurring auto-disable is durable", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-08-01T15:00:00.000Z");
    const job = createDueIsolatedJob({
      id: "recurring-auto-disable-notification",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    job.name = "Recurring report";
    job.schedule = { kind: "every", everyMs: 60_000, anchorMs: dueAt - 60_000 };
    job.state.consecutiveErrors = 9;
    job.state.runningAtMs = dueAt;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const order: string[] = [];
    const enqueueSystemEvent = vi.fn(
      (
        _text: string,
        _opts?: {
          agentId?: string;
          sessionKey?: string;
          contextKey?: string;
          deliveryContext?: unknown;
        },
      ) => {
        const persisted = openOpenClawStateDatabase()
          .db.prepare("SELECT enabled FROM cron_jobs WHERE store_key = ? AND job_id = ?")
          .get(cronStoreKey(store.storePath), job.id) as { enabled: number };
        expect(persisted.enabled).toBe(0);
        order.push("notify");
      },
    );
    const requestHeartbeat = vi.fn(() => {
      order.push("heartbeat");
    });
    const deliveryContext = { channel: "discord", to: "channel-1", accountId: "default" };
    const resolveOriginDeliveryContext = vi.fn(() => deliveryContext);
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt + 10,
      defaultAgentId: "main",
      enqueueSystemEvent,
      resolveOriginDeliveryContext,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(),
    });
    await finalizeCompletedCronRunOutcomes(state, [
      authorOutcome(state, {
        jobId: job.id,
        job: structuredClone(job),
        activeJobMarker: markCronJobActive(job.id),
        status: "error",
        error: "cron: job execution timed out at /private/agent/work",
        startedAt: dueAt,
        endedAt: dueAt + 10,
      }),
    ]);

    expect(order).toEqual(["notify", "heartbeat"]);
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining(`openclaw automations enable ${job.id}`),
      {
        agentId: "main",
        sessionKey: undefined,
        contextKey: `cron:${job.id}:auto-disabled`,
        deliveryContext,
      },
    );
    expect(enqueueSystemEvent.mock.calls[0]?.[0]).toContain("Recurring report");
    expect(enqueueSystemEvent.mock.calls[0]?.[0]).toContain(job.id);
    expect(enqueueSystemEvent.mock.calls[0]?.[0]).toContain("10 consecutive run failures");
    expect(enqueueSystemEvent.mock.calls[0]?.[0]).toContain("Cause: timeout");
    expect(enqueueSystemEvent.mock.calls[0]?.[0]).not.toContain("/private/agent/work");
    expect(resolveOriginDeliveryContext).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: undefined,
    });
    expect(requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ reason: `cron:${job.id}:auto-disabled`, agentId: "main" }),
    );
    expect((await loadCronStore(store.storePath)).jobs[0]).toMatchObject({
      enabled: false,
      state: {
        consecutiveErrors: 10,
        lastError: "cron: job execution timed out at /private/agent/work",
        autoDisabled: {
          reason: "consecutive-failures",
          atMs: dueAt + 10,
          consecutiveErrors: 10,
        },
      },
    });
  });

  it("records and notifies a Date-overflow auto-disable only after persistence", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-08-01T15:02:00.000Z");
    const job = createDueIsolatedJob({
      id: "date-overflow-auto-disable",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    job.schedule = { kind: "every", everyMs: 60_000, anchorMs: dueAt - 60_000 };
    job.pacing = { min: "1s" };
    job.state.runningAtMs = dueAt;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const order: string[] = [];
    const enqueueSystemEvent = vi.fn((_text: string) => {
      const persisted = openOpenClawStateDatabase()
        .db.prepare("SELECT enabled FROM cron_jobs WHERE store_key = ? AND job_id = ?")
        .get(cronStoreKey(store.storePath), job.id) as { enabled: number };
      expect(persisted.enabled).toBe(0);
      order.push("notify");
    });
    const requestHeartbeat = vi.fn(() => {
      order.push("heartbeat");
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt + 10,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(),
    });
    const finalized = await finalizeCompletedCronRunOutcomes(state, [
      authorOutcome(state, {
        jobId: job.id,
        job: structuredClone(job),
        activeJobMarker: markCronJobActive(job.id),
        status: "ok",
        startedAt: dueAt,
        endedAt: dueAt + 10,
        nextCheck: { delayMs: MAX_DATE_TIMESTAMP_MS },
      }),
    ]);

    expect(finalized).toHaveLength(1);
    expect(state.store?.jobs[0]?.enabled).toBe(false);
    expect(state.store?.jobs[0]?.state.nextRunAtMs).toBeUndefined();
    expect(order).toEqual(["notify", "heartbeat"]);
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent.mock.calls[0]?.[0]).toContain(
      "Check automation history for details.",
    );
    expect(enqueueSystemEvent.mock.calls[0]?.[0]).not.toContain(
      "next run is outside the supported Date range",
    );
    expect(requestHeartbeat).toHaveBeenCalledOnce();
    expect((await loadCronStore(store.storePath)).jobs[0]).toMatchObject({
      enabled: false,
      state: {
        autoDisabled: {
          reason: "schedule-errors",
          atMs: dueAt + 10,
          consecutiveErrors: 1,
        },
      },
    });
  });

  it("rolls back recurring auto-disable without notifying when persistence fails", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-08-01T15:05:00.000Z");
    const job = createDueIsolatedJob({
      id: "recurring-auto-disable-rollback",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    job.schedule = { kind: "every", everyMs: 60_000, anchorMs: dueAt - 60_000 };
    job.state.consecutiveErrors = 9;
    job.state.runningAtMs = dueAt;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt + 10,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TEMP TRIGGER reject_auto_disable_terminal_write
      BEFORE UPDATE ON cron_jobs
      WHEN NEW.job_id = '${job.id}'
        AND json_extract(NEW.state_json, '$.autoDisabled') IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'terminal write failed');
      END;
    `);

    try {
      await expect(
        finalizeCompletedCronRunOutcomes(state, [
          authorOutcome(state, {
            jobId: job.id,
            job: structuredClone(job),
            activeJobMarker: markCronJobActive(job.id),
            status: "error",
            error: "tenth failure",
            startedAt: dueAt,
            endedAt: dueAt + 10,
          }),
        ]),
      ).rejects.toThrow("terminal write failed");
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(state.deps.requestHeartbeat).not.toHaveBeenCalled();
      expect(state.store?.jobs[0]?.enabled).toBe(true);
      expect(state.store?.jobs[0]?.state.autoDisabled).toBeUndefined();
      expect((await loadCronStore(store.storePath)).jobs[0]?.enabled).toBe(true);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_auto_disable_terminal_write");
    }
  });

  it("clears retired setup-timeout markers without rewriting stopped-service state", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.250Z");
    const job = createDueIsolatedJob({
      id: "stopped-setup-timeout-marker",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    job.state.runningAtMs = dueAt;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createBatchState({
      storePath: store.storePath,
      nowMs: dueAt,
      runIsolatedAgentJob: vi.fn(),
    });
    state.stopped = true;
    const activeJobMarker = markCronJobActive(job.id);

    expect(
      await finalizeCompletedCronRunOutcomes(
        state,
        [
          authorOutcome(state, {
            jobId: job.id,
            job,
            activeJobMarker,
            status: "error",
            error: "setup timed out before runner start",
            startedAt: dueAt,
            endedAt: dueAt,
          }),
        ],
        { clearOnFailure: false, discardWhenStopped: true },
      ),
    ).toEqual([]);
    expect(isCronJobActive(job.id)).toBe(false);
    expect((await loadCronStore(store.storePath)).jobs[0]?.state.runningAtMs).toBe(dueAt);
  });

  it("persists a completed scheduled run when its service stops during execution", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.375Z");
    const job = createDueIsolatedJob({
      id: "scheduled-completion-during-stop",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const runStarted = createDeferred();
    const releaseRun = createDeferred<{ status: "ok"; summary: string }>();
    const state = createBatchState({
      storePath: store.storePath,
      nowMs: dueAt,
      runIsolatedAgentJob: vi.fn(async () => {
        runStarted.resolve();
        return await releaseRun.promise;
      }),
    });
    const batch = onTimer(state);

    try {
      await runStarted.promise;
      state.stopped = true;
      releaseRun.resolve({ status: "ok", summary: "finished during shutdown" });
      await batch;

      const persistedJob = (await loadCronStore(store.storePath)).jobs[0];
      expect(persistedJob?.state.lastRunStatus).toBe("ok");
      expect(persistedJob?.state.runningAtMs).toBeUndefined();
      expect(findCronTask(job.id)?.status).toBe("succeeded");
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
      expect(isCronJobActive(job.id)).toBe(false);
    } finally {
      releaseRun.resolve({ status: "ok", summary: "finished during shutdown" });
      await batch;
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
  });

  it.each(["scheduled", "startup"] as const)(
    "drains later %s completions after a sibling terminal write fails",
    async (trigger) => {
      const store = fixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:01.750Z");
      const first = createDueIsolatedJob({
        id: `${trigger}-failed-terminal-write`,
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      });
      const second = createDueIsolatedJob({
        id: `${trigger}-completion-after-terminal-failure`,
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [first, second] });

      const terminalWriteFailed = createDeferred();
      const secondStarted = createDeferred();
      const releaseSecond = createDeferred<{ status: "ok"; summary: string }>();
      let rejectedTerminalWrite = false;
      const database = openOpenClawStateDatabase().db;
      const functionName = `reject_sibling_terminal_${trigger}`;
      const triggerName = `reject_sibling_terminal_${trigger}`;
      database.function(functionName, (jobId, stateJson) => {
        if (jobId === first.id && typeof stateJson === "string") {
          const persistedState = JSON.parse(stateJson) as CronJob["state"];
          if (!rejectedTerminalWrite && persistedState.lastRunStatus === "ok") {
            rejectedTerminalWrite = true;
            terminalWriteFailed.resolve();
            throw new Error("cron terminal write failed");
          }
        }
        return 0;
      });
      database.exec(`
        CREATE TEMP TRIGGER ${triggerName}
        AFTER UPDATE ON cron_jobs
        BEGIN
          SELECT ${functionName}(NEW.job_id, NEW.state_json);
        END;
      `);
      const state = createBatchState({
        storePath: store.storePath,
        nowMs: dueAt,
        runIsolatedAgentJob: vi.fn(async ({ job }) => {
          if (job.id === second.id) {
            secondStarted.resolve();
            return await releaseSecond.promise;
          }
          return { status: "ok" as const, summary: "first completion" };
        }),
      });

      const completion = startBatch(trigger, state).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await terminalWriteFailed.promise;
        await secondStarted.promise;
        releaseSecond.resolve({ status: "ok", summary: "later completion" });

        const failure = await completion;
        expect(failure).toEqual(expect.objectContaining({ message: "cron terminal write failed" }));
        const persistedSecond = (await loadCronStore(store.storePath)).jobs.find(
          (job) => job.id === second.id,
        );
        expect(persistedSecond?.state.lastRunStatus).toBe("ok");
        expect(persistedSecond?.state.runningAtMs).toBeUndefined();
        expect(state.queuedRunReservationsByJobId.size).toBe(0);
        expect(isCronJobActive(first.id)).toBe(false);
        expect(isCronJobActive(second.id)).toBe(false);
      } finally {
        releaseSecond.resolve({ status: "ok", summary: "later completion" });
        await completion;
        database.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
        if (state.timer) {
          clearTimeout(state.timer);
        }
      }
    },
  );

  it("releases unstarted startup reservations when terminal finalization fails", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.875Z");
    const first = createDueIsolatedJob({
      id: "startup-failed-write-before-stop",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    const unstarted = createDueIsolatedJob({
      id: "startup-unstarted-after-failed-write",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [first, unstarted] });

    let rejectedTerminalWrite = false;
    const database = openOpenClawStateDatabase().db;
    database.function("reject_startup_terminal", (jobId, stateJson) => {
      if (jobId === first.id && typeof stateJson === "string") {
        const persistedState = JSON.parse(stateJson) as CronJob["state"];
        if (!rejectedTerminalWrite && persistedState.lastRunStatus === "ok") {
          rejectedTerminalWrite = true;
          stop(state);
          throw new Error("startup terminal write failed");
        }
      }
      return 0;
    });
    database.exec(`
      CREATE TEMP TRIGGER reject_startup_terminal
      AFTER UPDATE ON cron_jobs
      BEGIN
        SELECT reject_startup_terminal(NEW.job_id, NEW.state_json);
      END;
    `);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "completed before service stop",
    }));
    const state = createBatchState({
      storePath: store.storePath,
      nowMs: dueAt,
      runIsolatedAgentJob,
    });

    try {
      await expect(runMissedJobs(state)).rejects.toThrow("startup terminal write failed");
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      const persistedUnstarted = (await loadCronStore(store.storePath)).jobs.find(
        (job) => job.id === unstarted.id,
      );
      expect(persistedUnstarted?.state.queuedAtMs).toBeUndefined();
      expect(persistedUnstarted?.state.runningAtMs).toBeUndefined();
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
      expect(isCronJobActive(first.id)).toBe(false);
      expect(isCronJobActive(unstarted.id)).toBe(false);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_startup_terminal");
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
  });

  it.each([
    { trigger: "scheduled" as const, concurrency: 1, deleteAfterRun: false },
    { trigger: "scheduled" as const, concurrency: 1, deleteAfterRun: true },
    { trigger: "scheduled" as const, concurrency: 2, deleteAfterRun: false },
    { trigger: "scheduled" as const, concurrency: 2, deleteAfterRun: true },
    { trigger: "startup" as const, concurrency: 1, deleteAfterRun: false },
    { trigger: "startup" as const, concurrency: 1, deleteAfterRun: true },
  ])(
    "persists a completed $trigger job before its sibling drains (concurrency=$concurrency, deleteAfterRun=$deleteAfterRun)",
    async ({ trigger, concurrency, deleteAfterRun }) => {
      const store = fixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:02.000Z");
      const first = createDueIsolatedJob({
        id: `${trigger}-finished-${concurrency}-${deleteAfterRun}`,
        nowMs: dueAt,
        nextRunAtMs: dueAt,
        deleteAfterRun,
      });
      const second = createDueIsolatedJob({
        id: `${trigger}-blocked-${concurrency}-${deleteAfterRun}`,
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [first, second] });

      const secondStarted = createDeferred();
      const releaseSecond = createDeferred<{ status: "ok"; summary: string }>();
      const events: Array<{ action: string; jobId: string; status?: string }> = [];
      const state = createBatchState({
        storePath: store.storePath,
        nowMs: dueAt,
        concurrency,
        onEvent: (event) => events.push(event),
        runIsolatedAgentJob: vi.fn(async ({ job }) => {
          if (job.id === second.id) {
            secondStarted.resolve();
            return await releaseSecond.promise;
          }
          return { status: "ok" as const, summary: "finished first" };
        }),
      });

      const batch = startBatch(trigger, state);
      try {
        await secondStarted.promise;
        await vi.waitFor(async () => {
          const jobs = (await loadCronStore(store.storePath)).jobs;
          const persistedFirst = jobs.find((job) => job.id === first.id);
          if (deleteAfterRun) {
            expect(persistedFirst).toBeUndefined();
          } else {
            expect(persistedFirst?.state.lastRunStatus).toBe("ok");
            expect(persistedFirst?.state.runningAtMs).toBeUndefined();
          }
          expect(jobs.find((job) => job.id === second.id)?.state.runningAtMs).toBe(dueAt);
        });

        expect(findCronTask(first.id)?.status).toBe("succeeded");
        expect(findCronTask(second.id)?.status).toBe("running");
        expect(isCronJobActive(first.id)).toBe(false);
        expect(isCronJobActive(second.id)).toBe(true);
        expect(events).toContainEqual(
          expect.objectContaining({ action: "finished", jobId: first.id, status: "ok" }),
        );
        if (deleteAfterRun) {
          expect(events).toContainEqual(
            expect.objectContaining({ action: "removed", jobId: first.id }),
          );
        }
      } finally {
        releaseSecond.resolve({ status: "ok", summary: "finished second" });
        await batch;
        if (state.timer) {
          clearTimeout(state.timer);
        }
      }

      expect(findCronTask(second.id)?.status).toBe("succeeded");
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
    },
  );

  it.each(["scheduled", "startup"] as const)(
    "durably finalizes a large %s batch while its final run remains active",
    async (trigger) => {
      const store = fixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
      const jobCount = 32;
      const jobs: CronJob[] = Array.from({ length: jobCount }, (_, index) =>
        createDueIsolatedJob({
          id: `${trigger}-stress-${String(index).padStart(2, "0")}`,
          nowMs: dueAt,
          nextRunAtMs: dueAt,
        }),
      );
      await saveCronStore(store.storePath, { version: 1, jobs });

      const lastJob = jobs.at(-1);
      if (!lastJob) {
        throw new Error("expected a final cron stress-test job");
      }
      const finalRunStarted = createDeferred();
      const releaseFinalRun = createDeferred<{ status: "ok"; summary: string }>();
      const state = createBatchState({
        storePath: store.storePath,
        nowMs: dueAt,
        runIsolatedAgentJob: vi.fn(async ({ job }) => {
          if (job.id === lastJob.id) {
            finalRunStarted.resolve();
            return await releaseFinalRun.promise;
          }
          return { status: "ok" as const, summary: `finished ${job.id}` };
        }),
      });

      const batch = startBatch(trigger, state);
      try {
        await finalRunStarted.promise;
        await vi.waitFor(async () => {
          const persistedJobs = (await loadCronStore(store.storePath)).jobs;
          expect(
            persistedJobs.filter(
              (job) => job.id !== lastJob.id && job.state.lastRunStatus === "ok",
            ),
          ).toHaveLength(jobCount - 1);
          expect(persistedJobs.find((job) => job.id === lastJob.id)?.state.runningAtMs).toBe(dueAt);
        });

        for (const job of jobs.slice(0, -1)) {
          expect(findCronTask(job.id)?.status).toBe("succeeded");
          expect(isCronJobActive(job.id)).toBe(false);
        }
        expect(findCronTask(lastJob.id)?.status).toBe("running");
        expect(isCronJobActive(lastJob.id)).toBe(true);
      } finally {
        releaseFinalRun.resolve({ status: "ok", summary: "finished final job" });
        await batch;
        if (state.timer) {
          clearTimeout(state.timer);
        }
      }

      expect(findCronTask(lastJob.id)?.status).toBe("succeeded");
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
    },
  );
});
