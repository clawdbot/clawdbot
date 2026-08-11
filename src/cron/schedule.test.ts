// Cron schedule tests cover schedule parsing and next-run calculations.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { Cron } from "croner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { coerceFiniteScheduleNumber } from "./schedule-number.js";
import { computeNextRunAtMs, computePreviousRunAtMs } from "./schedule.js";
import {
  clearCronScheduleCacheForTest,
  getCronScheduleCacheMaxForTest,
  getCronScheduleCacheSizeForTest,
  hasCronInCacheForTest,
} from "./schedule.test-support.js";

function requireTimestamp(value: number | undefined, label: string): number {
  if (value === undefined) {
    throw new Error(`expected ${label} timestamp`);
  }
  return value;
}

describe("cron schedule", () => {
  beforeEach(() => {
    clearCronScheduleCacheForTest();
  });

  it("computes next run for cron expression with timezone", () => {
    // Saturday, Dec 13 2025 00:00:00Z
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "0 9 * * 3", tz: "America/Los_Angeles" },
      nowMs,
    );
    // Next Wednesday at 09:00 PST -> 17:00Z
    expect(next).toBe(Date.parse("2025-12-17T17:00:00.000Z"));
  });

  it("does not roll back year for Asia/Shanghai daily cron schedules (#30351)", () => {
    // 2026-03-01 08:00:00 in Asia/Shanghai
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
      nowMs,
    );

    // Next 08:00 local should be the following day, not a past year.
    expect(next).toBe(Date.parse("2026-03-02T00:00:00.000Z"));
    expect(next).toBeGreaterThan(nowMs);
    expect(new Date(next ?? 0).getUTCFullYear()).toBe(2026);
  });

  describe("daylight-saving transitions", () => {
    it.each([
      {
        label: "New York repeated hour retains the later same-day reminder",
        timezone: "America/New_York",
        expression: "30 1,3 * * *",
        now: "2026-11-01T06:15:00.000Z",
        next: "2026-11-01T08:30:00.000Z",
        previous: "2026-11-01T05:30:00.000Z",
      },
      {
        label: "New York repeated hour retains six-field reminders",
        timezone: "America/New_York",
        expression: "15 30 1,3 * * *",
        now: "2026-11-01T06:15:00.000Z",
        next: "2026-11-01T08:30:15.000Z",
        previous: "2026-11-01T05:30:15.000Z",
      },
      {
        label: "New York repeated hour skips duplicate per-minute occurrences",
        timezone: "America/New_York",
        expression: "* * * * *",
        now: "2026-11-01T06:15:00.000Z",
        next: "2026-11-01T07:00:00.000Z",
        previous: "2026-11-01T05:59:00.000Z",
      },
      {
        label: "New York repeated hour skips duplicate per-second occurrences",
        timezone: "America/New_York",
        expression: "* * * * * *",
        now: "2026-11-01T06:15:00.000Z",
        next: "2026-11-01T07:00:00.000Z",
        previous: "2026-11-01T05:59:59.000Z",
      },
      {
        label: "Oslo repeated hour retains the later same-day reminder",
        timezone: "Europe/Oslo",
        expression: "30 2,4 * * *",
        now: "2026-10-25T01:15:00.000Z",
        next: "2026-10-25T03:30:00.000Z",
        previous: "2026-10-25T00:30:00.000Z",
      },
      {
        label: "Lord Howe schedules the first occurrence of a half-hour fold",
        timezone: "Australia/Lord_Howe",
        expression: "45 1 * * *",
        now: "2026-04-04T14:40:00.000Z",
        next: "2026-04-04T14:45:00.000Z",
        previous: "2026-04-03T14:45:00.000Z",
      },
      {
        label: "Lord Howe repeated half-hour retains the later same-day reminder",
        timezone: "Australia/Lord_Howe",
        expression: "45 1,2 * * *",
        now: "2026-04-04T15:10:00.000Z",
        next: "2026-04-04T16:15:00.000Z",
        previous: "2026-04-04T14:45:00.000Z",
      },
      {
        label: "Lord Howe repeated half-hour skips duplicate per-second occurrences",
        timezone: "Australia/Lord_Howe",
        expression: "* * * * * *",
        now: "2026-04-04T15:10:00.000Z",
        next: "2026-04-04T15:30:00.000Z",
        previous: "2026-04-04T14:59:59.000Z",
      },
      {
        label: "New York skips a nonexistent spring-forward reminder",
        timezone: "America/New_York",
        expression: "30 2 * * *",
        now: "2027-03-14T06:45:00.000Z",
        next: "2027-03-15T06:30:00.000Z",
        previous: "2027-03-13T07:30:00.000Z",
      },
      {
        label: "New York previous occurrence never comes from its spring-forward gap",
        timezone: "America/New_York",
        expression: "30 2 * * *",
        now: "2027-03-14T07:10:00.000Z",
        next: "2027-03-15T06:30:00.000Z",
        previous: "2027-03-13T07:30:00.000Z",
      },
      {
        label: "New York preserves the final valid second before a spring-forward gap",
        timezone: "America/New_York",
        expression: "59 59 1,2 * * *",
        now: "2027-03-14T07:05:00.000Z",
        next: "2027-03-15T05:59:59.000Z",
        previous: "2027-03-14T06:59:59.000Z",
      },
      {
        label: "Oslo skips a nonexistent spring-forward reminder",
        timezone: "Europe/Oslo",
        expression: "30 2 * * *",
        now: "2026-03-29T00:45:00.000Z",
        next: "2026-03-30T00:30:00.000Z",
        previous: "2026-03-28T01:30:00.000Z",
      },
      {
        label: "Lord Howe keeps the valid boundary after its half-hour spring gap",
        timezone: "Australia/Lord_Howe",
        expression: "15,30 2 * * *",
        now: "2026-10-03T15:20:00.000Z",
        next: "2026-10-03T15:30:00.000Z",
        previous: "2026-10-02T16:00:00.000Z",
      },
      {
        label: "Lord Howe keeps a valid later occurrence after its half-hour spring gap",
        timezone: "Australia/Lord_Howe",
        expression: "15,35 2 * * *",
        now: "2026-10-03T15:20:00.000Z",
        next: "2026-10-03T15:35:00.000Z",
        previous: "2026-10-02T16:05:00.000Z",
      },
      {
        label: "Lord Howe previous occurrence never comes from its half-hour spring gap",
        timezone: "Australia/Lord_Howe",
        expression: "15 2 * * *",
        now: "2026-10-03T15:32:00.000Z",
        next: "2026-10-04T15:15:00.000Z",
        previous: "2026-10-02T15:45:00.000Z",
      },
      {
        label: "Antarctica schedules the first occurrence of a two-hour fold",
        timezone: "Antarctica/Troll",
        expression: "0 2 * * *",
        now: "2026-10-24T23:30:00.000Z",
        next: "2026-10-25T00:00:00.000Z",
        previous: "2026-10-24T00:00:00.000Z",
      },
      {
        label: "Antarctica skips every repeated occurrence in a two-hour fold",
        timezone: "Antarctica/Troll",
        expression: "0 1,2,4 * * *",
        now: "2026-10-25T01:30:00.000Z",
        next: "2026-10-25T04:00:00.000Z",
        previous: "2026-10-25T00:00:00.000Z",
      },
      {
        label: "Antarctica skips duplicate per-second occurrences in a two-hour fold",
        timezone: "Antarctica/Troll",
        expression: "* * * * * *",
        now: "2026-10-25T01:30:00.250Z",
        next: "2026-10-25T03:00:00.000Z",
        previous: "2026-10-25T00:59:59.000Z",
      },
      {
        label: "Antarctica keeps the valid reminder after its two-hour spring gap",
        timezone: "Antarctica/Troll",
        expression: "30 2,3 * * *",
        now: "2026-03-29T00:30:00.000Z",
        next: "2026-03-29T01:30:00.000Z",
        previous: "2026-03-28T03:30:00.000Z",
      },
      {
        label: "New York skips a nonexistent annual reminder after multiple offset changes",
        timezone: "America/New_York",
        expression: "30 2 14 3 *",
        now: "2026-07-01T00:00:00.000Z",
        next: "2028-03-14T06:30:00.000Z",
        previous: "2026-03-14T06:30:00.000Z",
      },
      {
        label: "New York skips a nonexistent historical annual reminder",
        timezone: "America/New_York",
        expression: "30 2 8 3 *",
        now: "2026-07-01T00:00:00.000Z",
        next: "2027-03-08T07:30:00.000Z",
        previous: "2025-03-08T07:30:00.000Z",
      },
      {
        label: "Moscow keeps valid annual reminders beyond multiple historical rule changes",
        timezone: "Europe/Moscow",
        expression: "30 2 * 3 SUN#L",
        now: "2007-03-01T00:00:00.000Z",
        next: "2012-03-24T22:30:00.000Z",
        previous: "1991-03-30T23:30:00.000Z",
      },
    ])("$label", ({ timezone, expression, now, next, previous }) => {
      const schedule = { kind: "cron" as const, expr: expression, tz: timezone };
      const nowMs = Date.parse(now);

      expect(computeNextRunAtMs(schedule, nowMs)).toBe(Date.parse(next));
      expect(computePreviousRunAtMs(schedule, nowMs)).toBe(Date.parse(previous));
    });

    it.each(["30 2 * 3 SUN#2", "0 30 2 * 3 SUN#2"])(
      "skips nonexistent future occurrences but preserves historical timezone rules for %s",
      (expression) => {
        const schedule = { kind: "cron" as const, expr: expression, tz: "America/New_York" };
        const nowMs = Date.parse("2026-01-01T00:00:00.000Z");

        expect(computeNextRunAtMs(schedule, nowMs)).toBeUndefined();
        expect(computePreviousRunAtMs(schedule, nowMs)).toBe(
          Date.parse("2006-03-12T07:30:00.000Z"),
        );
      },
    );

    it("never spills a nonexistent year-limited reminder into another year", () => {
      const schedule = {
        kind: "cron" as const,
        expr: "0 30 2 14 3 * 2027",
        tz: "America/New_York",
      };
      const nowMs = Date.parse("2026-07-01T00:00:00.000Z");

      expect(computeNextRunAtMs(schedule, nowMs)).toBeUndefined();
      expect(computePreviousRunAtMs(schedule, nowMs)).toBeUndefined();
    });

    it("recovers the first occurrence of a year-limited reminder during its repeated hour", () => {
      const schedule = {
        kind: "cron" as const,
        expr: "0 30 1 1 11 * 2026",
        tz: "America/New_York",
      };
      const nowMs = Date.parse("2026-11-01T06:15:00.000Z");

      expect(computeNextRunAtMs(schedule, nowMs)).toBeUndefined();
      expect(computePreviousRunAtMs(schedule, nowMs)).toBe(Date.parse("2026-11-01T05:30:00.000Z"));
    });

    it.each([
      {
        label: "next-second retry rejects a real spring-forward gap",
        timezone: "America/New_York",
        expression: "30 2 * * *",
        now: "2027-03-14T06:45:00.000Z",
        prior: "2027-03-13T07:30:00.000Z",
        forcedPastCalls: 1,
        expected: "2027-03-15T06:30:00.000Z",
      },
      {
        label: "next-second retry selects the first real half-hour fold",
        timezone: "Australia/Lord_Howe",
        expression: "45 1 * * *",
        now: "2026-04-04T14:40:00.000Z",
        prior: "2026-04-03T14:45:00.000Z",
        forcedPastCalls: 1,
        expected: "2026-04-04T14:45:00.000Z",
      },
      {
        label: "tomorrow retry rejects a real spring-forward gap",
        timezone: "America/New_York",
        expression: "30 2 * * *",
        now: "2027-03-13T23:45:00.000Z",
        prior: "2027-03-13T07:30:00.000Z",
        forcedPastCalls: 2,
        expected: "2027-03-15T06:30:00.000Z",
      },
      {
        label: "tomorrow retry selects the first real half-hour fold",
        timezone: "Australia/Lord_Howe",
        expression: "45 1 * * *",
        now: "2026-04-03T23:45:00.000Z",
        prior: "2026-04-03T14:45:00.000Z",
        forcedPastCalls: 2,
        expected: "2026-04-04T14:45:00.000Z",
      },
    ])("$label", ({ timezone, expression, now, prior, forcedPastCalls, expected }) => {
      const spy = vi.spyOn(Cron.prototype, "nextRun");
      for (let count = 0; count < forcedPastCalls; count += 1) {
        spy.mockImplementationOnce(() => new Date(prior));
      }
      try {
        expect(
          computeNextRunAtMs({ kind: "cron", expr: expression, tz: timezone }, Date.parse(now)),
        ).toBe(Date.parse(expected));
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("throws a clear error when cron expr is missing at runtime", () => {
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
    expect(() =>
      computeNextRunAtMs(
        {
          kind: "cron",
        } as unknown as { kind: "cron"; expr: string; tz?: string },
        nowMs,
      ),
    ).toThrow("invalid cron schedule: expr is required");
  });

  it("computes next run for every schedule", () => {
    const anchor = Date.parse("2025-12-13T00:00:00.000Z");
    const now = anchor + 10_000;
    const next = computeNextRunAtMs({ kind: "every", everyMs: 30_000, anchorMs: anchor }, now);
    expect(next).toBe(anchor + 30_000);
  });

  it("computes next run for every schedule when anchorMs is not provided", () => {
    const now = Date.parse("2025-12-13T00:00:00.000Z");
    const next = computeNextRunAtMs({ kind: "every", everyMs: 30_000 }, now);

    // Should return nowMs + everyMs, not nowMs (which would cause infinite loop)
    expect(next).toBe(now + 30_000);
  });

  it("handles string-typed everyMs and anchorMs", () => {
    const anchor = Date.parse("2025-12-13T00:00:00.000Z");
    const now = anchor + 10_000;
    const next = computeNextRunAtMs(
      {
        kind: "every",
        everyMs: "30000" as unknown as number,
        anchorMs: `${anchor}` as unknown as number,
      },
      now,
    );
    expect(next).toBe(anchor + 30_000);
  });

  it("returns undefined for non-numeric string everyMs", () => {
    const now = Date.now();
    const next = computeNextRunAtMs({ kind: "every", everyMs: "abc" as unknown as number }, now);
    expect(next).toBeUndefined();
  });

  it("advances when now matches anchor for every schedule", () => {
    const anchor = Date.parse("2025-12-13T00:00:00.000Z");
    const next = computeNextRunAtMs({ kind: "every", everyMs: 30_000, anchorMs: anchor }, anchor);
    expect(next).toBe(anchor + 30_000);
  });

  it("advances when now matches a later every interval boundary", () => {
    const anchor = Date.parse("2025-12-13T00:00:00.000Z");
    const now = anchor + 30_000;
    const next = computeNextRunAtMs({ kind: "every", everyMs: 30_000, anchorMs: anchor }, now);
    expect(next).toBe(anchor + 60_000);
  });

  it("rejects every schedule numbers outside the ECMAScript Date range", () => {
    expect(
      computeNextRunAtMs({ kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS + 1 }, 0),
    ).toBeUndefined();
    expect(
      computeNextRunAtMs({ kind: "every", everyMs: 1, anchorMs: MAX_DATE_TIMESTAMP_MS + 1 }, 0),
    ).toBeUndefined();
    expect(computeNextRunAtMs({ kind: "every", everyMs: 0.5, anchorMs: 0 }, 0)).toBeUndefined();
    expect(computeNextRunAtMs({ kind: "every", everyMs: 1, anchorMs: -1 }, 0)).toBeUndefined();
  });

  it("does not return an every occurrence outside the ECMAScript Date range", () => {
    const anchorMs = MAX_DATE_TIMESTAMP_MS - 1;
    expect(computeNextRunAtMs({ kind: "every", everyMs: 2, anchorMs }, anchorMs)).toBeUndefined();
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["above Date range", MAX_DATE_TIMESTAMP_MS + 1],
    ["below Date range", -MAX_DATE_TIMESTAMP_MS - 1],
  ])("returns undefined instead of throwing for an invalid %s cursor", (_label, nowMs) => {
    expect(computeNextRunAtMs({ kind: "every", everyMs: 60_000 }, nowMs)).toBeUndefined();
    expect(
      computeNextRunAtMs({ kind: "cron", expr: "0 * * * *", tz: "UTC" }, nowMs),
    ).toBeUndefined();
    expect(
      computePreviousRunAtMs({ kind: "cron", expr: "0 * * * *", tz: "UTC" }, nowMs),
    ).toBeUndefined();
  });

  it("never returns a past timestamp for Asia/Shanghai daily schedule (#30351)", () => {
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
      nowMs,
    );
    expect(requireTimestamp(next, "next run")).toBeGreaterThan(nowMs);
  });

  it("never returns a previous run that is at-or-after now", () => {
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    const previous = computePreviousRunAtMs(
      { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
      nowMs,
    );
    if (previous !== undefined) {
      expect(previous).toBeLessThan(nowMs);
    }
  });

  it("reuses compiled cron evaluators for the same expression/timezone", () => {
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    expect(getCronScheduleCacheSizeForTest()).toBe(0);

    requireTimestamp(
      computeNextRunAtMs({ kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" }, nowMs),
      "first next run",
    );
    requireTimestamp(
      computeNextRunAtMs({ kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" }, nowMs + 1_000),
      "second next run",
    );
    requireTimestamp(
      computeNextRunAtMs({ kind: "cron", expr: "0 8 * * *", tz: "UTC" }, nowMs),
      "third next run",
    );
    expect(getCronScheduleCacheSizeForTest()).toBe(2);
  });

  it("promotes accessed entries to avoid premature LRU eviction", () => {
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    const cacheMax = getCronScheduleCacheMaxForTest();

    // Fill cache to capacity with unique expressions.
    // i=0 → "0 0 * * *", i=1 → "1 0 * * *", ..., i=511 → "31 8 * * *"
    for (let i = 0; i < cacheMax; i++) {
      computeNextRunAtMs(
        { kind: "cron", expr: `${i % 60} ${Math.floor(i / 60)} * * *`, tz: "UTC" },
        nowMs,
      );
    }
    expect(getCronScheduleCacheSizeForTest()).toBe(cacheMax);

    // Entry #0 ("0 0 * * *") is the oldest by insertion order.
    // Access it so LRU promotes it (delete + re-insert at end of Map).
    computeNextRunAtMs({ kind: "cron", expr: "0 0 * * *", tz: "UTC" }, nowMs);

    // Entry #1 ("1 0 * * *") is now the least-recently-used.
    // Insert a new entry to trigger one eviction.
    computeNextRunAtMs({ kind: "cron", expr: "0 0 1 1 *", tz: "UTC" }, nowMs);
    expect(getCronScheduleCacheSizeForTest()).toBe(cacheMax);

    // Under LRU: entry #0 survived (was promoted), entry #1 was evicted.
    // Under FIFO: entry #0 would be evicted instead — this assertion would fail.
    expect(hasCronInCacheForTest("0 0 * * *", "UTC")).toBe(true);
    expect(hasCronInCacheForTest("1 0 * * *", "UTC")).toBe(false);

    // The new entry and a non-evicted middle entry should both be present.
    expect(hasCronInCacheForTest("0 0 1 1 *", "UTC")).toBe(true);
    expect(hasCronInCacheForTest("2 0 * * *", "UTC")).toBe(true);
  });

  describe("cron with specific seconds (6-field pattern)", () => {
    // Pattern: fire at exactly second 0 of minute 0 of hour 12 every day
    const dailyNoon = { kind: "cron" as const, expr: "0 0 12 * * *", tz: "UTC" };
    const noonMs = Date.parse("2026-02-08T12:00:00.000Z");

    it("advances past current second when nowMs is exactly at the match", () => {
      // Fix #14164: must NOT return the current second — that caused infinite
      // re-fires when multiple jobs triggered simultaneously.
      const next = computeNextRunAtMs(dailyNoon, noonMs);
      expect(next).toBe(noonMs + 86_400_000); // next day
    });

    it("advances past current second when nowMs is mid-second (.500) within the match", () => {
      // Fix #14164: returning the current second caused rapid duplicate fires.
      const next = computeNextRunAtMs(dailyNoon, noonMs + 500);
      expect(next).toBe(noonMs + 86_400_000); // next day
    });

    it("advances past current second when nowMs is late in the matching second (.999)", () => {
      const next = computeNextRunAtMs(dailyNoon, noonMs + 999);
      expect(next).toBe(noonMs + 86_400_000); // next day
    });

    it("advances to next day once the matching second is fully past", () => {
      const next = computeNextRunAtMs(dailyNoon, noonMs + 1000);
      expect(next).toBe(noonMs + 86_400_000); // next day
    });

    it("returns today when nowMs is before the match", () => {
      const next = computeNextRunAtMs(dailyNoon, noonMs - 500);
      expect(next).toBe(noonMs);
    });

    it("advances to next day when job completes within same second it fired (#17821)", () => {
      // Regression test for #17821: cron jobs that fire and complete within
      // the same second (e.g., fire at 12:00:00.014, complete at 12:00:00.021)
      // were getting nextRunAtMs set to the same second, causing a spin loop.
      //
      // Simulating: job scheduled for 12:00:00, fires at .014, completes at .021
      const completedAtMs = noonMs + 21; // 12:00:00.021
      const next = computeNextRunAtMs(dailyNoon, completedAtMs);
      expect(next).toBe(noonMs + 86_400_000); // must be next day, NOT noonMs
    });

    it("advances to next day when job completes just before second boundary (#17821)", () => {
      // Edge case: job completes at .999, still within the firing second
      const completedAtMs = noonMs + 999; // 12:00:00.999
      const next = computeNextRunAtMs(dailyNoon, completedAtMs);
      expect(next).toBe(noonMs + 86_400_000); // next day
    });
  });
});

describe("coerceFiniteScheduleNumber", () => {
  it("returns finite numbers directly", () => {
    expect(coerceFiniteScheduleNumber(60_000)).toBe(60_000);
  });

  it("parses numeric strings", () => {
    expect(coerceFiniteScheduleNumber("60000")).toBe(60_000);
    expect(coerceFiniteScheduleNumber(" 60000 ")).toBe(60_000);
  });

  it("returns undefined for invalid inputs", () => {
    expect(coerceFiniteScheduleNumber("")).toBeUndefined();
    expect(coerceFiniteScheduleNumber("abc")).toBeUndefined();
    expect(coerceFiniteScheduleNumber("60000ms")).toBeUndefined();
    expect(coerceFiniteScheduleNumber("0x10")).toBeUndefined();
    expect(coerceFiniteScheduleNumber(Number.NaN)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(Infinity)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(MAX_DATE_TIMESTAMP_MS + 1)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(String(Number.MAX_SAFE_INTEGER + 1))).toBeUndefined();
    expect(coerceFiniteScheduleNumber(null)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(undefined)).toBeUndefined();
  });
});

describe("computeNextRunAtMs on-exit", () => {
  it("never reports a time-due run for on-exit schedules (event-driven)", () => {
    expect(computeNextRunAtMs({ kind: "on-exit", command: "sleep 1" }, Date.now())).toBeUndefined();
    expect(
      computeNextRunAtMs({ kind: "on-exit", command: "make build", cwd: "/repo" }, 0),
    ).toBeUndefined();
  });
});

describe("computeNextRunAtMs stream", () => {
  it("never reports a time-due run for event stream schedules", () => {
    expect(computeNextRunAtMs({ kind: "stream", command: ["node", "events.mjs"] }, 0)).toBe(
      undefined,
    );
  });
});
