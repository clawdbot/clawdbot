import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema cron triggers", () => {
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
