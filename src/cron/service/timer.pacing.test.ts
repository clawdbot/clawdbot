import { describe, expect, it, vi } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createNoopLogger } from "../service.test-harness.js";
import type { CronJob, CronPacing } from "../types.js";
import { recomputeNextRunsForMaintenance } from "./jobs.js";
import { createCronServiceState } from "./state.js";
import { applyJobResult } from "./timer.js";

const ENDED_AT = Date.parse("2026-07-18T12:00:00.000Z");
const STARTED_AT = ENDED_AT - 1_000;

function makeState() {
  return createCronServiceState({
    storePath: "/tmp/cron-pacing-timer/jobs.json",
    cronEnabled: true,
    log: createNoopLogger(),
    nowMs: () => ENDED_AT,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

function makePacedJob(pacing: CronPacing, everyMs = 60 * 60_000): CronJob {
  return makeCronJob({
    pacing,
    schedule: { kind: "every", everyMs, anchorMs: STARTED_AT },
    state: { nextRunAtMs: STARTED_AT },
  });
}

describe("applyJobResult dynamic cadence", () => {
  it.each([
    ["honors an in-range proposal", { min: "15m", max: "4h" }, 60 * 60_000, 60 * 60_000],
    ["clamps below the minimum", { min: "15m", max: "4h" }, 5 * 60_000, 15 * 60_000],
    ["clamps above the maximum", { min: "15m", max: "4h" }, 6 * 60 * 60_000, 4 * 60 * 60_000],
    ["clamps a minimum-only job", { min: "15m" }, 5 * 60_000, 15 * 60_000],
    ["clamps a maximum-only job", { max: "4h" }, 6 * 60 * 60_000, 4 * 60 * 60_000],
  ] as const)("%s", (_label, pacing, delayMs, expectedDelayMs) => {
    const job = makePacedJob(pacing);

    applyJobResult(makeState(), job, {
      status: "ok",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      nextCheck: { delayMs },
    });

    expect(job.state.nextRunAtMs).toBe(ENDED_AT + expectedDelayMs);
    expect(job.state.pacedNextRunAtMs).toBe(ENDED_AT + expectedDelayMs);
  });

  it("keeps existing schedule math when no proposal was recorded", () => {
    const job = makePacedJob({ min: "15m", max: "4h" });
    job.state.pacedNextRunAtMs = ENDED_AT + 30 * 60_000;
    job.state.forcePreservedNextRunAtMs = job.state.nextRunAtMs;

    applyJobResult(makeState(), job, {
      status: "ok",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
    });

    expect(job.state.nextRunAtMs).toBe(STARTED_AT + 60 * 60_000);
    expect(job.state.pacedNextRunAtMs).toBeUndefined();
    expect(job.state.forcePreservedNextRunAtMs).toBeUndefined();
  });

  it.each([
    ["without a new proposal", undefined],
    ["when the forced run records a new proposal", 2 * 60 * 60_000],
  ] as const)("preserves the exact paced slot on a forced run %s", (_label, delayMs) => {
    const job = makePacedJob({ min: "15m", max: "4h" });
    const pendingSlot = ENDED_AT + 45 * 60_000;
    job.state.nextRunAtMs = pendingSlot;
    job.state.pacedNextRunAtMs = pendingSlot;

    applyJobResult(
      makeState(),
      job,
      {
        status: "ok",
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        ...(delayMs !== undefined ? { nextCheck: { delayMs } } : {}),
      },
      { origin: "operator" },
    );

    expect(job.state.nextRunAtMs).toBe(pendingSlot);
    expect(job.state.pacedNextRunAtMs).toBe(pendingSlot);
  });

  it("applies the built-in trigger floor after the job-local pacing clamp", () => {
    const job = makePacedJob({ min: "1s", max: "2m" });
    job.trigger = { script: "return true" };

    applyJobResult(makeState(), job, {
      status: "ok",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      nextCheck: { delayMs: 1_000 },
    });

    expect(job.state.nextRunAtMs).toBe(ENDED_AT + 30_000);
    expect(job.state.pacedNextRunAtMs).toBe(ENDED_AT + 30_000);
  });

  it("discards proposals on error so normal backoff wins", () => {
    const job = makePacedJob({ min: "1h", max: "2h" }, 10_000);
    job.state.pacedNextRunAtMs = ENDED_AT + 90 * 60_000;

    applyJobResult(makeState(), job, {
      status: "error",
      error: "temporary failure",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      nextCheck: { delayMs: 90 * 60_000 },
    });

    expect(job.state.nextRunAtMs).toBe(ENDED_AT + 30_000);
    expect(job.state.pacedNextRunAtMs).toBeUndefined();
  });

  it("preserves a paced cron-expression override during future-slot repair", () => {
    const state = makeState();
    const job = makeCronJob({
      pacing: { min: "15m", max: "4h" },
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      state: { nextRunAtMs: STARTED_AT },
    });
    state.store = { version: 1, jobs: [job] };

    applyJobResult(state, job, {
      status: "ok",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      nextCheck: { delayMs: 30 * 60_000 },
    });
    recomputeNextRunsForMaintenance(state, { nowMs: ENDED_AT + 1_000 });

    expect(job.state.nextRunAtMs).toBe(ENDED_AT + 30 * 60_000);
    expect(job.state.pacedNextRunAtMs).toBe(ENDED_AT + 30 * 60_000);
  });

  it("repairs an unmarked future slot even when it falls within pacing bounds", () => {
    const state = makeState();
    const job = makeCronJob({
      pacing: { min: "15m", max: "4h" },
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      state: { nextRunAtMs: STARTED_AT },
    });
    state.store = { version: 1, jobs: [job] };

    applyJobResult(state, job, {
      status: "ok",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
    });
    job.state.nextRunAtMs = ENDED_AT + 30 * 60_000 + 1_234;
    recomputeNextRunsForMaintenance(state, { nowMs: ENDED_AT + 1_000 });

    expect(job.state.nextRunAtMs).toBe(ENDED_AT + 60_000);
  });

  it("repairs a future slot whose persisted pacing marker does not match", () => {
    const state = makeState();
    const job = makeCronJob({
      pacing: { min: "15m", max: "4h" },
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      state: {
        nextRunAtMs: ENDED_AT + 30 * 60_000 + 1_234,
        pacedNextRunAtMs: ENDED_AT + 45 * 60_000,
      },
    });
    state.store = { version: 1, jobs: [job] };

    recomputeNextRunsForMaintenance(state, { nowMs: ENDED_AT + 1_000 });

    expect(job.state.nextRunAtMs).toBe(ENDED_AT + 60_000);
    expect(job.state.pacedNextRunAtMs).toBeUndefined();
  });

  it("clears a paced marker when maintenance normalizes the schedule", () => {
    const state = makeState();
    const pacedNextRunAtMs = ENDED_AT + 30 * 60_000;
    const job = makeCronJob({
      createdAtMs: STARTED_AT,
      updatedAtMs: STARTED_AT,
      pacing: { min: "15m" },
      schedule: { kind: "every", everyMs: 60 * 60_000 },
      state: { nextRunAtMs: pacedNextRunAtMs, pacedNextRunAtMs },
    });
    state.store = { version: 1, jobs: [job] };

    recomputeNextRunsForMaintenance(state, { nowMs: ENDED_AT + 1_000 });

    expect(job.schedule).toEqual({ kind: "every", everyMs: 60 * 60_000, anchorMs: STARTED_AT });
    expect(job.state.pacedNextRunAtMs).toBeUndefined();
  });
});
