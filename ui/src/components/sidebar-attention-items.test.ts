import { describe, expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { buildSidebarAttentionEntries } from "./sidebar-attention-items.ts";

function cronJob(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "test" },
    state: { lastRunStatus: "error" },
  };
}

function cronItems(cronJobs: readonly CronJob[], now = 0, cronSchedulerEnabled = true) {
  return buildSidebarAttentionEntries({
    cronJobs,
    cronSchedulerEnabled,
    modelAuthStatus: null,
    now,
  });
}

describe("automation attention", () => {
  it("lists each failed job as direct automation navigation", () => {
    const primary = cronJob("primary");
    primary.name = "Nightly backup";
    primary.state = { lastRunStatus: "error", lastError: "  disk full  " };
    const reason = cronJob("reason-id");
    reason.name = "";
    reason.state = {
      lastRunStatus: "error",
      lastError: "   ",
      lastErrorReason: "timeout",
    };
    const unknown = cronJob("unknown-id");

    const failed = cronItems([primary, reason, unknown]).filter(
      (item) => item.kind === "cronFailed",
    );

    expect(failed.map((item) => item.label)).toEqual(["Nightly backup", "reason-id", "unknown-id"]);
    expect(failed.every((item) => item.action.kind === "navigate")).toBe(true);
    expect(
      failed.every((item) => item.action.kind !== "navigate" || item.action.routeId === "cron"),
    ).toBe(true);
  });

  it("does not flag an actively running job as overdue", () => {
    // The gateway leaves nextRunAtMs past-due during execution; runningAtMs is
    // the recorded fact that a run is in flight (agentTurn runs may take up to
    // an hour, far beyond the 5-minute overdue grace).
    const running = cronJob("running-id");
    running.state = { lastRunStatus: "ok", nextRunAtMs: 1, runningAtMs: 2 };
    const stalled = cronJob("stalled-id");
    stalled.state = { lastRunStatus: "ok", nextRunAtMs: 2 };

    const overdue = cronItems([running, stalled], 300_003).find(
      (item) => item.kind === "cronOverdue",
    );

    expect(overdue?.label).toBe("stalled-id");
  });

  it("does not flag an enabled overdue job while the scheduler is disabled", () => {
    const overdue = cronJob("overdue-id");
    overdue.state = { lastRunStatus: "ok", nextRunAtMs: 1 };

    expect(cronItems([overdue], 300_002, false)).not.toContainEqual(
      expect.objectContaining({ kind: "cronOverdue" }),
    );
  });

  it("shows automation owners only when the caller supplies an all-agent owner map", () => {
    const item = buildSidebarAttentionEntries({
      cronJobs: [cronJob("writer-job")],
      cronSchedulerEnabled: true,
      cronOwnerByJobId: new Map([["writer-job", "Writer"]]),
      modelAuthStatus: null,
      now: 0,
    })[0];

    expect(item?.meta?.context).toBe("Writer");
  });

  it("orders failed before overdue and newest first within each group", () => {
    const failedJob = cronJob("failed");
    failedJob.state = { lastRunStatus: "error", lastRunAtMs: 200 };
    const olderFailedJob = cronJob("older-failed");
    olderFailedJob.state = { lastRunStatus: "error", lastRunAtMs: 100 };
    const overdueJob = cronJob("overdue");
    overdueJob.state = { lastRunStatus: "ok", nextRunAtMs: 2 };
    const olderOverdueJob = cronJob("older-overdue");
    olderOverdueJob.state = { lastRunStatus: "ok", nextRunAtMs: 1 };

    const items = cronItems(
      [olderOverdueJob, olderFailedJob, overdueJob, failedJob],
      300_003,
    ).filter((item) => item.kind === "cronFailed" || item.kind === "cronOverdue");

    expect(items.map((item) => item.label)).toEqual([
      "failed",
      "older-failed",
      "overdue",
      "older-overdue",
    ]);
  });
});
