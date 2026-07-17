import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

/**
 * Continuation config Zod schema boundary tests.
 *
 * Validates that invalid config values are rejected at parse time,
 * not silently swallowed or reset to defaults. Convention: fail loudly.
 */

function parseContinuation(continuation: unknown) {
  return AgentDefaultsSchema.safeParse({ continuation });
}

describe("continuation config schema validation", () => {
  /* ---------------------------------------------------------------- */
  /*  contextPressureThreshold: z.number().gt(0).max(1).optional()    */
  /* ---------------------------------------------------------------- */

  it("accepts contextPressureThreshold = 0.8", () => {
    const result = parseContinuation({ contextPressureThreshold: 0.8 });
    expect(result.success).toBe(true);
  });

  it("rejects contextPressureThreshold = 0", () => {
    const result = parseContinuation({ contextPressureThreshold: 0 });
    expect(result.success).toBe(false);
  });

  it("accepts contextPressureThreshold = 1.0 (upper bound)", () => {
    const result = parseContinuation({ contextPressureThreshold: 1 });
    expect(result.success).toBe(true);
  });

  it("rejects contextPressureThreshold = -1 (below min)", () => {
    const result = parseContinuation({ contextPressureThreshold: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects contextPressureThreshold = 2.0 (above max)", () => {
    const result = parseContinuation({ contextPressureThreshold: 2 });
    expect(result.success).toBe(false);
  });

  it("rejects contextPressureThreshold = 'bc annoying' (string)", () => {
    const result = parseContinuation({ contextPressureThreshold: "bc annoying" });
    expect(result.success).toBe(false);
  });

  it("accepts contextPressureThreshold = undefined (optional)", () => {
    const result = parseContinuation({});
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data?.continuation?.earlyWarningBand).toBe(0.3125);
    expect(result.data?.continuation?.crossSessionTargeting).toBe("disabled");
  });

  it("accepts earlyWarningBand = 0 as opt-out", () => {
    const result = parseContinuation({ earlyWarningBand: 0 });
    expect(result.success).toBe(true);
  });

  it("rejects earlyWarningBand outside the unit interval", () => {
    expect(parseContinuation({ earlyWarningBand: -0.1 }).success).toBe(false);
    expect(parseContinuation({ earlyWarningBand: 1.1 }).success).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /*  maxDelegatesPerTurn: z.number().int().positive().optional()      */
  /* ---------------------------------------------------------------- */

  it("accepts maxDelegatesPerTurn = 5", () => {
    const result = parseContinuation({ maxDelegatesPerTurn: 5 });
    expect(result.success).toBe(true);
  });

  it("rejects maxDelegatesPerTurn = 0 (not positive)", () => {
    const result = parseContinuation({ maxDelegatesPerTurn: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects maxDelegatesPerTurn = -1 (negative)", () => {
    const result = parseContinuation({ maxDelegatesPerTurn: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects maxDelegatesPerTurn = 3.5 (not integer)", () => {
    const result = parseContinuation({ maxDelegatesPerTurn: 3.5 });
    expect(result.success).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /*  costCapTokens: z.number().int().nonnegative().optional()         */
  /* ---------------------------------------------------------------- */

  it("accepts costCapTokens = 0 (nonnegative includes zero)", () => {
    const result = parseContinuation({ costCapTokens: 0 });
    expect(result.success).toBe(true);
  });

  it("accepts costCapTokens = 500000", () => {
    const result = parseContinuation({ costCapTokens: 500000 });
    expect(result.success).toBe(true);
  });

  it("rejects costCapTokens = -1 (negative)", () => {
    const result = parseContinuation({ costCapTokens: -1 });
    expect(result.success).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /*  defaultDelayMs / minDelayMs / maxDelayMs / maxChainLength       */
  /* ---------------------------------------------------------------- */

  it("accepts defaultDelayMs = 0 (nonnegative)", () => {
    const result = parseContinuation({ defaultDelayMs: 0 });
    expect(result.success).toBe(true);
  });

  it("rejects minDelayMs = -100 (negative)", () => {
    const result = parseContinuation({ minDelayMs: -100 });
    expect(result.success).toBe(false);
  });

  it("rejects maxChainLength = 0 (not positive)", () => {
    const result = parseContinuation({ maxChainLength: 0 });
    expect(result.success).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /*  enabled: z.boolean().optional()                                  */
  /* ---------------------------------------------------------------- */

  it("accepts enabled = true", () => {
    const result = parseContinuation({ enabled: true });
    expect(result.success).toBe(true);
  });

  it("rejects enabled = 'yes' (string, not boolean)", () => {
    const result = parseContinuation({ enabled: "yes" });
    expect(result.success).toBe(false);
  });

  it("accepts crossSessionTargeting = enabled", () => {
    const result = parseContinuation({ crossSessionTargeting: "enabled" });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data?.continuation?.crossSessionTargeting).toBe("enabled");
  });

  it("rejects unknown crossSessionTargeting values", () => {
    const result = parseContinuation({ crossSessionTargeting: "fleet" });
    expect(result.success).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /*  delay bounds cross-field guard:                                 */
  /*    refine: minDelayMs ≤ defaultDelayMs ≤ maxDelayMs              */
  /*  Pinned by tests so refactors that drop/break the guard are      */
  /*  caught at parse-time, not silently at runtime via clampDelayMs  */
  /*  returning a value outside the configured contract.              */
  /* ---------------------------------------------------------------- */

  it("accepts well-ordered delay bounds (min < default < max)", () => {
    const result = parseContinuation({
      minDelayMs: 100,
      defaultDelayMs: 1000,
      maxDelayMs: 60000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts equal delay bounds (min = default = max)", () => {
    const result = parseContinuation({
      minDelayMs: 5000,
      defaultDelayMs: 5000,
      maxDelayMs: 5000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects inverted minDelayMs > maxDelayMs", () => {
    const result = parseContinuation({
      minDelayMs: 60000,
      maxDelayMs: 1000,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes("continuation delay bounds violate")),
      ).toBe(true);
    }
  });

  it("rejects minDelayMs > defaultDelayMs (default below floor)", () => {
    const result = parseContinuation({
      minDelayMs: 5000,
      defaultDelayMs: 1000,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes("continuation delay bounds violate")),
      ).toBe(true);
    }
  });

  it("rejects defaultDelayMs > maxDelayMs (default above ceiling)", () => {
    const result = parseContinuation({
      defaultDelayMs: 60000,
      maxDelayMs: 5000,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes("continuation delay bounds violate")),
      ).toBe(true);
    }
  });

  it("rejects all three inverted (min > default > max)", () => {
    const result = parseContinuation({
      minDelayMs: 60000,
      defaultDelayMs: 30000,
      maxDelayMs: 1000,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes("continuation delay bounds violate")),
      ).toBe(true);
    }
  });

  it("accepts only minDelayMs set (no cross-field constraint to violate)", () => {
    const result = parseContinuation({ minDelayMs: 60000 });
    expect(result.success).toBe(true);
  });

  it("accepts only maxDelayMs set (no cross-field constraint to violate)", () => {
    const result = parseContinuation({ maxDelayMs: 1000 });
    expect(result.success).toBe(true);
  });

  it("accepts only defaultDelayMs set (no cross-field constraint to violate)", () => {
    const result = parseContinuation({ defaultDelayMs: 5000 });
    expect(result.success).toBe(true);
  });

  /* ---------------------------------------------------------------- */
  /*  strict mode: unknown keys rejected                               */
  /* ---------------------------------------------------------------- */

  it("rejects unknown continuation keys (strict)", () => {
    const result = parseContinuation({ unknownKey: 42 });
    expect(result.success).toBe(false);
  });

  it("rejects the retired delegate-store switch", () => {
    const retiredKey = ["task", "Flow", "Delegates"].join("");
    const result = parseContinuation({ [retiredKey]: true });
    expect(result.success).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /* busySkipBackoff + orphanReapStaleCutoffMs */
  /* ---------------------------------------------------------------- */

  it("accepts a fully-specified busySkipBackoff", () => {
    const result = parseContinuation({
      busySkipBackoff: { baseMs: 1000, ceilingMs: 60_000, factor: 2 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a partial busySkipBackoff (all fields optional)", () => {
    expect(parseContinuation({ busySkipBackoff: { factor: 3 } }).success).toBe(true);
    expect(parseContinuation({ busySkipBackoff: {} }).success).toBe(true);
  });

  it("rejects a busySkipBackoff factor <= 1", () => {
    expect(parseContinuation({ busySkipBackoff: { factor: 1 } }).success).toBe(false);
    expect(parseContinuation({ busySkipBackoff: { factor: 0.5 } }).success).toBe(false);
  });

  it("rejects non-positive / non-integer busySkipBackoff bounds", () => {
    expect(parseContinuation({ busySkipBackoff: { baseMs: 0 } }).success).toBe(false);
    expect(parseContinuation({ busySkipBackoff: { ceilingMs: -1 } }).success).toBe(false);
    expect(parseContinuation({ busySkipBackoff: { baseMs: 1.5 } }).success).toBe(false);
  });

  it("rejects unknown busySkipBackoff keys (strict)", () => {
    expect(parseContinuation({ busySkipBackoff: { nope: 1 } }).success).toBe(false);
  });

  it("accepts a positive integer orphanReapStaleCutoffMs", () => {
    expect(parseContinuation({ orphanReapStaleCutoffMs: 1_800_000 }).success).toBe(true);
  });

  it("rejects a non-positive / non-integer orphanReapStaleCutoffMs", () => {
    expect(parseContinuation({ orphanReapStaleCutoffMs: 0 }).success).toBe(false);
    expect(parseContinuation({ orphanReapStaleCutoffMs: -5 }).success).toBe(false);
    expect(parseContinuation({ orphanReapStaleCutoffMs: 1.5 }).success).toBe(false);
  });
});
