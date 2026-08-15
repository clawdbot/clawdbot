import { describe, expect, it } from "vitest";
import { createAgentTurnTaintState } from "./turn-taint-state.js";

describe("agent turn taint state", () => {
  it("becomes sticky after network content while ignoring presentation updates", () => {
    const state = createAgentTurnTaintState();
    expect(state.isTainted()).toBe(false);

    state.observe({
      toolName: "fake_web_tool",
      argsHash: "args",
      resultHash: "result",
      resultContentSource: "network",
      presentationOnly: true,
    });
    expect(state.isTainted()).toBe(false);

    state.observe({
      toolName: "fake_web_tool",
      argsHash: "args",
      resultHash: "result",
      resultContentSource: "network",
    });
    state.observe({ toolName: "read", argsHash: "next", resultHash: "next" });
    expect(state.isTainted()).toBe(true);
  });
});
