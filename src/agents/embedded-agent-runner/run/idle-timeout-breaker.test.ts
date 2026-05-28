import { describe, expect, it } from "vitest";
import {
  MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT,
  createIdleTimeoutBreakerState,
  stepIdleTimeoutBreaker,
} from "./idle-timeout-breaker.js";

// Issue #76293. The wedge: a stalled provider returns from each LLM call
// with idleTimedOut=true and no completed model progress. Without this
// breaker the outer run loop in run.ts can keep starting fresh attempts (a
// new session and a new streamWithIdleTimeout wrapper each time, so any
// wrapper-local counter would reset on every iteration). The breaker state
// has to live at the outer-loop scope to survive across attempts and profile
// failover, which is what stepIdleTimeoutBreaker captures.
//
// These tests exercise the helper directly. The integration in run.ts is
// just `if (step.tripped) return handleRetryLimitExhaustion(...)`, so
// proving the helper trips/resets correctly is what matters.
describe("stepIdleTimeoutBreaker (#76293)", () => {
  function drive(
    inputs: Array<{
      idleTimedOut: boolean;
      completedModelProgress: boolean;
      outputTokens?: number;
    }>,
    options?: { cap?: number },
  ) {
    const state = createIdleTimeoutBreakerState();
    const steps: Array<{ consecutive: number; tripped: boolean }> = [];
    for (const input of inputs) {
      steps.push(stepIdleTimeoutBreaker(state, input, options));
    }
    return steps;
  }

  it("default cap matches the constant the run loop reads from", () => {
    expect(MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT).toBe(5);
  });

  it("does not trip on a single wedged attempt", () => {
    const steps = drive([{ idleTimedOut: true, completedModelProgress: false }]);
    expect(steps[0]).toEqual({ consecutive: 1, tripped: false });
  });

  it("trips on the Nth consecutive wedged attempt at the default cap", () => {
    const steps = drive([
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: true, completedModelProgress: false },
    ]);
    expect(steps.map((s) => s.tripped)).toEqual([false, false, false, false, true]);
    expect(steps.at(-1)?.consecutive).toBe(5);
  });

  it("respects an explicit smaller cap", () => {
    const steps = drive(
      [
        { idleTimedOut: true, completedModelProgress: false },
        { idleTimedOut: true, completedModelProgress: false },
        { idleTimedOut: true, completedModelProgress: false },
      ],
      { cap: 3 },
    );
    expect(steps.map((s) => s.tripped)).toEqual([false, false, true]);
  });

  it("disables the breaker entirely when cap is 0 (escape hatch)", () => {
    const steps = drive(
      [
        { idleTimedOut: true, completedModelProgress: false },
        { idleTimedOut: true, completedModelProgress: false },
        { idleTimedOut: true, completedModelProgress: false },
        { idleTimedOut: true, completedModelProgress: false },
        { idleTimedOut: true, completedModelProgress: false },
        { idleTimedOut: true, completedModelProgress: false },
        { idleTimedOut: true, completedModelProgress: false },
      ],
      { cap: 0 },
    );
    expect(steps.some((step) => step.tripped)).toBe(false);
    expect(steps.at(-1)?.consecutive).toBe(7);
  });

  it("does not trip when the model completed progress, even on a timeout (slow but alive)", () => {
    // 8 attempts that each timed out but each completed text or tool-call
    // progress. The model is slow at the tail of its turn, not wedged. The
    // breaker must stay disarmed so legitimate slow streams keep retrying.
    const steps = drive(
      Array.from({ length: 8 }, () => ({
        idleTimedOut: true,
        completedModelProgress: true,
        outputTokens: 220,
      })),
    );
    expect(steps.some((step) => step.tripped)).toBe(false);
    expect(steps.at(-1)?.consecutive).toBe(0);
  });

  it("resets the counter when a productive attempt arrives between wedged attempts", () => {
    // 4 wedged + 1 productive (completed progress) + 4 wedged. No run of 5
    // wedged in a row, so the breaker must stay disarmed across the whole
    // 9-attempt sequence even though 8 of the attempts were wedged in total.
    const steps = drive([
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: false, completedModelProgress: true, outputTokens: 320 },
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: true, completedModelProgress: false },
    ]);
    expect(steps.map((s) => s.tripped)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(steps.map((s) => s.consecutive)).toEqual([1, 2, 3, 4, 0, 1, 2, 3, 4]);
  });

  it("non-timeout error attempts (no output) leave the counter unchanged", () => {
    // Sequence: 3 wedged, then 2 non-timeout attempts that produced no
    // completed progress (e.g. transport error, prompt overflow), then 2
    // more wedged. The non-timeout attempts must NOT reset the counter
    // (they're not evidence the model is alive) and must NOT increment it
    // (the breaker is specifically about idle timeouts). So 3+0+0+1+1 = 5,
    // trip on the last attempt.
    const steps = drive([
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: false, completedModelProgress: false },
      { idleTimedOut: false, completedModelProgress: false },
      { idleTimedOut: true, completedModelProgress: false },
      { idleTimedOut: true, completedModelProgress: false },
    ]);
    expect(steps.map((s) => s.consecutive)).toEqual([1, 2, 3, 3, 3, 4, 5]);
    expect(steps.at(-1)?.tripped).toBe(true);
  });

  it("does not reset for partial tool-argument tokens without completed progress", () => {
    const steps = drive([
      { idleTimedOut: true, completedModelProgress: false, outputTokens: 12 },
      { idleTimedOut: true, completedModelProgress: false, outputTokens: 18 },
      { idleTimedOut: true, completedModelProgress: false, outputTokens: 24 },
      { idleTimedOut: true, completedModelProgress: false, outputTokens: 30 },
      { idleTimedOut: true, completedModelProgress: false, outputTokens: 36 },
    ]);
    // Raw provider output tokens can come from partial tool-call argument
    // deltas before the provider stalls. They are billed, but they are not
    // completed progress, so they must not reset the breaker.
    expect(steps.map((s) => s.consecutive)).toEqual([1, 2, 3, 4, 5]);
    expect(steps.at(-1)?.tripped).toBe(true);
  });
});
