// continue_work tool — delaySeconds boundary validation
//
// SEAM GUARDED: contract between model and continuation runtime around
// delay scheduling. continue_work lets a model say "wake me in N seconds";
// the runtime enforces bounds from continuation config (min/maxDelayMs)
// and rejects nonsensical inputs (negatives) outright.
//
// CANON (continue-work-tool.ts):
//   1. NEGATIVE delaySeconds → REJECTION (ToolInputError). Not clamped.
//   2. NON-NEGATIVE → CLAMPED into [minDelayMs, maxDelayMs] symmetrically.
//   3. Clamp result is surfaced to the model via the details `note` field.
//
// Tests guard the delaySeconds boundary contract. If any branch flips —
// clamp-where-reject, accept-where-clamp, or silent-coerce — inspect
// createContinueWorkTool validation and clamp handling.

import { afterEach, describe, expect, it, vi } from "vitest";
import { resetContinuationTracer } from "../../infra/continuation-tracer.js";
import { resetDiagnosticTraceContextForTest } from "../../infra/diagnostic-trace-context.js";
import { createContinueWorkTool, type ContinueWorkRequest } from "./continue-work-tool.js";

// Mock continuation config — same shape as the sibling test file. The
// numeric bounds here ARE the canon the tool is being held to: any drift
// between this mock and resolveContinuationRuntimeConfig's production
// defaults means the test is no longer guarding production behavior.
vi.mock("../../auto-reply/continuation/config.js", () => ({
  resolveContinuationRuntimeConfig: () => ({
    defaultDelayMs: 15_000,
    minDelayMs: 5_000,
    maxDelayMs: 300_000,
    maxChainLength: 10,
    costCapTokens: 500_000,
    maxDelegatesPerTurn: 5,
  }),
  // Mirror the real clampDelayMs semantics: default-fill, preserve an explicit
  // zero as the immediate sentinel, then clamp positive delays.
  clampDelayMs: (
    rawMs: number | undefined,
    config: { defaultDelayMs: number; minDelayMs: number; maxDelayMs: number },
  ) => {
    const requested = rawMs ?? config.defaultDelayMs;
    if (requested <= 0) {
      return 0;
    }
    return Math.max(config.minDelayMs, Math.min(config.maxDelayMs, requested));
  },
}));

describe("continue_work tool — delaySeconds boundary validation", () => {
  // BOUNDARY AXIS — one test per point on the delaySeconds number line:
  //   negative         → REJECT branch (ToolInputError, no schedule)
  //   over-max         → CLAMP-DOWN branch (schedule at maxDelayMs)
  //   far-over-max     → same CLAMP-DOWN, sanity check on extremes
  //   zero / under-min → CLAMP-UP branch (schedule at minDelayMs)
  // Collapsing any two branches (e.g. "negatives now clamp to 0") fires here.

  afterEach(() => {
    resetContinuationTracer();
    resetDiagnosticTraceContextForTest();
  });

  function makeTool(
    overrides?: Partial<{
      agentSessionKey: string | undefined;
      requestContinuation: (request: ContinueWorkRequest) => void;
    }>,
  ) {
    return createContinueWorkTool({
      agentSessionKey: "test-session-boundary",
      requestContinuation: vi.fn(),
      ...overrides,
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // REJECT branch: negative delaySeconds.
  //
  // CANON GUARDED: createContinueWorkTool throws ToolInputError for negative
  // values BEFORE reaching the clamping logic.
  // This is the asymmetric corner of the contract — every other invalid
  // shape gets coerced, but negatives are surfaced as errors.
  //
  // Regression indicator: if this test starts asserting "clamps to 0" or
  // "clamps to minDelayMs", the tool semantic has shifted from
  // reject-on-negative to coerce-on-negative; inspect whether the validate
  // gate was removed or relocated below the clamp.
  // ───────────────────────────────────────────────────────────────────────
  it("rejects negative delaySeconds with ToolInputError", async () => {
    const requestContinuation = vi.fn();
    const tool = makeTool({ requestContinuation });

    // The tool throws ToolInputError directly rather than returning
    // {isError:true}; wrap the call so we can assert both the throw shape and
    // the non-scheduling invariant.
    await expect(
      tool.execute("call-negative", {
        reason: "Negative delay boundary test.",
        delaySeconds: -5,
      }),
    ).rejects.toThrow(/non-negative/);

    // The tool should NOT have scheduled a continuation — negatives are
    // refused at the boundary, not silently coerced into a valid schedule.
    expect(requestContinuation).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────
  // CLAMP-DOWN branch: delaySeconds > maxDelayMs/1000.
  //
  // CANON GUARDED: requests above maxDelayMs are accepted-with-clamp, not
  // rejected. The `note` field surfaces the clamp so the model knows it
  // got a shorter delay than requested.
  //
  // Regression indicator: if this starts rejecting instead of clamping, the
  // tool became stricter and the model will start getting errors on
  // perfectly reasonable "wake me in 10 minutes" asks; verify the upper-bound
  // semantics before accepting the change.
  // ───────────────────────────────────────────────────────────────────────
  it("clamps delaySeconds exceeding maxDelayMs to 300s", async () => {
    const requestContinuation = vi.fn();
    const tool = makeTool({ requestContinuation });

    // 600s = 600_000ms exceeds maxDelayMs (300_000ms); the runtime should
    // pull this down to 300s and report the clamp.
    const result = (
      await tool.execute("call-over-max", {
        reason: "Over-max delay boundary test.",
        delaySeconds: 600,
      })
    )?.details as Record<string, unknown>;

    // requestContinuation receives the RAW value (600) — clamping happens
    // downstream in the scheduler / details payload, not in the request.
    expect(requestContinuation).toHaveBeenCalledWith({
      reason: "Over-max delay boundary test.",
      delaySeconds: 600,
    });
    // The tool's details payload reports the CLAMPED value (300s) plus a
    // `note` so the model can see what actually got scheduled.
    expect(result).toMatchObject({
      status: "scheduled",
      delaySeconds: 300,
      note: expect.stringContaining("clamped"),
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // CLAMP-DOWN branch (extreme): very-large delaySeconds.
  //
  // CANON GUARDED: same clamp behavior holds at the extreme tail; there
  // is no separate "absurd value" rejection path. 999_999s and 300s both
  // land at the same clamped result.
  //
  // Regression indicator: if someone adds an upper-upper-bound rejection
  // (e.g. "values > 1 hour are errors"), this test fires; reviewer should
  // decide whether that new gate is intentional or accidental.
  // ───────────────────────────────────────────────────────────────────────
  it("clamps very large delaySeconds (999999) to maxDelayMs (300s)", async () => {
    const requestContinuation = vi.fn();
    const tool = makeTool({ requestContinuation });

    const result = (
      await tool.execute("call-very-large", {
        reason: "Very large delay boundary test.",
        delaySeconds: 999_999,
      })
    )?.details as Record<string, unknown>;

    expect(requestContinuation).toHaveBeenCalledWith({
      reason: "Very large delay boundary test.",
      delaySeconds: 999_999,
    });
    // Identical clamp result as the over-max case above — proves the clamp
    // is saturating, not scaling.
    expect(result).toMatchObject({
      status: "scheduled",
      delaySeconds: 300,
      note: expect.stringContaining("clamped"),
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // IMMEDIATE-SENTINEL branch: delaySeconds === 0.
  //
  // CANON GUARDED: zero is the IMMEDIATE sentinel — it passes through as a
  // literal 0s schedule, NOT lifted to minDelayMs. This matches the
  // model-facing schema ("0 or omitted = immediate"): only POSITIVE delays
  // clamp to the [minDelayMs, maxDelayMs] band. Negatives are still rejected.
  //
  // Regression indicator: if zero starts rejecting (collapse with -1) OR
  // starts clamping up to minDelayMs (5s) again, the immediate-sentinel
  // contract has regressed; reviewer should check clampDelayMs preserves
  // the `requested <= 0 → 0` short-circuit.
  // ───────────────────────────────────────────────────────────────────────
  it("preserves delaySeconds = 0 as immediate", async () => {
    const requestContinuation = vi.fn();
    const tool = makeTool({ requestContinuation });

    const result = (
      await tool.execute("call-zero", {
        reason: "Zero delay boundary test.",
        delaySeconds: 0,
      })
    )?.details as Record<string, unknown>;

    expect(requestContinuation).toHaveBeenCalledWith({
      reason: "Zero delay boundary test.",
      delaySeconds: 0,
    });
    // Compute: 0s → 0ms → clampDelayMs short-circuits `requested <= 0 → 0` = 0s.
    // Because resolvedDelaySeconds === the requested 0, NO clamp note is emitted —
    // the immediate schedule passes through unchanged (the contract).
    expect(result).toEqual({
      status: "scheduled",
      delaySeconds: 0,
    });
  });
});
