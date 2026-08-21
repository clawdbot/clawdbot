// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { isCronJobActiveFailure } from "./cron-status.ts";

function failedJob(enabled: boolean): CronJob {
  return {
    enabled,
    state: { lastRunStatus: "error" },
  } as CronJob;
}

describe("isCronJobActiveFailure", () => {
  it("reports only enabled failed jobs as actionable", () => {
    expect(isCronJobActiveFailure(failedJob(true))).toBe(true);
    expect(isCronJobActiveFailure(failedJob(false))).toBe(false);
  });

  it("keeps auto-disabled jobs visible as failures", () => {
    // Auto-disable is the escalated failure state; without this the job drops
    // out of every failure surface at the moment the problem became permanent.
    const job = failedJob(false);
    job.state = {
      ...job.state,
      autoDisabled: { reason: "consecutive-failures", atMs: 1, consecutiveErrors: 10 },
    };
    expect(isCronJobActiveFailure(job)).toBe(true);
  });
});
