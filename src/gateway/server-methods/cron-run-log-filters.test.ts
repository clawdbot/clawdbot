import { describe, expect, it } from "vitest";
import type { CronJob } from "../../cron/types.js";
import { filterCronRunLogJobsByAgent } from "./cron-run-log-filters.js";

function createJob(overrides: Partial<CronJob>): CronJob {
  return {
    id: "job-1",
    name: "Scheduled work",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
    ...overrides,
  };
}

describe("filterCronRunLogJobsByAgent", () => {
  it("uses the agent owned by a scoped session instead of the configured default", () => {
    const scopedJob = createJob({ id: "scoped", sessionKey: "agent:ops:main" });
    const defaultJob = createJob({ id: "default" });

    expect(filterCronRunLogJobsByAgent([scopedJob, defaultJob], "ops", "main")).toEqual([
      scopedJob,
    ]);
    expect(filterCronRunLogJobsByAgent([scopedJob, defaultJob], "main", "main")).toEqual([
      defaultJob,
    ]);
  });

  it("uses scoped ownership when an optional explicit agent is blank", () => {
    const scopedJob = createJob({
      id: "scoped",
      agentId: "   ",
      sessionKey: "agent:ops:main",
    });

    expect(filterCronRunLogJobsByAgent([scopedJob], "OPS", "main")).toEqual([scopedJob]);
    expect(filterCronRunLogJobsByAgent([scopedJob], "main", "main")).toEqual([]);
  });

  it("does not resolve ownership when no agent filter was requested", () => {
    const job = createJob({ id: "unfiltered" });

    expect(filterCronRunLogJobsByAgent([job], undefined, undefined)).toEqual([job]);
  });
});
