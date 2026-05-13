import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  setupCronServiceSuite,
} from "./service.test-harness.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-16156-",
  baseTimeIso: "2025-12-13T00:00:00.000Z",
});

async function writeJobsStore(storePath: string, jobs: unknown[]) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }, null, 2), "utf-8");
}

function createCronFromStorePath(storePath: string) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

function requireEnqueueSystemEventCall(
  enqueueSystemEvent: ReturnType<typeof vi.fn>,
): [string, { agentId?: string } | undefined] {
  const call = enqueueSystemEvent.mock.calls[0];
  if (!call) {
    throw new Error("Expected enqueueSystemEvent call");
  }
  return call as [string, { agentId?: string } | undefined];
}

describe("#16156: cron.list() must not silently advance past-due recurring jobs", () => {
  it("does not skip a cron job when list() is called while the job is past-due", async () => {
    const store = await makeStorePath();
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });

    await cron.start();

    // Create a cron job that fires every minute.
    const job = await cron.add({
      name: "every-minute",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "cron-tick" },
    });

    const firstDueAt = job.state.nextRunAtMs!;
    expect(firstDueAt).toBe(Date.parse("2025-12-13T00:01:00.000Z"));

    // Advance time so the job is past-due but the timer hasn't fired yet.
    vi.setSystemTime(new Date(firstDueAt + 5));

    // Simulate the user running `cron list` while the job is past-due.
    // Before the fix, this would call recomputeNextRuns() which silently
    // advances nextRunAtMs to the next occurrence (00:02:00) without
    // executing the job.
    const listedBefore = await cron.list({ includeDisabled: true });
    const jobBeforeTimer = listedBefore.find((j) => j.id === job.id);

    // The job should still show the past-due nextRunAtMs, NOT the advanced one.
    expect(jobBeforeTimer?.state.nextRunAtMs).toBe(firstDueAt);

    // Now let the timer fire. The job should be found as due and execute.
    await vi.runOnlyPendingTimersAsync();

    await finished.waitForOk(job.id);

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === job.id);

    // Job must have actually executed.
    const [text, options] = requireEnqueueSystemEventCall(enqueueSystemEvent);
    expect(text).toBe("cron-tick");
    expect(options?.agentId).toBeUndefined();
    expect(updated?.state.lastStatus).toBe("ok");
    // nextRunAtMs must advance to a future minute boundary after execution.
    expect(updated?.state.nextRunAtMs).toBeGreaterThan(firstDueAt);

    cron.stop();
  });

  it("does not skip a cron job when status() is called while the job is past-due", async () => {
    const store = await makeStorePath();
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });

    await cron.start();

    const job = await cron.add({
      name: "five-min-cron",
      enabled: true,
      schedule: { kind: "cron", expr: "*/5 * * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick-5" },
    });

    const firstDueAt = job.state.nextRunAtMs!;

    // Advance time past due.
    vi.setSystemTime(new Date(firstDueAt + 10));

    // Call status() while job is past-due.
    await cron.status();

    // Timer fires.
    await vi.runOnlyPendingTimersAsync();

    await finished.waitForOk(job.id);

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === job.id);

    const [text, options] = requireEnqueueSystemEventCall(enqueueSystemEvent);
    expect(text).toBe("tick-5");
    expect(options?.agentId).toBeUndefined();
    expect(updated?.state.lastStatus).toBe("ok");

    cron.stop();
  });

  it("still fills missing nextRunAtMs via list() for enabled jobs", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");

    // Write a store file with a cron job that has no nextRunAtMs.
    await writeJobsStore(store.storePath, [
      {
        id: "missing-next",
        name: "missing next",
        enabled: true,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "fill-me" },
        state: {},
      },
    ]);

    const cron = createCronFromStorePath(store.storePath);

    await cron.start();

    // list() should fill in the missing nextRunAtMs via maintenance recompute.
    const jobs = await cron.list({ includeDisabled: true });
    const job = jobs.find((j) => j.id === "missing-next");

    expect(job?.state.nextRunAtMs).toBeTypeOf("number");
    expect(job?.state.nextRunAtMs).toBeGreaterThan(nowMs);

    cron.stop();
  });
});
