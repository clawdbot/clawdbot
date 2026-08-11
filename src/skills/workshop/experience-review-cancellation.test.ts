import { describe, expect, it, vi } from "vitest";
import { skillExperienceReviewCancellation as state } from "./experience-review-cancellation.js";

describe("skill experience review cancellation state", () => {
  it("routes cancellation and suppresses exactly one failed terminal event", () => {
    const cancelReview = vi.fn(() => true);
    state.register(cancelReview);

    expect(state.cancel(" agent:main:main ", true)).toBe(true);
    expect(cancelReview).toHaveBeenCalledWith("agent:main:main");
    expect(state.consumeStoppedTerminal("agent:main:main", true)).toBe(false);
    expect(state.consumeStoppedTerminal("agent:main:main", false)).toBe(true);
    expect(state.consumeStoppedTerminal("agent:main:main", false)).toBe(false);
  });

  it("does not suppress a later failure when the foreground abort did not succeed", () => {
    state.register(() => false);

    expect(state.cancel("agent:main:no-active-run", false)).toBe(false);
    expect(state.consumeStoppedTerminal("agent:main:no-active-run", false)).toBe(false);
  });

  it("bounds stop markers that never receive a terminal event", () => {
    state.register(() => false);
    const sessionKeys = Array.from(
      { length: 33 },
      (_, index) => `agent:main:unreported-stop-${index}`,
    );

    for (const sessionKey of sessionKeys) {
      state.cancel(sessionKey, true);
    }

    expect(state.consumeStoppedTerminal(sessionKeys[0], false)).toBe(false);
    for (const sessionKey of sessionKeys.slice(1)) {
      expect(state.consumeStoppedTerminal(sessionKey, false)).toBe(true);
    }
  });
});
