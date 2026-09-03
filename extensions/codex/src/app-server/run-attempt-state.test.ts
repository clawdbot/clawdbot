// Codex tests cover run-attempt prompt state helpers.
import { describe, expect, it } from "vitest";
import { prependCurrentInboundContext } from "./run-attempt-state.js";

describe("prependCurrentInboundContext", () => {
  it("neutralizes explicit mention sigils in inbound context but not the prompt", () => {
    const joined = prependCurrentInboundContext("run $current-skill now", {
      text: "Quoted reply: please try $example-manual later",
    });

    expect(joined).toBe(
      "Quoted reply: please try ＄example-manual later\n\nrun $current-skill now",
    );
  });

  it("returns the prompt unchanged without inbound context", () => {
    expect(prependCurrentInboundContext("run $current-skill now", undefined)).toBe(
      "run $current-skill now",
    );
  });
});
