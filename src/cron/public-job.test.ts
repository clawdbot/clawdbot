import { describe, expect, it } from "vitest";
import { makeCronJob } from "./delivery.test-helpers.js";
import { toPublicCronJob } from "./public-job.js";

describe("toPublicCronJob", () => {
  it("strips scheduler-only pacing slots without mutating stored state", () => {
    const job = makeCronJob({
      state: {
        nextRunAtMs: 2_000,
        pacedNextRunAtMs: 2_000,
        forcePreservedNextRunAtMs: 2_000,
      },
    });

    const publicJob = toPublicCronJob(job);

    expect(publicJob.state.pacedNextRunAtMs).toBeUndefined();
    expect(publicJob.state.forcePreservedNextRunAtMs).toBeUndefined();
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
});
