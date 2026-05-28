import { describe, expect, it } from "vitest";
import {
  GATEWAY_READY_OUTPUT_MAX_CHARS,
  updateGatewayReadyOutputState,
} from "../../scripts/check-memory-fd-repro.mjs";

describe("check-memory-fd-repro", () => {
  it("bounds gateway readiness output while keeping newest logs", () => {
    const first = updateGatewayReadyOutputState({ tail: "abc", readySeen: false }, "def", 8);
    expect(first).toEqual({ tail: "abcdef", readySeen: false });

    const second = updateGatewayReadyOutputState(first, "ghijkl", 8);
    expect(second).toEqual({ tail: "efghijkl", readySeen: false });
    expect(second.tail).toHaveLength(8);
    expect(GATEWAY_READY_OUTPUT_MAX_CHARS).toBeGreaterThan(1024);
  });

  it("keeps readiness after a coalesced noisy chunk truncates the marker", () => {
    const state = updateGatewayReadyOutputState(
      { tail: "", readySeen: false },
      `[gateway] ready\n${"x".repeat(10_000)}`,
      64,
    );

    expect(state.readySeen).toBe(true);
    expect(state.tail).toHaveLength(64);
    expect(state.tail).not.toContain("[gateway] ready");
  });

  it("recognizes readiness split across the existing tail and new chunk", () => {
    const state = updateGatewayReadyOutputState(
      { tail: "[gateway] rea", readySeen: false },
      "dy\n",
      64,
    );

    expect(state.readySeen).toBe(true);
    expect(state.tail).toBe("[gateway] ready\n");
  });

  it("preserves previous readiness once seen", () => {
    const state = updateGatewayReadyOutputState(
      { tail: "old", readySeen: true },
      "new output",
      8,
    );

    expect(state.readySeen).toBe(true);
    expect(state.tail).toBe("w output");
  });
});
