import { describe, expect, it } from "vitest";
import { isAgentLifecycleYieldedWaiting } from "./agent-lifecycle-parent-state.js";

describe("agent lifecycle parent state", () => {
  it("recognizes the explicit yielded waiting contract", () => {
    expect(
      isAgentLifecycleYieldedWaiting({
        phase: "end",
        yielded: true,
        livenessState: "paused",
        stopReason: "end_turn",
      }),
    ).toBe(true);
  });

  it.each([
    { phase: "error", yielded: true, livenessState: "paused", stopReason: "end_turn" },
    { phase: "end", yielded: false, livenessState: "paused", stopReason: "end_turn" },
    { phase: "end", yielded: true, livenessState: "working", stopReason: "end_turn" },
    { phase: "end", yielded: true, livenessState: "paused", stopReason: "completed" },
    {
      phase: "end",
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
      aborted: true,
    },
    {
      phase: "end",
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
      status: "cancelled",
    },
    {
      phase: "end",
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
      timeoutPhase: "provider",
    },
    {
      phase: "end",
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
      error: "continuation failed",
    },
  ])("keeps incomplete or terminal variants out of waiting state", (event) => {
    expect(isAgentLifecycleYieldedWaiting(event)).toBe(false);
  });
});
