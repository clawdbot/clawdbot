import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CronEvent } from "./service.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { computeJobNextRunAtMs } from "./service/jobs-scheduling.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { readCronTaskRunHistoryPage } from "./task-run-history.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-trigger-eval-" });

type Evaluator = NonNullable<CronServiceDeps["evaluateCronTrigger"]>;
type CronEventContext = Parameters<NonNullable<CronServiceDeps["onEvent"]>>[1];
type IsolatedRunner = CronServiceDeps["runIsolatedAgentJob"];
type ScriptRunner = NonNullable<CronServiceDeps["runScriptJob"]>;

function watcher(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "watcher",
    enabled: true,
    schedule: { kind: "cron", expr: "* * * * * *", staggerMs: 0 },
    trigger: { script: "json({ fire: false })" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "base message" },
    ...overrides,
  };
}

async function createHarness(params: {
  evaluateCronTrigger?: Evaluator;
  runIsolatedAgentJob?: IsolatedRunner;
  runScriptJob?: ScriptRunner;
  sendCronWebhook?: CronServiceDeps["sendCronWebhook"];
}) {
  const { storePath } = await makeStorePath();
  const events: CronEvent[] = [];
  const eventContexts: Array<CronEventContext | undefined> = [];
  const enqueueSystemEvent = vi.fn();
  const runIsolatedAgentJob =
    params.runIsolatedAgentJob ?? vi.fn(async () => ({ status: "ok" as const }));
  const cron = new CronService({
    storePath,
    cronEnabled: true,
    cronConfig: { triggers: { enabled: true } },
    log: logger,
    enqueueSystemEvent,
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob,
    ...(params.evaluateCronTrigger ? { evaluateCronTrigger: params.evaluateCronTrigger } : {}),
    ...(params.runScriptJob ? { runScriptJob: params.runScriptJob } : {}),
    ...(params.sendCronWebhook ? { sendCronWebhook: params.sendCronWebhook } : {}),
    onEvent: (event, context) => {
      events.push(structuredClone(event));
      eventContexts.push(context ? structuredClone(context) : undefined);
    },
  });
  await cron.start();
  return { cron, enqueueSystemEvent, eventContexts, events, runIsolatedAgentJob, storePath };
}

async function runWhenDue(cron: CronService, jobId: string) {
  const nextRunAtMs = cron.getJob(jobId)?.state.nextRunAtMs;
  if (nextRunAtMs === undefined) {
    throw new Error("test job has no next run");
  }
  vi.setSystemTime(nextRunAtMs);
  return cron.run(jobId, "due");
}

describe("cron trigger evaluation", () => {
  it("persists quiet evaluations and fires replacement triggers with fresh state", async () => {
    const replacementScript = 'return "replacement"';
    const evaluateCronTrigger = vi.fn(async (params: Parameters<Evaluator>[0]) => ({
      kind: "evaluated" as const,
      fire: params.script === replacementScript && params.state === undefined,
      state: { status: "green" },
    }));
    const harness = await createHarness({ evaluateCronTrigger });
    try {
      const job = await harness.cron.add(watcher());
      const dueAt = job.state.nextRunAtMs ?? 0;
      harness.events.length = 0;

      expect(await runWhenDue(harness.cron, job.id)).toEqual({ ok: true, ran: true });

      const stored = harness.cron.getJob(job.id);
      const persisted = (await loadCronStore(harness.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(stored?.state).toMatchObject({
        lastTriggerEvalAtMs: dueAt,
        triggerEvalCount: 1,
        triggerState: { status: "green" },
        consecutiveErrors: 0,
        scheduleErrorCount: 0,
      });
      expect(stored?.state.lastRunAtMs).toBeUndefined();
      expect((stored?.state.nextRunAtMs ?? 0) - dueAt).toBeGreaterThanOrEqual(30_000);
      expect(harness.runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(harness.events.map((event) => event.action)).toEqual(["started", "scheduled"]);
      expect(harness.events.at(-1)).toMatchObject({
        jobId: job.id,
        action: "scheduled",
        nextRunAtMs: persisted?.state.nextRunAtMs,
        job: { state: { nextRunAtMs: persisted?.state.nextRunAtMs } },
      });
      expect(
        readCronTaskRunHistoryPage({
          storeKey: cronStoreKey(harness.storePath),
          jobId: job.id,
        }).entries,
      ).toEqual([]);

      await harness.cron.update(job.id, { trigger: { script: replacementScript } });
      expect(await runWhenDue(harness.cron, job.id)).toEqual({ ok: true, ran: true });
      expect(evaluateCronTrigger).toHaveBeenLastCalledWith(
        expect.objectContaining({ script: replacementScript, state: undefined }),
      );
      expect(harness.runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(harness.cron.getJob(job.id)?.state.triggerEvalCount).toBe(1);
    } finally {
      harness.cron.stop();
    }
  });

  it("appends the trigger message and marks fired run history", async () => {
    const evaluateCronTrigger = vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: true,
      message: "CI became red",
      state: { status: "red" },
    }));
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    const harness = await createHarness({ evaluateCronTrigger, runIsolatedAgentJob });
    try {
      const job = await harness.cron.add(watcher());
      await runWhenDue(harness.cron, job.id);

      expect(runIsolatedAgentJob).toHaveBeenCalledWith(
        expect.objectContaining({ message: "base message\n\nCI became red" }),
      );
      const finished = harness.events.find((event) => event.action === "finished");
      expect(finished).toMatchObject({ status: "ok", triggerFired: true });
      if (!finished) {
        throw new Error("missing finished event");
      }
      expect(
        readCronTaskRunHistoryPage({
          storeKey: cronStoreKey(harness.storePath),
          jobId: job.id,
        }).entries,
      ).toEqual([expect.objectContaining({ triggerFired: true })]);
      expect(harness.cron.getJob(job.id)?.state).toMatchObject({
        triggerEvalCount: 1,
        lastTriggerFireAtMs: expect.any(Number),
        triggerState: { status: "red" },
      });
    } finally {
      harness.cron.stop();
    }
  });

  it("appends the trigger message to main-session system events", async () => {
    const evaluateCronTrigger = vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: true,
      message: "deploy completed",
    }));
    const harness = await createHarness({ evaluateCronTrigger });
    try {
      const job = await harness.cron.add(
        watcher({
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "base event" },
        }),
      );
      await runWhenDue(harness.cron, job.id);

      expect(harness.events.find((event) => event.action === "finished")).toMatchObject({
        status: "ok",
        triggerFired: true,
      });
      expect(harness.enqueueSystemEvent).toHaveBeenCalledWith(
        "base event\n\ndeploy completed",
        expect.any(Object),
      );
    } finally {
      harness.cron.stop();
    }
  });

  it("routes evaluator errors through execution backoff", async () => {
    const evaluateCronTrigger = vi.fn(async () => ({
      kind: "error" as const,
      code: "timeout" as const,
      error: "deadline exceeded",
    }));
    const harness = await createHarness({ evaluateCronTrigger });
    try {
      const job = await harness.cron.add(watcher());
      const dueAt = job.state.nextRunAtMs ?? 0;
      harness.events.length = 0;
      harness.eventContexts.length = 0;
      await runWhenDue(harness.cron, job.id);

      const stored = harness.cron.getJob(job.id);
      const persisted = (await loadCronStore(harness.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(stored?.state).toMatchObject({
        consecutiveErrors: 1,
        triggerEvalCount: 1,
        lastRunStatus: "error",
      });
      expect(stored?.state.nextRunAtMs).toBeGreaterThan(dueAt);
      expect(harness.events.find((event) => event.action === "finished")).toMatchObject({
        status: "error",
        error: expect.stringContaining("deadline exceeded"),
      });
      expect(harness.eventContexts[1]).toEqual({
        failureNotificationDetail: {
          kind: "script-failure",
          source: "trigger",
          code: "timeout",
        },
      });
      expect(harness.events[1]).not.toHaveProperty("failureNotificationDetail");
      expect(harness.events.map((event) => event.action)).toEqual([
        "started",
        "finished",
        "scheduled",
      ]);
      expect(harness.events.at(-1)).toMatchObject({
        jobId: job.id,
        action: "scheduled",
        nextRunAtMs: persisted?.state.nextRunAtMs,
        job: { state: { nextRunAtMs: persisted?.state.nextRunAtMs } },
      });
    } finally {
      harness.cron.stop();
    }
  });

  it("keeps webhook delivery not-requested when trigger evaluation stops before payload", async () => {
    const evaluateCronTrigger = vi.fn(async () => ({
      kind: "error" as const,
      code: "internal_error" as const,
      error: "trigger failed",
    }));
    const sendCronWebhook = vi.fn();
    const harness = await createHarness({ evaluateCronTrigger, sendCronWebhook });
    try {
      const job = await harness.cron.add(
        watcher({ delivery: { mode: "webhook", to: "https://example.invalid/hook" } }),
      );
      await runWhenDue(harness.cron, job.id);

      expect(sendCronWebhook).not.toHaveBeenCalled();
      expect(harness.cron.getJob(job.id)?.state).toMatchObject({
        lastDeliveryStatus: "not-requested",
      });
      expect(harness.cron.getJob(job.id)?.state.lastDelivered).toBeUndefined();
      expect(harness.cron.getJob(job.id)?.state.lastDeliveryError).toBeUndefined();

      const finished = harness.events.find((event) => event.action === "finished");
      expect(finished).toMatchObject({ deliveryStatus: "not-requested" });
      expect(finished?.delivered).toBeUndefined();
      expect(finished?.deliveryError).toBeUndefined();

      const history = readCronTaskRunHistoryPage({
        storeKey: cronStoreKey(harness.storePath),
        jobId: job.id,
      }).entries;
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ deliveryStatus: "not-requested" });
      expect(history[0]?.delivered).toBeUndefined();
      expect(history[0]?.deliveryError).toBeUndefined();
    } finally {
      harness.cron.stop();
    }
  });

  it("treats evaluator saturation as a quiet skip with no trigger state update", async () => {
    const evaluateCronTrigger = vi.fn(async () => ({ kind: "busy" as const }));
    const harness = await createHarness({ evaluateCronTrigger });
    try {
      const job = await harness.cron.add(watcher());
      await runWhenDue(harness.cron, job.id);

      const state = harness.cron.getJob(job.id)?.state;
      expect(state?.triggerEvalCount).toBeUndefined();
      expect(state?.lastTriggerEvalAtMs).toBeUndefined();
      expect(state?.triggerState).toBeUndefined();
      expect(harness.events.filter((event) => event.action === "finished")).toHaveLength(0);
      expect(logger.debug).toHaveBeenCalledWith(
        { jobId: job.id },
        "cron: trigger evaluation skipped while busy",
      );
    } finally {
      harness.cron.stop();
    }
  });

  it("disables once triggers only after a successful fired payload", async () => {
    const evaluateCronTrigger = vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: true,
    }));
    const success = await createHarness({ evaluateCronTrigger });
    try {
      const job = await success.cron.add(watcher({ trigger: { script: "fire", once: true } }));
      await runWhenDue(success.cron, job.id);
      expect(success.cron.getJob(job.id)).toMatchObject({ enabled: false });
      expect(success.cron.getJob(job.id)?.state.nextRunAtMs).toBeUndefined();
    } finally {
      success.cron.stop();
    }

    const failed = await createHarness({
      evaluateCronTrigger,
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "error" as const,
        error: "payload failed",
      })),
    });
    try {
      const job = await failed.cron.add(watcher({ trigger: { script: "fire", once: true } }));
      await runWhenDue(failed.cron, job.id);
      expect(failed.cron.getJob(job.id)).toMatchObject({ enabled: true });
      expect(failed.cron.getJob(job.id)?.state.nextRunAtMs).toEqual(expect.any(Number));
    } finally {
      failed.cron.stop();
    }
  });

  it.each([
    ["replaced", false],
    ["restored after replacement", true],
  ] as const)("preserves a %s trigger edited during a manual fired run", async (_, restore) => {
    const started = createDeferred();
    const completion = createDeferred<{ status: "ok"; summary: string }>();
    const evaluateCronTrigger = vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: true,
      state: { owner: "obsolete" },
    }));
    const harness = await createHarness({
      evaluateCronTrigger,
      runIsolatedAgentJob: vi.fn(async () => {
        started.resolve();
        return completion.promise;
      }),
    });
    try {
      const originalTrigger = { script: "original trigger", once: true };
      const job = await harness.cron.add(watcher({ trigger: originalTrigger }));
      const run = runWhenDue(harness.cron, job.id);
      await started.promise;

      await harness.cron.update(job.id, {
        trigger: { script: "replacement trigger", once: true },
        state: { triggerState: { owner: "latest edit" } },
      });
      if (restore) {
        await harness.cron.update(job.id, { trigger: originalTrigger });
      }
      completion.resolve({ status: "ok", summary: "done" });
      expect(await run).toEqual({ ok: true, ran: true });

      const stored = harness.cron.getJob(job.id);
      expect(stored?.enabled).toBe(true);
      expect(stored?.trigger).toEqual(
        restore ? originalTrigger : { script: "replacement trigger", once: true },
      );
      expect(stored?.state.triggerState).toEqual(restore ? undefined : { owner: "latest edit" });
      expect(stored?.state.lastTriggerEvalAtMs).toBeUndefined();
      expect(stored?.state.nextRunAtMs).toEqual(expect.any(Number));
    } finally {
      completion.resolve({ status: "ok", summary: "cleanup" });
      harness.cron.stop();
    }
  });

  it.each([
    ["edited", false],
    ["restored after an edit", true],
  ] as const)("preserves trigger state %s during a manual fired run", async (_, restore) => {
    const started = createDeferred();
    const completion = createDeferred<{ status: "ok"; summary: string }>();
    const harness = await createHarness({
      evaluateCronTrigger: vi.fn(async () => ({
        kind: "evaluated" as const,
        fire: true,
        state: { owner: "obsolete evaluation" },
      })),
      runIsolatedAgentJob: vi.fn(async () => {
        started.resolve();
        return completion.promise;
      }),
    });
    try {
      const originalState = { owner: "original" };
      const job = await harness.cron.add(
        watcher({
          trigger: { script: "unchanged trigger", once: true },
          state: { triggerState: originalState },
        }),
      );
      const run = runWhenDue(harness.cron, job.id);
      await started.promise;

      await harness.cron.update(job.id, { state: { triggerState: { owner: "latest edit" } } });
      if (restore) {
        await harness.cron.update(job.id, { state: { triggerState: originalState } });
      }
      completion.resolve({ status: "ok", summary: "done" });
      expect(await run).toEqual({ ok: true, ran: true });

      const stored = harness.cron.getJob(job.id);
      expect(stored?.enabled).toBe(true);
      expect(stored?.trigger).toEqual({ script: "unchanged trigger", once: true });
      expect(stored?.state.triggerState).toEqual(
        restore ? originalState : { owner: "latest edit" },
      );
      expect(stored?.state.lastTriggerEvalAtMs).toBeUndefined();
    } finally {
      completion.resolve({ status: "ok", summary: "cleanup" });
      harness.cron.stop();
    }
  });

  it.each([
    ["replaced", false],
    ["restored after replacement", true],
  ] as const)(
    "does not let a %s active payload script overwrite shared state",
    async (_, restore) => {
      const started = createDeferred();
      const completion = createDeferred<{
        status: "ok";
        stateChanged: true;
        state: { owner: string };
      }>();
      const harness = await createHarness({
        runScriptJob: vi.fn(async () => {
          started.resolve();
          return completion.promise;
        }),
      });
      try {
        const originalPayload = { kind: "script" as const, script: "return original" };
        const job = await harness.cron.add(
          watcher({
            trigger: undefined,
            payload: originalPayload,
            state: { triggerState: { owner: "current" } },
          }),
        );
        const run = runWhenDue(harness.cron, job.id);
        await started.promise;

        await harness.cron.update(job.id, {
          payload: { kind: "script", script: "return replacement" },
        });
        if (restore) {
          await harness.cron.update(job.id, { payload: originalPayload });
        }
        completion.resolve({
          status: "ok",
          stateChanged: true,
          state: { owner: "obsolete payload" },
        });
        expect(await run).toEqual({ ok: true, ran: true });

        const stored = harness.cron.getJob(job.id);
        expect(stored?.payload).toMatchObject(
          restore ? originalPayload : { kind: "script", script: "return replacement" },
        );
        expect(stored?.state.triggerState).toBeUndefined();
        const persisted = (await loadCronStore(harness.storePath)).jobs.find(
          (entry) => entry.id === job.id,
        );
        expect(persisted?.state.triggerState).toBeUndefined();
      } finally {
        completion.resolve({ status: "ok", stateChanged: true, state: { owner: "cleanup" } });
        harness.cron.stop();
      }
    },
  );

  it.each([
    ["trigger definition", true],
    ["trigger state only", false],
  ] as const)("preserves %s edited during its suspended quiet evaluation", async (_, replace) => {
    const started = createDeferred();
    const evaluation = createDeferred<{
      kind: "evaluated";
      fire: false;
      state: { owner: string };
    }>();
    const evaluateCronTrigger = vi.fn(async () => {
      started.resolve();
      return evaluation.promise;
    });
    const harness = await createHarness({ evaluateCronTrigger });
    try {
      const job = await harness.cron.add(watcher({ trigger: { script: "old trigger" } }));
      const run = runWhenDue(harness.cron, job.id);
      await started.promise;

      await harness.cron.update(job.id, {
        ...(replace ? { trigger: { script: "replacement trigger" } } : {}),
        state: { triggerState: { owner: "latest edit" } },
      });
      evaluation.resolve({ kind: "evaluated", fire: false, state: { owner: "obsolete" } });
      expect(await run).toEqual({ ok: true, ran: true });

      const stored = harness.cron.getJob(job.id);
      expect(stored?.trigger).toEqual({ script: replace ? "replacement trigger" : "old trigger" });
      expect(stored?.state.triggerState).toEqual({ owner: "latest edit" });
      expect(stored?.state.lastTriggerEvalAtMs).toBeUndefined();
      expect(stored?.state.nextRunAtMs).toEqual(expect.any(Number));
    } finally {
      evaluation.resolve({ kind: "evaluated", fire: false, state: { owner: "cleanup" } });
      harness.cron.stop();
    }
  });

  it("keeps per-job cron staggering when rescheduling quiet ticks", async () => {
    const evaluateCronTrigger = vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: false,
    }));
    const harness = await createHarness({ evaluateCronTrigger });
    try {
      const job = await harness.cron.add(
        watcher({ schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 300_000 } }),
      );
      const dueAt = job.state.nextRunAtMs ?? 0;
      await runWhenDue(harness.cron, job.id);

      const stored = harness.cron.getJob(job.id);
      if (!stored) {
        throw new Error("missing job");
      }
      // Must match the job-level (stagger-aware) computation, not the raw boundary.
      expect(stored.state.nextRunAtMs).toBe(computeJobNextRunAtMs(stored, dueAt));
    } finally {
      harness.cron.stop();
    }
  });

  it("keeps prior trigger state when the fired payload run fails", async () => {
    const evaluateCronTrigger = vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: true,
      message: "CI became red",
      state: { status: "red" },
    }));
    const harness = await createHarness({
      evaluateCronTrigger,
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "error" as const,
        error: "payload failed",
      })),
    });
    try {
      const job = await harness.cron.add(watcher());
      await runWhenDue(harness.cron, job.id);

      const state = harness.cron.getJob(job.id)?.state;
      expect(state).toMatchObject({
        triggerEvalCount: 1,
        lastTriggerFireAtMs: expect.any(Number),
        lastRunStatus: "error",
      });
      // Old state survives so the next evaluation re-detects the change.
      expect(state?.triggerState).toBeUndefined();
    } finally {
      harness.cron.stop();
    }
  });

  it("reports a missing evaluator as an execution error", async () => {
    const harness = await createHarness({});
    try {
      const job = await harness.cron.add(watcher());
      await runWhenDue(harness.cron, job.id);
      expect(harness.cron.getJob(job.id)?.state).toMatchObject({
        consecutiveErrors: 1,
        lastRunStatus: "error",
        lastError: "cron trigger evaluator is unavailable",
      });
    } finally {
      harness.cron.stop();
    }
  });

  it("bypasses trigger evaluation for force runs", async () => {
    const evaluateCronTrigger = vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: false,
    }));
    const harness = await createHarness({ evaluateCronTrigger });
    try {
      const job = await harness.cron.add(watcher());
      expect(await harness.cron.run(job.id, "force")).toEqual({ ok: true, ran: true });
      expect(evaluateCronTrigger).not.toHaveBeenCalled();
      expect(harness.runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(harness.events.find((event) => event.action === "finished")).toMatchObject({
        status: "ok",
      });
      expect(
        harness.events.find((event) => event.action === "finished")?.triggerFired,
      ).toBeUndefined();
    } finally {
      harness.cron.stop();
    }
  });
});
