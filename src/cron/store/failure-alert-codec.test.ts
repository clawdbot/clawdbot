// Unit tests for failure-alert SQLite column codec roundtrip.
import { describe, expect, it } from "vitest";
import { bindFailureAlertColumns, failureAlertFromRow } from "./failure-alert-codec.js";
import type { CronJobRow } from "./schema.js";

function roundtrip(
  input: Parameters<typeof bindFailureAlertColumns>[0],
): ReturnType<typeof failureAlertFromRow> {
  const columns = bindFailureAlertColumns(input);
  return failureAlertFromRow(columns as CronJobRow);
}

describe("failureAlertFromRow", () => {
  it("round-trips disabled config (false)", () => {
    expect(roundtrip(false)).toBe(false);
  });

  it("round-trips undefined (no alert config) as undefined", () => {
    expect(roundtrip(undefined)).toBeUndefined();
  });

  it("round-trips enabled-with-defaults ({}) as {}", () => {
    const result = roundtrip({});
    expect(result).toEqual({});
  });

  it("round-trips populated config with all fields", () => {
    const config = {
      after: 3,
      cooldownMs: 120_000,
      channel: "telegram" as const,
      to: "@user",
      mode: "announce" as const,
      accountId: "acc-1",
      includeSkipped: true,
    };
    expect(roundtrip(config)).toEqual(config);
  });

  it("round-trips partial config (only after)", () => {
    expect(roundtrip({ after: 5 })).toEqual({ after: 5 });
  });

  it("enabled-with-defaults does not collapse to undefined on read", () => {
    const columns = bindFailureAlertColumns({});
    const row = columns as CronJobRow;
    expect(row.failure_alert_disabled).toBe(0);
    expect(row.failure_alert_after).toBeNull();
    const decoded = failureAlertFromRow(row);
    expect(decoded).toEqual({});
    expect(decoded).not.toBeUndefined();
    expect(decoded).toBeTruthy();
  });
});
