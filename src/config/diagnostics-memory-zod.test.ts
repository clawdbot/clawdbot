import { describe, expect, it } from "vitest";
import { z } from "zod";

const DiagnosticsMemorySchema = z
  .strictObject({
    rssWarningBytes: z.number().int().positive().optional(),
    rssCriticalBytes: z.number().int().positive().optional(),
    heapUsedWarningBytes: z.number().int().positive().optional(),
    heapUsedCriticalBytes: z.number().int().positive().optional(),
    rssGrowthWarningBytes: z.number().int().positive().optional(),
    rssGrowthCriticalBytes: z.number().int().positive().optional(),
  })
  .refine(
    (v) =>
      v.rssWarningBytes == null ||
      v.rssCriticalBytes == null ||
      v.rssWarningBytes < v.rssCriticalBytes,
    {
      message: "rssWarningBytes must be less than rssCriticalBytes (critical is checked first)",
    },
  )
  .refine(
    (v) =>
      v.heapUsedWarningBytes == null ||
      v.heapUsedCriticalBytes == null ||
      v.heapUsedWarningBytes < v.heapUsedCriticalBytes,
    {
      message:
        "heapUsedWarningBytes must be less than heapUsedCriticalBytes (critical is checked first)",
    },
  )
  .refine(
    (v) =>
      v.rssGrowthWarningBytes == null ||
      v.rssGrowthCriticalBytes == null ||
      v.rssGrowthWarningBytes < v.rssGrowthCriticalBytes,
    {
      message:
        "rssGrowthWarningBytes must be less than rssGrowthCriticalBytes (critical is checked first)",
    },
  )
  .optional()
  .unwrap();

describe("diagnostics.memory ordered-pair validation", () => {
  it("accepts empty config (all defaults)", () => {
    expect(DiagnosticsMemorySchema.safeParse({}).success).toBe(true);
  });

  it("accepts warning < critical for RSS", () => {
    expect(
      DiagnosticsMemorySchema.safeParse({
        rssWarningBytes: 1000,
        rssCriticalBytes: 2000,
      }).success,
    ).toBe(true);
  });

  it("rejects warning >= critical for RSS", () => {
    const r = DiagnosticsMemorySchema.safeParse({
      rssWarningBytes: 2000,
      rssCriticalBytes: 2000,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toContain("rssWarningBytes");
    }
  });

  it("rejects inverted RSS pair (warning > critical)", () => {
    const r = DiagnosticsMemorySchema.safeParse({
      rssWarningBytes: 3221225472,
      rssCriticalBytes: 1610612736,
    });
    expect(r.success).toBe(false);
  });

  it("accepts warning < critical for heap", () => {
    expect(
      DiagnosticsMemorySchema.safeParse({
        heapUsedWarningBytes: 500_000_000,
        heapUsedCriticalBytes: 2_000_000_000,
      }).success,
    ).toBe(true);
  });

  it("rejects inverted heap pair (warning > critical)", () => {
    const r = DiagnosticsMemorySchema.safeParse({
      heapUsedWarningBytes: 3_000_000_000,
      heapUsedCriticalBytes: 1_000_000_000,
    });
    expect(r.success).toBe(false);
  });

  it("accepts warning < critical for RSS growth", () => {
    expect(
      DiagnosticsMemorySchema.safeParse({
        rssGrowthWarningBytes: 100_000_000,
        rssGrowthCriticalBytes: 500_000_000,
      }).success,
    ).toBe(true);
  });

  it("rejects inverted RSS growth pair (warning > critical)", () => {
    const r = DiagnosticsMemorySchema.safeParse({
      rssGrowthWarningBytes: 2_000_000_000,
      rssGrowthCriticalBytes: 500_000_000,
    });
    expect(r.success).toBe(false);
  });

  it("skips validation when only one side of a pair is set", () => {
    // Only critical set, no warning — valid because refine skips null checks
    expect(
      DiagnosticsMemorySchema.safeParse({
        rssCriticalBytes: 2000,
        heapUsedCriticalBytes: 4000,
      }).success,
    ).toBe(true);

    // Only warning set, no critical — valid
    expect(
      DiagnosticsMemorySchema.safeParse({
        rssWarningBytes: 1000,
      }).success,
    ).toBe(true);
  });

  it("rejects negative and zero values", () => {
    expect(DiagnosticsMemorySchema.safeParse({ rssWarningBytes: -1 }).success).toBe(false);
    expect(DiagnosticsMemorySchema.safeParse({ rssWarningBytes: 0 }).success).toBe(false);
  });
});
