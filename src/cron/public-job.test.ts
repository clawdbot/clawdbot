import { describe, expect, it } from "vitest";
import { makeCronJob } from "./delivery.test-helpers.js";
import { toPublicCronJob } from "./public-job.js";
import type { CronStoredJob } from "./types.js";

describe("toPublicCronJob", () => {
  it("strips scheduler-only state without mutating the stored job", () => {
    const job = makeCronJob({
      state: {
        nextRunAtMs: 2_000,
        queuedAtMs: 1_900,
        startupCatchupAtMs: 2_000,
        pacedNextRunAtMs: 2_000,
        forcePreservedNextRunAtMs: 2_000,
      },
    });

    const publicJob = toPublicCronJob(job);

    expect(publicJob.state.queuedAtMs).toBeUndefined();
    expect(publicJob.state.startupCatchupAtMs).toBeUndefined();
    expect(publicJob.state.pacedNextRunAtMs).toBeUndefined();
    expect(publicJob.state.forcePreservedNextRunAtMs).toBeUndefined();
    expect(job.state.queuedAtMs).toBe(1_900);
    expect(job.state.startupCatchupAtMs).toBe(2_000);
    expect(job.state.pacedNextRunAtMs).toBe(2_000);
    expect(job.state.forcePreservedNextRunAtMs).toBe(2_000);
  });

  it("projects script payload fields without exposing scheduler-only state", () => {
    const job = makeCronJob({
      sessionTarget: "isolated",
      payload: {
        kind: "script",
        script: "return { notify: 'done' }",
        timeoutSeconds: 300,
        toolBudget: 50,
      },
      state: { triggerState: { revision: 1 }, pacedNextRunAtMs: 2_000 },
    });

    expect(toPublicCronJob(job)).toMatchObject({
      payload: {
        kind: "script",
        script: "return { notify: 'done' }",
        timeoutSeconds: 300,
        toolBudget: 50,
      },
      state: { triggerState: { revision: 1 } },
    });
  });

  it("strips private tool-cap provenance without mutating the stored job", () => {
    const job: CronStoredJob = {
      ...makeCronJob({}),
      toolsAllowProvenance: { version: 1, source: "final-executable-surface" },
    };

    expect(toPublicCronJob(job)).not.toHaveProperty("toolsAllowProvenance");
    expect(job.toolsAllowProvenance).toEqual({
      version: 1,
      source: "final-executable-surface",
    });
  });

  it("strips private creator provenance without mutating the stored job", () => {
    const job: CronStoredJob = {
      ...makeCronJob({}),
      createdActor: { type: "human", id: "profile-ada" },
    };

    expect(toPublicCronJob(job)).not.toHaveProperty("createdActor");
    expect(job.createdActor).toEqual({ type: "human", id: "profile-ada" });
  });

  it("strips private runtime authority without mutating the stored job", () => {
    const runtimeAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };
    const job: CronStoredJob = {
      ...makeCronJob({}),
      runtimeAuthority,
      runtimeAuthorityRecoveryRequired: true,
    };

    expect(toPublicCronJob(job)).not.toHaveProperty("runtimeAuthority");
    expect(toPublicCronJob(job)).not.toHaveProperty("runtimeAuthorityRecoveryRequired");
    expect(job.runtimeAuthority).toEqual(runtimeAuthority);
    expect(job.runtimeAuthorityRecoveryRequired).toBe(true);
  });
});
