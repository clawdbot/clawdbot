// Cron service ops tests cover high-level service operations and state transitions.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import * as taskExecutor from "../../tasks/task-executor.js";
import { findTaskByRunId, listTaskRecordsUnsorted } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { formatTaskStatusDetail } from "../../tasks/task-status.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as cronSchedule from "../schedule.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import * as cronStoreModule from "../store.js";
import { loadCronJobsStoreWithConfigJobs, loadCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { add, list, remove, run, start, stop, update } from "./ops.js";
import { createCronServiceState, type CronEvent } from "./state.js";
import { tryCreateCronTaskRun, tryFinishCronTaskRun } from "./task-runs.js";
import { runMissedJobs } from "./timer.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-ops-seam",
});

async function withStateDirForStorePath<T>(
  storePath: string,
  runWithStateDir: () => Promise<T>,
): Promise<T> {
  const stateRoot = path.dirname(path.dirname(storePath));
  resetTaskRegistryForTests();
  try {
    return await withEnvAsync({ OPENCLAW_STATE_DIR: stateRoot }, runWithStateDir);
  } finally {
    resetTaskRegistryForTests();
  }
}

function createTimedOutIsolatedCronState(params: { storePath: string; now: number }) {
  return createCronServiceState({
    storePath: params.storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => params.now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => {
      throw new Error("cron: job execution timed out");
    }),
  });
}

function createOkIsolatedCronState(params: {
  storePath: string;
  now: number;
  summary?: string;
  onEvent?: (event: CronEvent) => void;
}) {
  return createCronServiceState({
    storePath: params.storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => params.now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({
      status: "ok" as const,
      ...(params.summary === undefined ? {} : { summary: params.summary }),
    })),
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
}

function createFutureEveryJob(params: { id: string; now: number; nextRunAtMs?: number }): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: params.id },
    state: params.nextRunAtMs === undefined ? {} : { nextRunAtMs: params.nextRunAtMs },
  };
}

function createInterruptedMainJob(now: number): CronJob {
  return {
    id: "startup-interrupted",
    name: "startup interrupted",
    enabled: true,
    createdAtMs: now - 86_400_000,
    updatedAtMs: now - 30 * 60_000,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "should not replay on startup" },
    state: {
      nextRunAtMs: now - 60_000,
      runningAtMs: now - 30 * 60_000,
      lastFailureNotificationDelivered: true,
      lastFailureNotificationDeliveryStatus: "delivered",
    },
  };
}

function createDueIsolatedJob(now: number): CronJob {
  return {
    id: "isolated-timeout",
    name: "isolated timeout",
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "do work" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: now - 1 },
  };
}

async function writeDueIsolatedJobSnapshot(storePath: string, now: number) {
  await writeCronStoreSnapshot({
    storePath,
    jobs: [createDueIsolatedJob(now)],
  });
}

async function writeLegacyCronArraySnapshot(storePath: string, jobs: CronJob[]) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(jobs, null, 2), "utf-8");
}

function insertCronJobRow(storePath: string, job: CronJob) {
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare(
      `INSERT INTO cron_jobs (
        store_key, job_id, name, enabled, created_at_ms, schedule_kind,
        at, every_ms, anchor_ms, schedule_expr, session_target, wake_mode, payload_kind,
        payload_message, delivery_mode, delivery_to, job_json, state_json, updated_at
      ) VALUES (
        $storeKey, $jobId, $name, $enabled, $createdAtMs, $scheduleKind,
        $at, $everyMs, $anchorMs, $scheduleExpr, $sessionTarget, $wakeMode, $payloadKind,
        $payloadMessage, $deliveryMode, $deliveryTo, $jobJson, $stateJson, $updatedAt
      )`,
    ).run({
      $storeKey: path.resolve(storePath),
      $jobId: job.id,
      $name: job.name,
      $enabled: job.enabled ? 1 : 0,
      $createdAtMs: job.createdAtMs,
      $scheduleKind: job.schedule.kind,
      $at: job.schedule.kind === "at" ? job.schedule.at : null,
      $everyMs: job.schedule.kind === "every" ? job.schedule.everyMs : null,
      $anchorMs: job.schedule.kind === "every" ? (job.schedule.anchorMs ?? null) : null,
      $scheduleExpr: job.schedule.kind === "cron" ? job.schedule.expr : null,
      $sessionTarget: job.sessionTarget,
      $wakeMode: job.wakeMode,
      $payloadKind: job.payload.kind,
      $payloadMessage: "message" in job.payload ? job.payload.message : null,
      $deliveryMode: job.delivery ? (job.delivery.mode ?? "announce") : null,
      $deliveryTo: job.delivery?.to ?? null,
      $jobJson: JSON.stringify(job),
      $stateJson: JSON.stringify(job.state),
      $updatedAt: job.updatedAtMs,
    });
  });
}

async function expectDueIsolatedManualRunProgresses(storePath: string, now: number) {
  const state = createOkIsolatedCronState({ storePath, now, summary: "done" });

  await expect(run(state, "isolated-timeout")).resolves.toEqual({ ok: true, ran: true });

  const persisted = (await loadCronStore(storePath)) as {
    jobs: CronJob[];
  };
  expect(persisted.jobs[0]?.state.runningAtMs).toBeUndefined();
  expect(persisted.jobs[0]?.state.lastStatus).toBe("ok");
}

function expectWarnedJob(params: { field: "jobId" | "jobStatus"; value: string; message: string }) {
  const warnCalls = logger.warn.mock.calls as unknown as Array<[Record<string, unknown>, string]>;
  const warning = warnCalls.find(
    ([metadata, message]) => metadata[params.field] === params.value && message === params.message,
  );
  expect(warning?.[0][params.field]).toBe(params.value);
  expect(warning?.[1]).toBe(params.message);
}

function expectTaskRun(params: {
  runId: string;
  runtime: string;
  status: string;
  sourceId: string;
  progressSummary?: string;
}) {
  const task = findCronTaskByBaseRunId(params.runId);
  expect(task?.runtime).toBe(params.runtime);
  expect(task?.status).toBe(params.status);
  expect(task?.sourceId).toBe(params.sourceId);
  if (params.progressSummary !== undefined) {
    expect(task?.progressSummary).toBe(params.progressSummary);
  }
}

function findCronTaskByBaseRunId(baseRunId: string) {
  return (
    findTaskByRunId(baseRunId) ??
    listTaskRecordsUnsorted().find((task) => task.runId?.startsWith(`${baseRunId}:`))
  );
}

function createMissedIsolatedJob(now: number): CronJob {
  return {
    id: "startup-timeout",
    name: "startup timeout",
    enabled: true,
    createdAtMs: now - 86_400_000,
    updatedAtMs: now - 30 * 60_000,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "should timeout" },
    sessionKey: "agent:main:main",
    state: {
      nextRunAtMs: now - 60_000,
    },
  };
}

describe("cron service ops seam coverage", () => {
  it("keeps core add paths on SQLite and leaves legacy JSON for doctor migration", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-05-20T08:00:00.000Z");
    const legacyJobs: CronJob[] = [
      {
        id: "legacy-alpha",
        name: "legacy alpha",
        enabled: true,
        createdAtMs: now - 120_000,
        updatedAtMs: now - 120_000,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "alpha" },
        state: { nextRunAtMs: now + 3_600_000 },
      },
      {
        id: "legacy-beta",
        name: "legacy beta",
        enabled: true,
        createdAtMs: now - 60_000,
        updatedAtMs: now - 60_000,
        schedule: { kind: "every", everyMs: 7_200_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "beta" },
        state: { nextRunAtMs: now + 7_200_000 },
      },
    ];
    await writeLegacyCronArraySnapshot(storePath, legacyJobs);
    const state = createOkIsolatedCronState({ storePath, now });

    const newJob = await add(state, {
      name: "new after upgrade",
      enabled: true,
      schedule: { kind: "every", everyMs: 10_800_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "new" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    const loaded = await loadCronStore(storePath);

    expect(loaded.jobs.map((job) => job.id)).toEqual([newJob.id]);
    expect(await fs.stat(storePath)).toBeTruthy();
    await expect(fs.stat(`${storePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves legacy notify fallback for doctor instead of migrating during startup", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-05-20T09:00:00.000Z");
    const legacyJob = {
      id: "legacy-notify",
      name: "legacy notify",
      enabled: true,
      createdAtMs: now - 60_000,
      updatedAtMs: now - 60_000,
      schedule: { kind: "every", everyMs: 3_600_000, anchorMs: now },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
      delivery: { to: "telegram:chat-1" },
      notify: true,
      state: { nextRunAtMs: now + 3_600_000 },
    } as CronJob & { notify: true };
    insertCronJobRow(storePath, legacyJob);
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { webhook: "https://example.invalid/cron" },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);
    if (state.timer) {
      clearTimeout(state.timer);
    }

    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const persisted = loaded.store.jobs[0] as CronJob & { notify?: unknown };
    expect(persisted.notify).toBeUndefined();
    expect(persisted.delivery).toEqual({
      mode: "announce",
      to: "telegram:chat-1",
    });
    expect(loaded.configJobs[0]?.notify).toBe(true);
    expect(logger.info).not.toHaveBeenCalledWith(
      { storePath },
      "cron: migrated legacy notify fallback jobs before scheduler startup",
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ storePath }),
      "cron: legacy notify fallback jobs need cron.webhook before migration",
    );
  });

  it("start marks interrupted running jobs failed, persists, and arms the timer", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createInterruptedMainJob(now)],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);

    expectWarnedJob({
      field: "jobId",
      value: "startup-interrupted",
      message: "cron: marking interrupted running job failed on startup",
    });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    if (state.timer === undefined) {
      throw new Error("Expected cron service timer");
    }

    const persisted = (await loadCronStore(storePath)) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs[0];
    if (!job) {
      throw new Error("expected persisted cron job");
    }
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.lastStatus).toBe("error");
    expect(job.state.lastRunStatus).toBe("error");
    expect(job.state.lastRunAtMs).toBe(now - 30 * 60_000);
    expect(job.state.lastError).toBe("cron: job interrupted by gateway restart");
    expect(job.state.lastFailureNotificationDelivered).toBeUndefined();
    expect(job.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
    expect(job.state.lastFailureNotificationDeliveryError).toBeUndefined();
    expect((job.state.nextRunAtMs ?? 0) > now).toBe(true);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    const positiveDelays = delays.filter((delay) => delay > 0);
    expect(positiveDelays.length).toBeGreaterThan(0);

    timeoutSpy.mockRestore();
    stop(state);
  });

  it("preserves a finalized canonical task run when startup finds its stale marker", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const reservedAt = now - 30 * 60_000;
    const startedAt = reservedAt + 250;
    const endedAt = startedAt + 4_000;

    await withStateDirForStorePath(storePath, async () => {
      const job = createInterruptedMainJob(now);
      job.trigger = { script: "json({ fire: true })", once: true };
      job.state.triggerState = { cursor: "old" };
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const events: CronEvent[] = [];
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        onEvent: (event) => events.push(structuredClone(event)),
      });
      const taskRunId = tryCreateCronTaskRun({
        state,
        job,
        startedAt,
        runIdStartedAt: reservedAt,
      });
      if (!taskRunId) {
        throw new Error("expected reserved cron task run");
      }

      tryFinishCronTaskRun(state, {
        taskRunId,
        job,
        triggerEval: { fired: true, stateChanged: true, state: { cursor: "new" } },
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "ok",
          summary: "completed before crash",
          delivered: true,
          deliveryStatus: "delivered",
          failureNotificationDelivery: { status: "not-requested" },
          runAtMs: startedAt,
          durationMs: endedAt - startedAt,
          triggerFired: true,
        },
      });

      await start(state);

      expect(findTaskByRunId(taskRunId)).toMatchObject({
        status: "succeeded",
        startedAt,
        terminalSummary: "completed before crash",
        endedAt,
        detail: { kind: "cron-run", status: "ok", triggerFired: true },
      });
      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs[0]).toMatchObject({
        enabled: false,
        state: {
          lastRunAtMs: startedAt,
          lastRunStatus: "ok",
          lastStatus: "ok",
          lastDurationMs: endedAt - startedAt,
          lastDelivered: true,
          lastDeliveryStatus: "delivered",
          lastTriggerEvalAtMs: endedAt,
          lastTriggerFireAtMs: endedAt,
          triggerState: { cursor: "new" },
        },
      });
      expect(persisted.jobs[0]?.state.runningAtMs).toBeUndefined();
      expect(persisted.jobs[0]?.state.lastError).toBeUndefined();
      expect(persisted.jobs[0]?.state.nextRunAtMs).toBeUndefined();
      expect(events.filter((event) => event.action === "finished")).toEqual([]);
      stop(state);
    });
  });

  it("restores finalized failure-alert cooldown without redelivery", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const startedAt = now - 30 * 60_000;
    const endedAt = startedAt + 4_000;

    await withStateDirForStorePath(storePath, async () => {
      const job = createInterruptedMainJob(now);
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const sendCronFailureAlert = vi.fn(async () => undefined);
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { failureAlert: { enabled: true, after: 1, cooldownMs: 60_000 } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        sendCronFailureAlert,
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      tryFinishCronTaskRun(state, {
        job,
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "error",
          error: "provider unavailable",
          runAtMs: startedAt,
          durationMs: endedAt - startedAt,
          nextRunAtMs: now + 30 * 60_000,
        },
      });

      await start(state);

      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs[0]?.state.lastFailureAlertAtMs).toBe(endedAt);
      expect(persisted.jobs[0]?.state.consecutiveErrors).toBe(1);
      expect(sendCronFailureAlert).not.toHaveBeenCalled();
      stop(state);
    });
  });

  it("start persists load-time updatedAtMs repairs to the state sidecar only", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-09T08:00:00.000Z");
    const createdAtMs = now - 86_400_000;
    const nextRunAtMs = Date.parse("2026-04-10T09:00:00.000Z");
    const jobId = "future-sidecar-repair";
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: jobId,
          name: "future sidecar repair",
          enabled: true,
          createdAtMs,
          updatedAtMs: createdAtMs,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "daily" },
          state: { nextRunAtMs },
        },
      ],
    });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    try {
      await start(state);

      const persisted = await loadCronStore(storePath);
      const job = persisted.jobs.find((entry) => entry.id === jobId);

      await expect(fs.stat(`${storePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(job?.updatedAtMs).toBe(createdAtMs);
      expect(job?.state?.nextRunAtMs).toBe(nextRunAtMs);
    } finally {
      stop(state);
    }
  });

  it("keeps manual acknowledgement IDs separate from recoverable task run IDs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeDueIsolatedJobSnapshot(storePath, now);

      const state = createOkIsolatedCronState({ storePath, now, summary: "done" });
      const manualRunId = `manual:isolated-timeout:${now}:1`;

      await expect(
        run(state, "isolated-timeout", "force", { runId: manualRunId }),
      ).resolves.toEqual({
        ok: true,
        ran: true,
      });

      expectTaskRun({
        runId: `cron:isolated-timeout:${now}:${manualRunId}`,
        runtime: "cron",
        status: "succeeded",
        sourceId: "isolated-timeout",
        progressSummary: "Running cron job.",
      });
      expect(findTaskByRunId(manualRunId)).toBeUndefined();
    });
  });

  it("records timed out manual runs as timed_out in the shared task registry", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeDueIsolatedJobSnapshot(storePath, now);

      const state = createTimedOutIsolatedCronState({
        storePath,
        now,
      });

      await run(state, "isolated-timeout");

      expectTaskRun({
        runId: `cron:isolated-timeout:${now}`,
        runtime: "cron",
        status: "timed_out",
        sourceId: "isolated-timeout",
      });
      expect(findCronTaskByBaseRunId(`cron:isolated-timeout:${now}`)?.detail).toMatchObject({
        kind: "cron-run",
        status: "error",
        runAtMs: now,
        durationMs: 0,
      });
    });
  });

  it("records failed manual runs with cron outcome detail", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeDueIsolatedJobSnapshot(storePath, now);
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({
          status: "error" as const,
          error: "provider failed",
          provider: "openai",
          model: "gpt-test",
        })),
      });

      await run(state, "isolated-timeout");

      const task = findCronTaskByBaseRunId(`cron:isolated-timeout:${now}`);
      expect(task).toMatchObject({
        status: "failed",
        error: "provider failed",
        detail: {
          kind: "cron-run",
          status: "error",
          provider: "openai",
          model: "gpt-test",
          runAtMs: now,
          durationMs: 0,
        },
      });
    });
  });

  it("keeps manual cron runs progressing when task ledger creation fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedJob(now)],
    });

    const createTaskRecordSpy = vi
      .spyOn(taskExecutor, "createRunningTaskRun")
      .mockImplementation(() => {
        throw new Error("disk full");
      });

    await expectDueIsolatedManualRunProgresses(storePath, now);
    expectWarnedJob({
      field: "jobId",
      value: "isolated-timeout",
      message: "cron: failed to create task ledger record",
    });

    createTaskRecordSpy.mockRestore();
  });

  it("keeps manual cron cleanup progressing when task ledger updates fail", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeDueIsolatedJobSnapshot(storePath, now);

      const updateTaskRecordSpy = vi
        .spyOn(taskExecutor, "finalizeTaskRunByRunId")
        .mockImplementation(() => {
          throw new Error("disk full");
        });

      try {
        await expectDueIsolatedManualRunProgresses(storePath, now);
        expectWarnedJob({
          field: "jobStatus",
          value: "ok",
          message: "cron: failed to update task ledger record",
        });
      } finally {
        updateTaskRecordSpy.mockRestore();
      }
    });
  });

  it("non-schedule edit preserves nextRunAtMs (#63499)", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-09T08:00:00.000Z");
    const originalNextRunAtMs = Date.parse("2026-04-10T09:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "daily-report",
          name: "daily report",
          enabled: true,
          createdAtMs: now - 86_400_000,
          updatedAtMs: now - 3_600_000,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "daily" },
          state: { nextRunAtMs: originalNextRunAtMs },
        },
      ],
    });

    const state = createOkIsolatedCronState({ storePath, now });

    const updated = await update(state, "daily-report", { description: "edited" });

    expect(updated.description).toBe("edited");
    expect(updated.state.nextRunAtMs).toBe(originalNextRunAtMs);
  });

  it("repairs nextRunAtMs=0 on non-schedule edit (#63499)", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-09T08:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "broken-job",
          name: "broken",
          enabled: true,
          createdAtMs: now - 86_400_000,
          updatedAtMs: now - 3_600_000,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "test" },
          state: { nextRunAtMs: 0 },
        },
      ],
    });

    const state = createOkIsolatedCronState({ storePath, now });

    const updated = await update(state, "broken-job", { description: "fixed" });

    expect(updated.description).toBe("fixed");
    expect(updated.state.nextRunAtMs).toBeGreaterThan(0);
    expect(updated.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("records startup catch-up timeouts as timed_out in the shared task registry", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeCronStoreSnapshot({
        storePath,
        jobs: [createMissedIsolatedJob(now)],
      });

      const state = createTimedOutIsolatedCronState({
        storePath,
        now,
      });

      await runMissedJobs(state);

      expectTaskRun({
        runId: `cron:startup-timeout:${now}`,
        runtime: "cron",
        status: "timed_out",
        sourceId: "startup-timeout",
        progressSummary: "Running cron job.",
      });
    });
  });

  it("seeds active manual cron task progress for status surfaces", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeDueIsolatedJobSnapshot(storePath, now);
      let resolveRun: ((value: { status: "ok"; summary: string }) => void) | undefined;
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(
          () =>
            new Promise<{ status: "ok"; summary: string }>((resolve) => {
              resolveRun = resolve;
            }),
        ),
      });

      const manualRun = run(state, "isolated-timeout");
      await vi.waitFor(() => {
        expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      });

      const task = findCronTaskByBaseRunId(`cron:isolated-timeout:${now}`);
      if (!task) {
        throw new Error("expected active manual cron task ledger record");
      }
      expect(task.status).toBe("running");
      expect(task.progressSummary).toBe("Running cron job.");
      expect(formatTaskStatusDetail(task)).toBe("Running cron job.");

      resolveRun?.({ status: "ok", summary: "done" });
      await manualRun;
    });
  });

  it("rejects add of a structurally valid cron expression that never matches", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    await expect(
      add(state, {
        name: "feb 30 cleanup",
        enabled: true,
        schedule: { kind: "cron", expr: "0 0 30 2 *" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "do work" },
      }),
    ).rejects.toThrow(/has no upcoming run time and would never fire/);
    if (state.timer) {
      clearTimeout(state.timer);
    }

    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs).toEqual([]);
  });

  it("accepts add of a satisfiable cron expression and arms a next run", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    const job = await add(state, {
      name: "daily cleanup",
      enabled: true,
      schedule: { kind: "cron", expr: "0 0 * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect(job.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("rejects update that changes a job to a never-matching cron expression", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    const job = await add(state, {
      name: "daily cleanup",
      enabled: true,
      schedule: { kind: "cron", expr: "0 0 * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    await expect(
      update(state, job.id, { schedule: { kind: "cron", expr: "0 0 30 2 *" } }),
    ).rejects.toThrow(/has no upcoming run time and would never fire/);
    if (state.timer) {
      clearTimeout(state.timer);
    }

    const loaded = await loadCronStore(storePath);
    const stored = loaded.jobs.find((entry) => entry.id === job.id);
    expect(stored?.schedule).toMatchObject({ kind: "cron", expr: "0 0 * * *" });
  });

  it("allows non-schedule updates on a pre-existing never-matching job", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "legacy-unsatisfiable",
          name: "legacy unsatisfiable",
          enabled: true,
          createdAtMs: now - 60_000,
          updatedAtMs: now - 60_000,
          schedule: { kind: "cron", expr: "0 0 30 2 *" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "do work" },
          state: {},
        },
      ],
    });
    const state = createOkIsolatedCronState({ storePath, now });

    const updated = await update(state, "legacy-unsatisfiable", { enabled: false });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    expect(updated.enabled).toBe(false);
  });

  it("rejects enabling a pre-existing never-matching job", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "legacy-unsatisfiable",
          name: "legacy unsatisfiable",
          enabled: false,
          createdAtMs: now,
          updatedAtMs: now,
          schedule: { kind: "cron", expr: "0 0 30 2 *" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "do work" },
          state: {},
        },
      ],
    });
    const state = createOkIsolatedCronState({ storePath, now });

    await expect(update(state, "legacy-unsatisfiable", { enabled: true })).rejects.toThrow(
      /has no upcoming run time and would never fire/,
    );

    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs[0]?.enabled).toBe(false);
  });

  it("uses the service clock when validating a finite-year cron update", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2000-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const job = await add(state, {
      name: "future finite-year job",
      enabled: true,
      schedule: { kind: "cron", expr: "0 0 * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    const updated = await update(state, job.id, {
      schedule: { kind: "cron", expr: "0 0 0 1 1 * 2001", tz: "UTC" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    expect(updated.state.nextRunAtMs).toBe(Date.parse("2001-01-01T00:00:00.000Z"));
  });

  it("accepts a finite-year cron while its final staggered run is pending", async () => {
    const { storePath } = await makeStorePath();
    const finalBaseRunAtMs = Date.parse("2001-01-01T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now: finalBaseRunAtMs + 1 });

    const job = await add(state, {
      name: "final staggered run",
      enabled: true,
      schedule: {
        kind: "cron",
        expr: "0 0 0 1 1 * 2001",
        tz: "UTC",
        staggerMs: 3_600_000,
      },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    expect(job.state.nextRunAtMs).toBeGreaterThan(finalBaseRunAtMs);
  });

  it("uses explicit lifecycle events instead of scheduled duplicates for the target job", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const events: CronEvent[] = [];
    const state = createOkIsolatedCronState({
      storePath,
      now,
      onEvent: (event) => events.push(structuredClone(event)),
    });

    const job = await add(state, {
      id: "lifecycle-target",
      name: "lifecycle target",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
    });
    expect(events.map((event) => event.action)).toEqual(["added"]);

    events.length = 0;
    await update(state, job.id, {
      schedule: { kind: "every", everyMs: 120_000, anchorMs: now },
    });
    expect(events.map((event) => event.action)).toEqual(["updated"]);

    events.length = 0;
    await remove(state, job.id);
    expect(events.map((event) => event.action)).toEqual(["removed"]);
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });

  it("emits repaired sibling schedules during add before the target lifecycle event", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const sibling = createFutureEveryJob({ id: "repair-during-add", now });
    await writeCronStoreSnapshot({ storePath, jobs: [sibling] });
    const events: CronEvent[] = [];
    const state = createOkIsolatedCronState({
      storePath,
      now,
      onEvent: (event) => events.push(structuredClone(event)),
    });

    const added = await add(state, {
      id: "added-target",
      name: "added target",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "added" },
    });

    expect(events.map(({ jobId, action }) => ({ jobId, action }))).toEqual([
      { jobId: sibling.id, action: "scheduled" },
      { jobId: added.id, action: "added" },
    ]);
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });

  it("emits repaired sibling schedules during remove before the target lifecycle event", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const sibling = createFutureEveryJob({ id: "repair-during-remove", now });
    const target = createFutureEveryJob({
      id: "removed-target",
      now,
      nextRunAtMs: now + 60_000,
    });
    await writeCronStoreSnapshot({ storePath, jobs: [sibling, target] });
    const events: CronEvent[] = [];
    const state = createOkIsolatedCronState({
      storePath,
      now,
      onEvent: (event) => events.push(structuredClone(event)),
    });

    await remove(state, target.id);

    expect(events.map(({ jobId, action }) => ({ jobId, action }))).toEqual([
      { jobId: sibling.id, action: "scheduled" },
      { jobId: target.id, action: "removed" },
    ]);
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });
});

describe("cron service ops persist rollback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCreateInput(name: string) {
    return {
      name,
      enabled: true,
      schedule: { kind: "cron", expr: "0 0 * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
    } as const;
  }

  it("rolls back an added job from the live store when persist fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    vi.spyOn(cronStoreModule, "saveCronJobsStore").mockRejectedValueOnce(new Error("disk full"));

    await expect(add(state, makeCreateInput("daily cleanup"))).rejects.toThrow("disk full");

    expect(state.timer).toBeNull();
    expect(state.store?.jobs ?? []).toEqual([]);
    const listed = await list(state, { includeDisabled: true });
    if (state.timer) {
      clearTimeout(state.timer);
    }
    expect(listed).toEqual([]);
    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs).toEqual([]);
  });

  it("keeps the pre-update job in the live store when persist fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    const job = await add(state, makeCreateInput("daily cleanup"));
    if (state.timer) {
      clearTimeout(state.timer);
    }

    vi.spyOn(cronStoreModule, "saveCronJobsStore").mockRejectedValueOnce(new Error("disk full"));

    await expect(update(state, job.id, { name: "renamed cleanup" })).rejects.toThrow("disk full");

    const inMemory = state.store?.jobs.find((entry) => entry.id === job.id);
    expect(inMemory?.name).toBe("daily cleanup");
    const loaded = await loadCronStore(storePath);
    const stored = loaded.jobs.find((entry) => entry.id === job.id);
    expect(stored?.name).toBe("daily cleanup");
  });

  it("keeps a removed job in the live store when persist fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    const job = await add(state, makeCreateInput("daily cleanup"));
    if (state.timer) {
      clearTimeout(state.timer);
    }

    vi.spyOn(cronStoreModule, "saveCronJobsStore").mockRejectedValueOnce(new Error("disk full"));

    await expect(remove(state, job.id)).rejects.toThrow("disk full");

    expect(state.store?.jobs.map((entry) => entry.id)).toEqual([job.id]);
    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs.map((entry) => entry.id)).toEqual([job.id]);
  });

  it("keeps a job's catch-up deferral marker when a remove persist fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    const job = await add(state, makeCreateInput("daily cleanup"));
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.pendingCatchupDeferralJobIds.add(job.id);

    vi.spyOn(cronStoreModule, "saveCronJobsStore").mockRejectedValueOnce(new Error("disk full"));

    await expect(remove(state, job.id)).rejects.toThrow("disk full");

    expect(state.pendingCatchupDeferralJobIds.has(job.id)).toBe(true);
    expect(state.store?.jobs.map((entry) => entry.id)).toEqual([job.id]);
  });

  it("recovers after a failed persist so the next mutation succeeds", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    vi.spyOn(cronStoreModule, "saveCronJobsStore").mockRejectedValueOnce(new Error("disk full"));
    await expect(add(state, makeCreateInput("daily cleanup"))).rejects.toThrow("disk full");

    const job = await add(state, makeCreateInput("daily cleanup"));
    if (state.timer) {
      clearTimeout(state.timer);
    }

    const listed = await list(state, { includeDisabled: true });
    if (state.timer) {
      clearTimeout(state.timer);
    }
    expect(listed.map((entry) => entry.id)).toEqual([job.id]);
    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs.map((entry) => entry.id)).toEqual([job.id]);
  });

  it("notifies about schedule auto-disable only after the mutation persists", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });

    const malformed = await add(state, {
      ...makeCreateInput("malformed sibling"),
      schedule: { kind: "cron", expr: "0 1 * * *" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }
    malformed.state.nextRunAtMs = undefined;
    malformed.state.scheduleErrorCount = 2;
    const enqueueSystemEvent = vi.mocked(state.deps.enqueueSystemEvent);
    const requestHeartbeat = vi.mocked(state.deps.requestHeartbeat);
    enqueueSystemEvent.mockClear();
    requestHeartbeat.mockClear();
    const computeNextRunAtMs = cronSchedule.computeNextRunAtMs;
    vi.spyOn(cronSchedule, "computeNextRunAtMs").mockImplementation((schedule, nowMs) => {
      if (schedule.kind === "cron" && schedule.expr === "0 1 * * *") {
        throw new Error("simulated schedule failure");
      }
      return computeNextRunAtMs(schedule, nowMs);
    });

    vi.spyOn(cronStoreModule, "saveCronJobsStore").mockRejectedValueOnce(new Error("disk full"));
    await expect(add(state, makeCreateInput("failed mutation"))).rejects.toThrow("disk full");

    expect(state.store?.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(true);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();

    await add(state, makeCreateInput("successful mutation"));
    if (state.timer) {
      clearTimeout(state.timer);
    }

    expect(state.store?.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(false);
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(requestHeartbeat).toHaveBeenCalledTimes(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
