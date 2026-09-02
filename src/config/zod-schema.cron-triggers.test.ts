import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema cron gates", () => {
  it.each([undefined, false, true])(
    "accepts skipMissedJobs=%s without changing its default",
    (skipMissedJobs) => {
      expect(OpenClawSchema.parse({ cron: { skipMissedJobs } }).cron?.skipMissedJobs).toBe(
        skipMissedJobs,
      );
    },
  );

  it("rejects a non-boolean skipMissedJobs", () => {
    expect(OpenClawSchema.safeParse({ cron: { skipMissedJobs: "true" } }).success).toBe(false);
  });

  it("accepts the strict trigger gate", () => {
    expect(OpenClawSchema.parse({ cron: { triggers: { enabled: true } } }).cron?.triggers).toEqual({
      enabled: true,
    });
  });

  it("rejects invalid and unknown trigger settings", () => {
    expect(
      OpenClawSchema.safeParse({ cron: { triggers: { enabled: true, extra: true } } }).success,
    ).toBe(false);
  });
});
