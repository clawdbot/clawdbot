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

describe("add() must not drop a due every-job's pending run", () => {
  it("preserves a due every-job nextRunAtMs when an unrelated job is added", async () => {
    const store = await makeStorePath();
    const base = Date.parse("2025-12-13T00:00:00.000Z");

    const finished = createFinishedBarrier();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeat,
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

    vi.setSystemTime(new Date(base + 10_000 + 5));
    const firstRun = finished.waitForOk(jobId);
    await vi.runOnlyPendingTimersAsync();
    await firstRun;

    let current = (await cron.list({ includeDisabled: true })).find((j) => j.id === jobId)!;
    const lastRunAtMs = current.state.lastRunAtMs!;
    const dueSlot = current.state.nextRunAtMs!;
    expect(dueSlot).toBe(lastRunAtMs + 10_000);

    vi.setSystemTime(new Date(dueSlot + 50));
    const nowDue = dueSlot + 50;

    await cron.add({
      name: "unrelated daily",
      enabled: true,
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "daily" },
    });

    current = (await cron.list({ includeDisabled: true })).find((j) => j.id === jobId)!;
    expect(current.state.lastRunAtMs).toBe(lastRunAtMs);
    expect(current.state.nextRunAtMs).toBeLessThanOrEqual(nowDue);

    cron.stop();
  });
});
