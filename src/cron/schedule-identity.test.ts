// Schedule identity tests cover stable identity derivation for cron schedules.
import { describe, expect, it } from "vitest";
import { cronSchedulingInputsEqual, tryCronScheduleIdentity } from "./schedule-identity.js";

describe("tryCronScheduleIdentity", () => {
  it("normalizes numeric schedule strings like execution does", () => {
    const numeric = tryCronScheduleIdentity({
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 123 },
    });
    const stringNumeric = tryCronScheduleIdentity({
      enabled: true,
      schedule: { kind: "every", everyMs: "60000", anchorMs: "123" },
    });

    expect(stringNumeric).toBe(numeric);
    const stringNumericInput = {
      schedule: { kind: "every", everyMs: "60000", anchorMs: "123" },
    } as unknown as Parameters<typeof cronSchedulingInputsEqual>[1];

    expect(
      cronSchedulingInputsEqual(
        { schedule: { kind: "every", everyMs: 60_000, anchorMs: 123 } },
        stringNumericInput,
      ),
    ).toBe(true);
  });

  it("normalizes cron stagger identity like execution does", () => {
    expect(
      cronSchedulingInputsEqual(
        { schedule: { kind: "cron", expr: "*/5 * * * *", staggerMs: 42 } },
        { schedule: { kind: "cron", expr: "*/5 * * * *", staggerMs: 42.8 } },
      ),
    ).toBe(true);

    expect(
      cronSchedulingInputsEqual(
        { schedule: { kind: "cron", expr: "*/5 * * * *", staggerMs: 0 } },
        { schedule: { kind: "cron", expr: "*/5 * * * *", staggerMs: -10 } },
      ),
    ).toBe(true);

    expect(
      cronSchedulingInputsEqual(
        { schedule: { kind: "cron", expr: "*/5 * * * *" } },
        {
          schedule: {
            kind: "cron",
            expr: "*/5 * * * *",
            staggerMs: "1e3" as unknown as number,
          },
        },
      ),
    ).toBe(true);
  });
});
