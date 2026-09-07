import { describe, expect, it } from "vitest";
import { describePeriod, periodDayKeys } from "./periods.js";

describe("UTC report periods", () => {
  it("keeps ISO weeks in their ISO year across the calendar boundary", () => {
    const week = describePeriod("week", new Date("2021-01-01T23:59:59Z"));
    expect(week.key).toBe("2020-W53");
    expect(new Date(week.sinceMs).toISOString()).toBe("2020-12-28T00:00:00.000Z");
    expect(new Date(week.untilMs).toISOString()).toBe("2021-01-04T00:00:00.000Z");
    expect(describePeriod("week", "2020-W53")).toEqual(week);
  });

  it("uses UTC boundaries and calendar month lengths, including leap days", () => {
    const day = describePeriod("day", new Date("2024-03-01T00:30:00+02:00"));
    expect(day.key).toBe("2024-02-29");
    expect(day.untilMs - day.sinceMs).toBe(86_400_000);
    const month = describePeriod("month", "2024-02");
    expect(periodDayKeys(month)).toHaveLength(29);
    expect(new Date(month.untilMs).toISOString()).toBe("2024-03-01T00:00:00.000Z");
  });

  it("only expects elapsed days of an open week", () => {
    const week = describePeriod("week", "2026-W34");
    expect(periodDayKeys(week, Date.parse("2026-08-19T12:00:00Z"))).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
    ]);
  });

  it.each([
    ["day", "2025-02-29"],
    ["day", "2026-13-01"],
    ["day", "2026-1-01"],
    ["week", "2021-W53"],
    ["week", "2026-W00"],
    ["month", "2026-00"],
  ] as const)("rejects invalid %s key %s instead of normalizing it", (period, key) => {
    expect(() => describePeriod(period, key)).toThrow();
  });
});
