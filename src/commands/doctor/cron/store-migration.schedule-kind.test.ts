import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { normalizeStoredCronJobs } from "./store-migration.js";

const scheduleKindCases = [
  {
    id: "job-at-kind",
    canonicalKind: "at",
    schedule: { kind: " At ", at: "2026-08-31T10:00:00.000Z" },
  },
  {
    id: "job-every-kind",
    canonicalKind: "every",
    schedule: { kind: "Every", everyMs: 120_000 },
  },
  {
    id: "job-cron-kind",
    canonicalKind: "cron",
    schedule: { kind: " CRON ", cron: "17 * * * *", tz: "UTC" },
  },
  {
    id: "job-on-exit-kind",
    canonicalKind: "on-exit",
    schedule: { kind: " On-Exit ", command: "cleanup" },
  },
  {
    id: "job-stream-kind",
    canonicalKind: "stream",
    schedule: { kind: " Stream ", command: ["node", "events.mjs"], mode: "line" },
  },
];

describe("legacy cron schedule kind migration", () => {
  it.each(scheduleKindCases)(
    "keeps valid legacy $canonicalKind schedules active when kind needs normalization",
    ({ id, canonicalKind, schedule }) => {
      const jobs: Array<Record<string, unknown>> = [
        {
          id,
          name: "Legacy job",
          enabled: true,
          createdAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_000_000,
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          schedule,
          payload: { kind: "systemEvent", text: "tick" },
          state: {},
        },
      ];

      const result = normalizeStoredCronJobs(jobs);
      const job = expectDefined(jobs[0], "job test invariant");

      expect(result.removedJobs).toEqual([]);
      expect(result.issues.invalidSchedule).toBeUndefined();
      expect(job).toMatchObject({ id, enabled: true });
      expect((job.schedule as Record<string, unknown>).kind).toBe(canonicalKind);
    },
  );

  it("quarantines unknown kinds without rewriting the diagnostic row", () => {
    const jobs: Array<Record<string, unknown>> = [
      {
        id: "job-unknown-kind",
        name: "Unknown legacy job",
        enabled: true,
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_000_000,
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        schedule: { kind: " DAILY ", at: "09:00" },
        payload: { kind: "systemEvent", text: "tick" },
        state: {},
      },
    ];

    const result = normalizeStoredCronJobs(jobs);
    const removed = expectDefined(result.removedJobs[0], "removed job test invariant");

    expect(jobs).toEqual([]);
    expect(removed.reason).toBe("invalid-schedule");
    expect((removed.job.schedule as Record<string, unknown>).kind).toBe(" DAILY ");
  });
});
