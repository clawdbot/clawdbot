// Unit coverage for the active-job accounting the heartbeat busy guard depends on.
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCronJobActive,
  hasActiveCronJobs,
  hasActiveCronJobsExceptMarker,
  markCronJobActive,
  noteActiveCronJobRemoval,
  noteActiveCronJobScheduleMutation,
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

describe("active cron schedule ownership", () => {
  it("records durable job removal without releasing the active run marker", () => {
    const marker = markCronJobActive("removed-job");

    noteActiveCronJobRemoval("removed-job");

    expect(marker?.scheduleMutated).toBe(true);
    expect(marker?.jobRemoved).toBe(true);
    expect(hasActiveCronJobs()).toBe(true);
  });

  it("does not mistake an ordinary schedule edit for job removal", () => {
    const marker = markCronJobActive("updated-job");

    noteActiveCronJobScheduleMutation("updated-job");

    expect(marker?.scheduleMutated).toBe(true);
    expect(marker?.jobRemoved).toBeUndefined();
  });

  it("does not create active markers when removing an idle job", () => {
    noteActiveCronJobRemoval("idle-removed-job");

    expect(hasActiveCronJobs()).toBe(false);
  });

  it("records durable schedule mutations on the admitted active run", () => {
    const marker = markCronJobActive("rescheduled-job");

    noteActiveCronJobScheduleMutation("rescheduled-job");

    expect(marker?.scheduleMutated).toBe(true);
  });

  it("keeps a mutation after the schedule is edited back to its original value", () => {
    const marker = markCronJobActive("rescheduled-job");

    noteActiveCronJobScheduleMutation("rescheduled-job");
    noteActiveCronJobScheduleMutation("rescheduled-job");

    expect(marker?.scheduleMutated).toBe(true);
  });

  it("attributes later edits only to the replacement active run", () => {
    const retiredMarker = markCronJobActive("rescheduled-job");
    clearCronJobActive("rescheduled-job", retiredMarker);
    const replacementMarker = markCronJobActive("rescheduled-job");

    noteActiveCronJobScheduleMutation("rescheduled-job");

    expect(retiredMarker?.scheduleMutated).toBeUndefined();
    expect(replacementMarker?.scheduleMutated).toBe(true);
  });

  it("does not create ownership markers for jobs without an active run", () => {
    noteActiveCronJobScheduleMutation("idle-job");

    expect(hasActiveCronJobs()).toBe(false);
  });

  it("keeps schedule ownership isolated across concurrent active jobs", () => {
    const markers = Array.from({ length: 64 }, (_, index) =>
      markCronJobActive(`rescheduled-job-${index}`),
    );

    for (let index = 0; index < markers.length; index += 2) {
      noteActiveCronJobScheduleMutation(`rescheduled-job-${index}`);
      noteActiveCronJobScheduleMutation(`rescheduled-job-${index}`);
    }

    for (const [index, marker] of markers.entries()) {
      expect(marker?.scheduleMutated).toBe(index % 2 === 0 ? true : undefined);
    }
  });
});
