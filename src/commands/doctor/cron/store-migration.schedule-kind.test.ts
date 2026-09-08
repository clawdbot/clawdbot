import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { QuarantinedCronConfigJob } from "../../../cron/store/types.js";
import {
  normalizeStoredCronJobs,
  recoverValidQuarantinedCronScheduleJobs,
} from "./store-migration.js";

function makeJob(id: string, schedule: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    schedule,
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
  };
}

describe("legacy cron schedule enum migration", () => {
  it.each([
    ["at", { kind: " At ", at: "2026-08-31T10:00:00.000Z" }],
    ["every", { kind: "Every", everyMs: 120_000 }],
    ["cron", { kind: " CRON ", cron: "17 * * * *", tz: "UTC" }],
    ["on-exit", { kind: " On-Exit ", command: "cleanup" }],
    ["stream", { kind: " Stream ", command: ["node", "events.mjs"], mode: " LINE " }],
  ])("keeps and canonicalizes a recognized %s schedule", (canonicalKind, schedule) => {
    const jobs = [makeJob(`job-${canonicalKind}`, schedule)];

    const result = normalizeStoredCronJobs(jobs);
    const job = expectDefined(jobs[0], "job test invariant");

    expect(result.removedJobs).toEqual([]);
    expect(result.issues.invalidSchedule).toBeUndefined();
    expect((job.schedule as Record<string, unknown>).kind).toBe(canonicalKind);
    if (canonicalKind === "stream") {
      expect((job.schedule as Record<string, unknown>).mode).toBe("line");
    }
  });

  it("preserves an unknown kind in quarantine diagnostics", () => {
    const jobs = [makeJob("unknown", { kind: " DAILY ", at: "09:00" })];

    const result = normalizeStoredCronJobs(jobs);
    const removed = expectDefined(result.removedJobs[0], "removed job test invariant");

    expect(jobs).toEqual([]);
    expect(removed.reason).toBe("invalid-schedule");
    expect((removed.job.schedule as Record<string, unknown>).kind).toBe(" DAILY ");
  });

  it("does not report an issue for an already canonical kind", () => {
    const jobs = [makeJob("canonical", { kind: "cron", expr: "0 7 * * *" })];

    const result = normalizeStoredCronJobs(jobs);

    expect(result.issues.legacyScheduleKind).toBeUndefined();
    expect(result.removedJobs).toEqual([]);
  });

  it("recovers only currently valid schedule rows and preserves recovery state", () => {
    const entries: QuarantinedCronConfigJob[] = [
      {
        sourceIndex: 0,
        reason: "invalid-schedule",
        job: makeJob("variant", { kind: " CRON ", expr: "0 7 * * *" }),
        state: { nextRunAtMs: 123 },
        updatedAtMs: 456,
      },
      {
        sourceIndex: 1,
        reason: "invalid-schedule",
        job: makeJob("canonical", { kind: "every", everyMs: 60_000, anchorMs: 1 }),
      },
      {
        sourceIndex: 2,
        reason: "invalid-schedule",
        job: makeJob("unknown", { kind: "daily", at: "09:00" }),
      },
      {
        sourceIndex: 3,
        reason: "invalid-schedule",
        job: makeJob("existing", { kind: "cron", expr: "0 8 * * *" }),
      },
      {
        sourceIndex: 4,
        reason: "missing-payload",
        job: makeJob("other-reason", { kind: "cron", expr: "0 9 * * *" }),
      },
    ];

    const result = recoverValidQuarantinedCronScheduleJobs(entries, new Set(["existing"]));

    expect(result.recoveredJobs.map((job) => job.id)).toEqual(["variant", "canonical"]);
    expect(result.recoveredJobs[0]).toMatchObject({
      schedule: { kind: "cron" },
      state: { nextRunAtMs: 123 },
      updatedAtMs: 456,
    });
    expect(result.retainedEntries.map((entry) => entry.sourceIndex)).toEqual([2, 3, 4]);
  });
});
