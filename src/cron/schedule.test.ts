import { beforeEach, describe, expect, it } from "vitest";
import {
  coerceFiniteScheduleNumber,
  clearCronScheduleCacheForTest,
  computeNextRunAtMs,
  computePreviousRunAtMs,
  getCronScheduleCacheMaxForTest,
  getCronScheduleCacheSizeForTest,
  hasCronInCacheForTest,
} from "./schedule.js";

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

  it("supports legacy cron field when expr is missing", () => {
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
    const next = computeNextRunAtMs(
      {
        kind: "cron",
        cron: "0 9 * * 3",
        tz: "America/Los_Angeles",
      } as unknown as { kind: "cron"; expr: string; tz?: string },
      nowMs,
    );
    expect(next).toBe(Date.parse("2025-12-17T17:00:00.000Z"));
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

  it("handles string-typed everyMs and anchorMs from legacy persisted data", () => {
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

  it("never returns a past timestamp for Asia/Shanghai daily schedule (#30351)", () => {
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
      nowMs,
    );
    expect(next).toBeDefined();
    expect(next!).toBeGreaterThan(nowMs);
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

    const first = computeNextRunAtMs(
      { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
      nowMs,
    );
    const second = computeNextRunAtMs(
      { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
      nowMs + 1_000,
    );
    const third = computeNextRunAtMs({ kind: "cron", expr: "0 8 * * *", tz: "UTC" }, nowMs);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
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
    expect(coerceFiniteScheduleNumber(Number.NaN)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(Infinity)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(null)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(undefined)).toBeUndefined();
  });
});
