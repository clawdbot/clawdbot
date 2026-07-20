// Unit coverage for the active-job accounting the heartbeat busy guard depends on.
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCronJobActive,
  hasActiveCronJobs,
  hasActiveCronJobsExceptMarker,
  markCronJobActive,
  resetCronActiveJobs,
} from "./active-jobs.js";

afterEach(() => {
  resetCronActiveJobs();
});

describe("hasActiveCronJobsExceptMarker", () => {
  it("discounts only the named job's own marker", () => {
    const marker = markCronJobActive("nightly-report");

    expect(hasActiveCronJobs()).toBe(true);
    expect(hasActiveCronJobsExceptMarker(marker!)).toBe(false);
  });

  it("still reports busy while an unrelated job is active", () => {
    const marker = markCronJobActive("nightly-report");
    markCronJobActive("different-job");

    // The owning job must not be waved through while another run holds a marker:
    // Cron executes jobs up to the built-in concurrency limit.
    expect(hasActiveCronJobsExceptMarker(marker!)).toBe(true);
  });

  it("reports idle once the unrelated job clears", () => {
    const marker = markCronJobActive("nightly-report");
    const otherMarker = markCronJobActive("different-job");
    clearCronJobActive("different-job", otherMarker);

    expect(hasActiveCronJobsExceptMarker(marker!)).toBe(false);
  });

  it("does not discount a replacement marker with the same job id", () => {
    const staleMarker = markCronJobActive("nightly-report");
    const replacementMarker = markCronJobActive("nightly-report");

    expect(hasActiveCronJobsExceptMarker(staleMarker!)).toBe(true);
    expect(hasActiveCronJobsExceptMarker(replacementMarker!)).toBe(false);
  });
});
