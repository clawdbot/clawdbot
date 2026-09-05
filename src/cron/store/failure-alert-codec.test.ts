// Failure-alert settings retain their public shape through canonical cron job JSON.
import { describe, expect, it } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronFailureAlert } from "../types.js";
import { projectCronJobThroughStorageCodec } from "./row-codec.js";

function roundtrip(input: CronFailureAlert | false | undefined) {
  return projectCronJobThroughStorageCodec(makeCronJob({ failureAlert: input })).failureAlert;
}

describe("failure-alert cron JSON round-trip", () => {
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
});
