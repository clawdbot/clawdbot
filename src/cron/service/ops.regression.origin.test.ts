// Cron ops origin regression tests cover run-origin and manual-run attribution.
import { describe, expect, it, vi } from "vitest";
import {
  createIsolatedRegressionJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { run } from "./ops.js";
import type { CronEvent } from "./state.js";
import { createCronServiceState } from "./state.js";

const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-ops-origin-regressions-",
});

describe("cron service ops origin regressions", () => {
  it.each([
    {
      id: "onexit-delete-ok",
      deleteAfterRun: true,
      runStatus: "ok" as const,
      expectedJob: undefined,
      expectedActions: ["started", "finished", "removed"],
    },
    {
      id: "onexit-keep-ok",
      deleteAfterRun: false,
      runStatus: "ok" as const,
      expectedJob: { enabled: false, lastStatus: "ok" },
      expectedActions: ["started", "finished"],
    },
    {
      id: "onexit-delete-error",
      deleteAfterRun: true,
      runStatus: "error" as const,
      expectedJob: { enabled: false, lastStatus: "error" },
      expectedActions: ["started", "finished"],
    },
  ])("#104518 finalizes watcher-fired on-exit job: $id", async (params) => {
    const store = opsRegressionFixtures.makeStorePath();
    const nowMs = Date.now();
    const job = createIsolatedRegressionJob({
      id: params.id,
      name: params.id,
      scheduledAt: nowMs,
      schedule: { kind: "on-exit", command: 'sh -c "exit 0"' },
      payload: { kind: "agentTurn", message: "post-exit payload" },
      state: {},
    });
    job.deleteAfterRun = params.deleteAfterRun;
    // The gateway watcher persists this disable before force-running the payload.
    job.enabled = false;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const events: CronEvent[] = [];
    const state = createCronServiceState({
      cronEnabled: false,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob:
        params.runStatus === "ok"
          ? vi.fn().mockResolvedValue({ status: "ok", summary: "ok" })
          : vi.fn().mockResolvedValue({ status: "error", error: "boom" }),
      onEvent: (event) => events.push(event),
    });
    await expect(run(state, params.id, "force", { origin: "watcher-terminal" })).resolves.toEqual({
      ok: true,
      ran: true,
    });

    const memoryJob = state.store?.jobs.find((entry) => entry.id === params.id);
    const durableJob = (await loadCronStore(store.storePath)).jobs.find(
      (entry) => entry.id === params.id,
    );
    if (params.expectedJob) {
      for (const persistedJob of [memoryJob, durableJob]) {
        expect(persistedJob).toMatchObject({
          enabled: params.expectedJob.enabled,
          state: { lastStatus: params.expectedJob.lastStatus },
        });
      }
    } else {
      expect(memoryJob).toBeUndefined();
      expect(durableJob).toBeUndefined();
    }
    expect(events.map((event) => event.action)).toEqual(params.expectedActions);
  });

  it("#83933: operator force on an on-exit deleteAfterRun job preserves it (not consumed)", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const nowMs = Date.now();
    const job = createIsolatedRegressionJob({
      id: "operator-force-onexit-keep",
      name: "operator-force-onexit-keep",
      scheduledAt: nowMs,
      schedule: { kind: "on-exit", command: 'sh -c "exit 0"' },
      payload: { kind: "agentTurn", message: "post-exit payload" },
      state: {},
    });
    job.deleteAfterRun = true;
    job.enabled = false;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const events: CronEvent[] = [];
    const state = createCronServiceState({
      cronEnabled: false,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
      onEvent: (event) => events.push(event),
    });

    // Default origin is operator: unlike the watcher-terminal force run above, a
    // manual force must not consume a deleteAfterRun on-exit job (#83933).
    await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });

    const memoryJob = state.store?.jobs.find((entry) => entry.id === job.id);
    const durableJob = (await loadCronStore(store.storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(memoryJob).toBeDefined();
    expect(durableJob).toBeDefined();
    expect(memoryJob?.state.lastRunStatus).toBe("ok");
    expect(memoryJob?.state.lastRunWasManual).toBe(true);
    expect(events.some((event) => event.action === "removed")).toBe(false);
    expect(events.map((event) => event.action)).toEqual(["started", "finished"]);
  });

  it.each([
    {
      label: "watcher-terminal",
      origin: "watcher-terminal" as const,
      // The gateway on-exit watcher owns scheduler state, so an invalid-spec
      // skip records a scheduled outcome and bumps consecutiveSkipped.
      expectedManual: false,
      expectedConsecutiveSkipped: 1,
    },
    {
      label: "operator",
      origin: "operator" as const,
      // A manual run only records the outcome; scheduler counters stay put.
      expectedManual: true,
      expectedConsecutiveSkipped: undefined,
    },
  ])(
    "#83933: invalid persisted job finalizes with $label scheduler-state semantics",
    async (params) => {
      const store = opsRegressionFixtures.makeStorePath();
      const nowMs = Date.now();
      const job = createIsolatedRegressionJob({
        id: `invalid-spec-${params.label}`,
        name: `invalid-spec-${params.label}`,
        scheduledAt: nowMs,
        schedule: { kind: "cron", expr: "* * * * *" },
        payload: { kind: "agentTurn", message: "run payload" },
        state: {},
      });
      // A `main` job with an agentTurn payload loads fine (persisted-shape only
      // checks payload kind) but fails assertSupportedJobSpec at preflight, so
      // the run funnels through skipInvalidPersistedManualRun (#83933).
      job.sessionTarget = "main";
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      const state = createCronServiceState({
        cronEnabled: false,
        storePath: store.storePath,
        log: noopLogger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
        onEvent: vi.fn(),
      });

      await expect(run(state, job.id, "force", { origin: params.origin })).resolves.toEqual({
        ok: true,
        ran: false,
        reason: "invalid-spec",
      });

      const memoryJob = state.store?.jobs.find((entry) => entry.id === job.id);
      expect(memoryJob?.state.lastStatus).toBe("skipped");
      // Origin decides scheduler-state ownership: the watcher-terminal path
      // records a scheduled skip, while operator only records the outcome.
      expect(memoryJob?.state.lastRunWasManual).toBe(params.expectedManual);
      expect(memoryJob?.state.consecutiveSkipped).toBe(params.expectedConsecutiveSkipped);
    },
  );

  it("#83933 P1-A: operator due run on a fired trigger job that errors stays non-consuming", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    const job = createIsolatedRegressionJob({
      id: "operator-due-trigger-error",
      name: "operator-due-trigger-error",
      scheduledAt: nowMs,
      schedule: { kind: "cron", expr: "* * * * *" },
      payload: { kind: "agentTurn", message: "run payload" },
      state: { nextRunAtMs: nowMs, consecutiveErrors: 3 },
    });
    job.trigger = { script: "return true;" };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "error", error: "boom" });
    const state = createCronServiceState({
      cronEnabled: false,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      evaluateCronTrigger: vi.fn().mockResolvedValue({ kind: "evaluated", fire: true }),
      runIsolatedAgentJob,
    });

    await expect(run(state, job.id, "due")).resolves.toEqual({ ok: true, ran: true });

    const updated = state.store?.jobs.find((entry) => entry.id === job.id);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(updated?.state.lastRunStatus).toBe("error");
    // The bug misclassified an operator run as scheduled, bumping the error
    // counter and disabling/backing off the job. Operator must record the
    // outcome without perturbing scheduler-owned state (#83933).
    expect(updated?.state.lastRunWasManual).toBe(true);
    expect(updated?.state.consecutiveErrors).toBe(3);
    expect(updated?.enabled).toBe(true);
  });

  it("#83933 P1-A sibling: operator due quiet trigger tick does not reset error counters", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    const job = createIsolatedRegressionJob({
      id: "operator-due-trigger-quiet",
      name: "operator-due-trigger-quiet",
      scheduledAt: nowMs,
      schedule: { kind: "cron", expr: "* * * * *" },
      payload: { kind: "agentTurn", message: "run payload" },
      state: { nextRunAtMs: nowMs, consecutiveErrors: 2, scheduleErrorCount: 1 },
    });
    job.trigger = { script: "return false;" };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "unused" });
    const state = createCronServiceState({
      cronEnabled: false,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      evaluateCronTrigger: vi.fn().mockResolvedValue({ kind: "evaluated", fire: false }),
      runIsolatedAgentJob,
    });

    await expect(run(state, job.id, "due")).resolves.toEqual({ ok: true, ran: true });

    const updated = state.store?.jobs.find((entry) => entry.id === job.id);
    // A non-firing evaluation runs no payload; the timer quiet-tick would reset
    // the error/schedule counters, but an operator due-check must leave the
    // scheduler-owned counters intact so the scheduled fire still happens (#83538).
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(updated?.state.consecutiveErrors).toBe(2);
    expect(updated?.state.scheduleErrorCount).toBe(1);
  });
});
