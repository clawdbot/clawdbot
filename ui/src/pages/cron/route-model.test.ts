// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveCronRouteData } from "./route-model.ts";

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
