import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createFinishedBarrier,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

describe("update() must not drop a due every-job's pending run", () => {
  it("preserves a due every-job nextRunAtMs on an idempotent schedule re-save", async () => {
    const store = await makeStorePath();
    const base = Date.parse("2025-12-13T00:00:00.000Z");

    const finished = createFinishedBarrier();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent: finished.onEvent,
    });

    await cron.start();

    const job = await cron.add({
      name: "every 10s",
      enabled: true,
      schedule: { kind: "every", everyMs: 10_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "tick" },
    });
    const jobId = job.id;
    expect(job.state.nextRunAtMs).toBe(base + 10_000);

    // Fire once so the job carries lastRunAtMs and a real next due slot.
    vi.setSystemTime(new Date(base + 10_000 + 5));
    const firstRun = finished.waitForOk(jobId);
    await vi.runOnlyPendingTimersAsync();
    await firstRun;

    let current = (await cron.list({ includeDisabled: true })).find((j) => j.id === jobId)!;
    const lastRunAtMs = current.state.lastRunAtMs!;
    const dueSlot = current.state.nextRunAtMs!;
    expect(dueSlot).toBe(lastRunAtMs + 10_000);

    // Advance past the next slot so it is now due, before the timer services it.
    vi.setSystemTime(new Date(dueSlot + 50));
    const nowDue = dueSlot + 50;

    // User edits the job and the control UI resubmits the unchanged schedule
    // (a normal idempotent re-save, e.g. while changing the message). This must
    // not advance the already-due slot.
    await cron.update(jobId, { schedule: { kind: "every", everyMs: 10_000 } });

    current = (await cron.list({ includeDisabled: true })).find((j) => j.id === jobId)!;
    // Correct: the due slot is preserved so the pending run still fires.
    // Buggy (current main): nextRunAtMs jumps to dueSlot + 10_000 (> nowDue),
    // silently dropping this slot's run.
    expect(current.state.lastRunAtMs).toBe(lastRunAtMs);
    expect(current.state.nextRunAtMs).toBe(dueSlot);
    expect(current.state.nextRunAtMs).toBeLessThanOrEqual(nowDue);
    // The cadence anchor must not re-phase to "now" on an idempotent re-save.
    expect(current.schedule).toMatchObject({ kind: "every", anchorMs: base });

    cron.stop();
  });

  it("re-anchors an every-job to the edit time when the interval actually changes", async () => {
    const store = await makeStorePath();
    const base = Date.parse("2025-12-13T00:00:00.000Z");

    const finished = createFinishedBarrier();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent: finished.onEvent,
    });

    await cron.start();

    const job = await cron.add({
      name: "every 10s",
      enabled: true,
      schedule: { kind: "every", everyMs: 10_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "tick" },
    });
    const jobId = job.id;
    expect(job.schedule).toMatchObject({ kind: "every", anchorMs: base });

    // User edits the interval from 10s to 1h. The control UI omits the internal
    // anchorMs, so the new cadence must start from the edit time rather than
    // keeping the old phase; nextRunAtMs is one new interval from now.
    const editTime = base + 3_000;
    vi.setSystemTime(new Date(editTime));
    await cron.update(jobId, { schedule: { kind: "every", everyMs: 3_600_000 } });

    const current = (await cron.list({ includeDisabled: true })).find((j) => j.id === jobId)!;
    expect(current.schedule).toMatchObject({
      kind: "every",
      everyMs: 3_600_000,
      anchorMs: editTime,
    });
    expect(current.state.nextRunAtMs).toBe(editTime + 3_600_000);

    cron.stop();
  });

  it("preserves a due cron-job nextRunAtMs on an idempotent schedule re-save", async () => {
    const store = await makeStorePath();
    vi.setSystemTime(new Date("2025-12-13T08:59:00.000Z"));

    const finished = createFinishedBarrier();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent: finished.onEvent,
    });

    await cron.start();

    const job = await cron.add({
      name: "daily 9am",
      enabled: true,
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "report" },
    });
    const jobId = job.id;
    const dueSlot = job.state.nextRunAtMs!;

    // Advance past the 09:00 slot so it is now due, before the timer fires it.
    vi.setSystemTime(new Date(dueSlot + 50));
    const nowDue = dueSlot + 50;

    await cron.update(jobId, { schedule: { kind: "cron", expr: "0 9 * * *" } });

    const current = (await cron.list({ includeDisabled: true })).find((j) => j.id === jobId)!;
    // Correct: the due slot is preserved. Buggy main: nextRunAtMs jumps to the
    // next day, dropping today's run.
    expect(current.state.nextRunAtMs).toBe(dueSlot);
    expect(current.state.nextRunAtMs).toBeLessThanOrEqual(nowDue);

    cron.stop();
  });
});
