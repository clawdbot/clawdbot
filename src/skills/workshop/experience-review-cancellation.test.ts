import { describe, expect, it, vi } from "vitest";
import { skillExperienceReviewCancellation as state } from "./experience-review-cancellation.js";

describe("skill experience review cancellation state", () => {
  it("routes cancellation and suppresses exactly one failed terminal event", () => {
    const cancelReview = vi.fn(() => true);
    state.register(cancelReview);

    expect(state.cancel(" agent:main:main ", " run-stopped ")).toBe(true);
    expect(cancelReview).toHaveBeenCalledWith("agent:main:main");
    expect(state.consumeStoppedTerminal("agent:main:main", "run-stopped", true)).toBe(false);
    expect(state.consumeStoppedTerminal("agent:main:main", "run-stopped", false)).toBe(true);
    expect(state.consumeStoppedTerminal("agent:main:main", "run-stopped", false)).toBe(false);
  });

  it("does not let another run consume the stopped run terminal marker", () => {
    state.register(() => false);

    expect(state.cancel("agent:main:shared", "run-stopped")).toBe(false);
    expect(state.consumeStoppedTerminal("agent:main:shared", "run-other", false)).toBe(false);
    expect(state.consumeStoppedTerminal("agent:main:shared", "run-stopped", false)).toBe(true);
  });

  it("discards the reserved terminal when the foreground abort is rejected", () => {
    state.register(() => false);

    state.cancel("agent:main:finalizing", "run-finalizing");
    state.discardStoppedTerminal("agent:main:finalizing", "run-finalizing");
    expect(state.consumeStoppedTerminal("agent:main:finalizing", "run-finalizing", false)).toBe(
      false,
    );
  });

  it("bounds stop markers that never receive a terminal event", () => {
    state.register(() => false);
    const runIds = Array.from({ length: 33 }, (_, index) => `unreported-stop-${index}`);

    for (const runId of runIds) {
      state.cancel("agent:main:bounded", runId);
    }

    expect(state.consumeStoppedTerminal("agent:main:bounded", runIds[0], false)).toBe(false);
    for (const runId of runIds.slice(1)) {
      expect(state.consumeStoppedTerminal("agent:main:bounded", runId, false)).toBe(true);
    }
  });
});
