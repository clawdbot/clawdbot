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
});
