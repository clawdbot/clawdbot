// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cronRunEntryMatchesLink, resolveCronRouteData } from "./route-model.ts";

describe("resolveCronRouteData", () => {
  it.each([
    { scenario: "an empty search", search: "", jobId: null, runId: null },
    { scenario: "a job only", search: "?job=job-1", jobId: "job-1", runId: null },
    {
      scenario: "a job and run",
      search: "?job=job-1&run=cron%3Ajob-1%3A123",
      jobId: "job-1",
      runId: "cron:job-1:123",
    },
    {
      scenario: "blank and whitespace values",
      search: "?job=%20%20&run=%20%20",
      jobId: null,
      runId: null,
    },
    {
      scenario: "a blank run on an existing job",
      search: "?job=%20job-1%20&run=%20%20",
      jobId: "job-1",
      runId: null,
    },
    { scenario: "a run without a job", search: "?run=run-1", jobId: null, runId: null },
    {
      scenario: "plus-encoded spaces",
      search: "?job=job+one&run=run+one",
      jobId: "job one",
      runId: "run one",
    },
  ])("normalizes $scenario", ({ search, jobId, runId }) => {
    expect(resolveCronRouteData(search)).toEqual({ jobId, runId });
  });
});

describe("cronRunEntryMatchesLink", () => {
  const entry = {
    jobId: "job-1",
    runId: "manual:job-1:1787732891668:1",
    runAtMs: 1_787_732_891_692,
  };

  it.each([
    {
      scenario: "the exact public run id",
      linked: "manual:job-1:1787732891668:1",
      matches: true,
    },
    {
      scenario: "the execution id via the recorded run start",
      linked: "cron:job-1:1787732891692",
      matches: true,
    },
    {
      scenario: "an execution id for another job",
      linked: "cron:job-2:1787732891692",
      matches: false,
    },
    {
      scenario: "an execution id with a different run start",
      linked: "cron:job-1:1787732891693",
      matches: false,
    },
    { scenario: "an unrelated id", linked: "run-1", matches: false },
  ])("matches $scenario", ({ linked, matches }) => {
    expect(cronRunEntryMatchesLink(linked, entry)).toBe(matches);
  });

  it("does not match an execution id when the entry has no recorded run start", () => {
    expect(
      cronRunEntryMatchesLink("cron:job-1:1787732891692", { jobId: "job-1", runId: "abc" }),
    ).toBe(false);
  });
});
