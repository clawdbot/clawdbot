import { describe, expect, it, vi } from "vitest";
import {
  clearCronJobActive,
  markCronJobActive,
  noteActiveCronJobTriggerMutation,
} from "../active-jobs.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createNoopLogger } from "../service.test-harness.js";
import type { CronJob, CronPacing } from "../types.js";
import { recomputeNextRunsForMaintenance } from "./jobs.js";
import { createCronServiceState } from "./state.js";
import { applyOutcomeToStoredJob, applyTriggerNoFireResult } from "./timer-outcomes.js";
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

describe("cron trigger evaluation ownership", () => {
  it("keeps a replacement once trigger armed after an obsolete fired payload", () => {
    const state = makeState();
    const job = makePacedJob({ min: "15m" });
    job.trigger = { script: "old trigger", once: true };
    const admittedJob = structuredClone(job);
    job.trigger = { script: "replacement trigger", once: true };
    job.state.triggerState = { owner: "replacement" };
    state.store = { version: 1, jobs: [job] };

    applyOutcomeToStoredJob(state, {
      jobId: job.id,
      job: admittedJob,
      status: "ok",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      triggerEval: { fired: true, stateChanged: true, state: { owner: "obsolete trigger" } },
      scriptStateChanged: true,
      scriptState: { owner: "obsolete payload" },
    });

    expect(job.enabled).toBe(true);
    expect(job.state.triggerState).toEqual({ owner: "replacement" });
    expect(job.state.lastTriggerEvalAtMs).toBeUndefined();
    expect(job.state.nextRunAtMs).toBeGreaterThan(ENDED_AT);
  });

  it("does not let an obsolete quiet evaluation replace current trigger state", () => {
    const state = makeState();
    const job = makePacedJob({ min: "15m" });
    job.trigger = { script: "old trigger" };
    const admittedJob = structuredClone(job);
    job.trigger = { script: "replacement trigger" };
    job.state.triggerState = { owner: "replacement" };
    job.state.consecutiveErrors = 3;
    job.state.scheduleErrorCount = 2;
    state.store = { version: 1, jobs: [job] };

    applyOutcomeToStoredJob(state, {
      jobId: job.id,
      job: admittedJob,
      status: "ok",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      triggerEval: { fired: false, stateChanged: true, state: { owner: "obsolete" } },
    });

    expect(job.state.triggerState).toEqual({ owner: "replacement" });
    expect(job.state.triggerEvalCount).toBeUndefined();
    expect(job.state.consecutiveErrors).toBe(3);
    expect(job.state.scheduleErrorCount).toBe(2);
    expect(job.state.nextRunAtMs).toBeGreaterThan(ENDED_AT);
  });

  it("retains trigger ownership when an edited script is restored during its active run", () => {
    const state = makeState();
    const job = makePacedJob({ min: "15m" });
    job.trigger = { script: "original trigger", once: true };
    const admittedJob = structuredClone(job);
    job.state.triggerState = { owner: "latest edit" };
    state.store = { version: 1, jobs: [job] };
    const activeJobMarker = markCronJobActive(job.id);
    noteActiveCronJobTriggerMutation(job.id);

    try {
      applyOutcomeToStoredJob(state, {
        jobId: job.id,
        job: admittedJob,
        activeJobMarker,
        status: "ok",
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        triggerEval: { fired: true, stateChanged: true, state: { owner: "obsolete" } },
      });

      expect(job.enabled).toBe(true);
      expect(job.state.triggerState).toEqual({ owner: "latest edit" });
      expect(job.state.lastTriggerFireAtMs).toBeUndefined();
    } finally {
      clearCronJobActive(job.id, activeJobMarker);
    }
  });
});

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

  it("clears the consumed pacing override after a current quiet trigger", () => {
    const state = makeState();
    const job = makePacedJob({ min: "15m", max: "4h" });
    job.state.pacedNextRunAtMs = ENDED_AT + 30 * 60_000;
    state.store = { version: 1, jobs: [job] };
    const admittedJob = structuredClone(job);

    applyOutcomeToStoredJob(state, {
      jobId: job.id,
      job: admittedJob,
      status: "ok",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      triggerEval: { fired: false, stateChanged: false },
    });

    expect(job.state.pacedNextRunAtMs).toBeUndefined();
  });

  it.each([
    ["without a force marker", undefined],
    ["with an existing force marker", ENDED_AT + 15 * 60_000],
  ] as const)("preserves an edited pacing override after a stale quiet trigger %s", (_, marker) => {
    const state = makeState();
    const job = makePacedJob({ min: "15m", max: "4h" });
    const admittedJob = structuredClone(job);
    const editedNextRunAtMs = ENDED_AT + 45 * 60_000;
    job.schedule = { kind: "every", everyMs: 2 * 60 * 60_000, anchorMs: STARTED_AT };
    job.state.nextRunAtMs = editedNextRunAtMs;
    job.state.pacedNextRunAtMs = editedNextRunAtMs;
    job.state.forcePreservedNextRunAtMs = marker;
    state.store = { version: 1, jobs: [job] };

    applyOutcomeToStoredJob(state, {
      jobId: job.id,
      job: admittedJob,
      status: "ok",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      triggerEval: { fired: false, stateChanged: false },
    });

    expect(job.state.nextRunAtMs).toBe(editedNextRunAtMs);
    expect(job.state.pacedNextRunAtMs).toBe(editedNextRunAtMs);
    expect(job.state.forcePreservedNextRunAtMs).toBe(marker);
  });

  it.each([
    ["without a previous marker", undefined],
    ["with a previous marker", ENDED_AT + 15 * 60_000],
  ] as const)("marks the exact paced slot after a forced quiet trigger %s", (_, previousMarker) => {
    const job = makePacedJob({ min: "15m", max: "4h" });
    const pendingSlot = ENDED_AT + 45 * 60_000;
    job.state.nextRunAtMs = pendingSlot;
    job.state.pacedNextRunAtMs = pendingSlot;
    job.state.forcePreservedNextRunAtMs = previousMarker;

    applyTriggerNoFireResult(
      makeState(),
      job,
      {
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        triggerEval: { fired: false, stateChanged: false },
      },
      { scheduleMode: "force-preserve" },
    );

    expect(job.state.nextRunAtMs).toBe(pendingSlot);
    expect(job.state.pacedNextRunAtMs).toBe(pendingSlot);
    expect(job.state.forcePreservedNextRunAtMs).toBe(pendingSlot);
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
      { scheduleMode: "preserve" },
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
