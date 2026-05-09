import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOP_OF_HOUR_STAGGER_MS,
  isRecurringTopOfHourCronExpr,
  normalizeCronStaggerMs,
  resolveCronStaggerMs,
} from "./stagger.js";

describe("cron stagger helpers", () => {
  it("detects recurring top-of-hour cron expressions for 5-field and 6-field cron", () => {
    expect(isRecurringTopOfHourCronExpr("0 * * * *")).toBe(true);
    expect(isRecurringTopOfHourCronExpr("0 */2 * * *")).toBe(true);
    expect(isRecurringTopOfHourCronExpr("0 0 */3 * * *")).toBe(true);
    expect(isRecurringTopOfHourCronExpr("0 7 * * *")).toBe(false);
    expect(isRecurringTopOfHourCronExpr("15 * * * *")).toBe(false);
  });

  it("normalizes explicit stagger values", () => {
    expect(normalizeCronStaggerMs("30000")).toBe(30_000);
    expect(normalizeCronStaggerMs(42.8)).toBe(42);
    expect(normalizeCronStaggerMs(-10)).toBe(0);
    expect(normalizeCronStaggerMs("")).toBeUndefined();
    expect(normalizeCronStaggerMs("abc")).toBeUndefined();
  });

  it("resolves effective stagger for cron schedules", () => {
    expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * *" })).toBe(
      DEFAULT_TOP_OF_HOUR_STAGGER_MS,
    );
    expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * *", staggerMs: 30_000 })).toBe(
      30_000,
    );
    expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * *", staggerMs: 0 })).toBe(0);
    expect(resolveCronStaggerMs({ kind: "cron", expr: "15 * * * *" })).toBe(0);
  });

  it("handles missing runtime expr values without throwing", () => {
    expect(
      resolveCronStaggerMs({ kind: "cron" } as unknown as { kind: "cron"; expr: string }),
    ).toBe(0);
  });
});
