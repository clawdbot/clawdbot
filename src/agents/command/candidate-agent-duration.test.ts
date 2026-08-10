import { describe, expect, it, vi } from "vitest";
import { createCandidateAgentDurationOwner } from "./candidate-agent-duration.js";

describe("createCandidateAgentDurationOwner", () => {
  it("records the first monotonic terminal boundary exactly once", () => {
    let current = 10.25;
    const observe = vi.fn();
    const owner = createCandidateAgentDurationOwner(observe, () => current);

    current = 133.9;
    owner.markTerminal();
    current = 10_000;
    owner.markTerminal();

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(123);
  });

  it("clamps backward and non-finite clocks to a safe duration", () => {
    const backward = vi.fn();
    const backwardOwner = createCandidateAgentDurationOwner(
      backward,
      vi.fn().mockReturnValueOnce(5).mockReturnValue(2),
    );
    backwardOwner.markTerminal();
    expect(backward).toHaveBeenCalledWith(0);

    const nonFinite = vi.fn();
    const nonFiniteOwner = createCandidateAgentDurationOwner(
      nonFinite,
      vi.fn().mockReturnValueOnce(5).mockReturnValue(Number.POSITIVE_INFINITY),
    );
    nonFiniteOwner.markTerminal();
    expect(nonFinite).toHaveBeenCalledWith(0);
  });
});
