import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveDiagnosticMemoryThresholds } from "../logging/diagnostic-memory.js";

// Replicate the production zod schema from zod-schema.root-shape.ts for fast path tests
const DiagnosticsMemoryZod = z
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

const MB = 1024 * 1024;

describe("diagnostics.memory zod pre-resolve validation", () => {
  it("accepts empty config", () => {
    expect(DiagnosticsMemoryZod.safeParse({}).success).toBe(true);
  });

  it("accepts warning < critical for RSS", () => {
    expect(
      DiagnosticsMemoryZod.safeParse({
        rssWarningBytes: 1000,
        rssCriticalBytes: 2000,
      }).success,
    ).toBe(true);
  });

  it("rejects overtly inverted pairs at config time", () => {
    expect(
      DiagnosticsMemoryZod.safeParse({
        rssWarningBytes: 2000,
        rssCriticalBytes: 1000,
      }).success,
    ).toBe(false);
  });

  it("allows partial overrides through to resolve (skip null)", () => {
    expect(DiagnosticsMemoryZod.safeParse({ rssWarningBytes: 3 * MB * 1024 }).success).toBe(true);
  });

  it("rejects negative and zero values", () => {
    expect(DiagnosticsMemoryZod.safeParse({ rssWarningBytes: -1 }).success).toBe(false);
    expect(DiagnosticsMemoryZod.safeParse({ rssWarningBytes: 0 }).success).toBe(false);
  });
});

describe("resolveDiagnosticMemoryThresholds post-resolve clamp", () => {
  it("passes through valid pairs unchanged", () => {
    const result = resolveDiagnosticMemoryThresholds({
      rssWarningBytes: 1000,
      rssCriticalBytes: 2000,
      heapUsedWarningBytes: 500 * MB,
      heapUsedCriticalBytes: 1000 * MB,
      rssGrowthWarningBytes: 50 * MB,
      rssGrowthCriticalBytes: 100 * MB,
    });
    expect(result.rssWarningBytes).toBe(1000);
    expect(result.rssCriticalBytes).toBe(2000);
    expect(result.heapUsedWarningBytes).toBe(500 * MB);
    expect(result.heapUsedCriticalBytes).toBe(1000 * MB);
    expect(result.rssGrowthWarningBytes).toBe(50 * MB);
    expect(result.rssGrowthCriticalBytes).toBe(100 * MB);
  });

  it("clamps partial RSS override when warning meets resolved critical", () => {
    const result = resolveDiagnosticMemoryThresholds({ rssWarningBytes: 3 * MB * 1024 });
    expect(result.rssCriticalBytes).toBe(3072 * MB);
    expect(result.rssWarningBytes).toBeLessThan(result.rssCriticalBytes);
  });

  it("clamps inverted RSS pair (warning > critical)", () => {
    const result = resolveDiagnosticMemoryThresholds({
      rssWarningBytes: 4000 * MB,
      rssCriticalBytes: 2000 * MB,
    });
    expect(result.rssWarningBytes).toBeLessThan(result.rssCriticalBytes);
  });

  it("clamps inverted heap pair (warning > critical)", () => {
    const result = resolveDiagnosticMemoryThresholds({
      heapUsedWarningBytes: 3 * 1024 * MB,
      heapUsedCriticalBytes: 1024 * MB,
    });
    expect(result.heapUsedWarningBytes).toBeLessThan(result.heapUsedCriticalBytes);
  });

  it("clamps inverted RSS growth pair (warning > critical)", () => {
    const result = resolveDiagnosticMemoryThresholds({
      rssGrowthWarningBytes: 2 * 1024 * MB,
      rssGrowthCriticalBytes: 500 * MB,
    });
    expect(result.rssGrowthWarningBytes).toBeLessThan(result.rssGrowthCriticalBytes);
  });

  it("preserves defaults when nothing is configured", () => {
    const result = resolveDiagnosticMemoryThresholds({});
    expect(result.rssWarningBytes).toBe(1536 * MB);
    expect(result.rssCriticalBytes).toBe(3072 * MB);
    expect(result.heapUsedWarningBytes).toBe(1024 * MB);
    expect(result.heapUsedCriticalBytes).toBe(2048 * MB);
    expect(result.rssGrowthWarningBytes).toBe(512 * MB);
    expect(result.rssGrowthCriticalBytes).toBe(1024 * MB);
  });

  it("leaves valid partial overrides intact when the other side is default", () => {
    const result = resolveDiagnosticMemoryThresholds({ rssWarningBytes: 500 * MB });
    expect(result.rssWarningBytes).toBe(500 * MB);
    expect(result.rssCriticalBytes).toBe(3072 * MB);
  });
});
