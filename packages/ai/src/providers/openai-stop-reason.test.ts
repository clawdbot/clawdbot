import { describe, expect, it } from "vitest";
import { mapOpenAIStopReason } from "./openai-stop-reason.js";

describe("mapOpenAIStopReason", () => {
  it.each([
    ["stop", { stopReason: "stop" }],
    ["end", { stopReason: "stop" }],
    ["length", { stopReason: "length" }],
    ["function_call", { stopReason: "toolUse" }],
    ["tool_calls", { stopReason: "toolUse" }],
    [null, { stopReason: "stop" }],
  ] as const)("maps %s", (reason, expected) => {
    expect(mapOpenAIStopReason(reason)).toEqual(expected);
  });

  it("keeps singular tool_call opt-in", () => {
    expect(mapOpenAIStopReason("tool_call")).toEqual({
      stopReason: "error",
      errorMessage: "Provider finish_reason: tool_call",
    });
    expect(mapOpenAIStopReason("tool_call", { allowSingularToolCall: true })).toEqual({
      stopReason: "toolUse",
    });
  });

  it("surfaces provider errors and unknown reasons", () => {
    expect(mapOpenAIStopReason("content_filter")).toEqual({
      stopReason: "error",
      errorMessage: "Provider finish_reason: content_filter",
    });
    expect(mapOpenAIStopReason("unexpected")).toEqual({
      stopReason: "error",
      errorMessage: "Provider finish_reason: unexpected",
    });
  });
});
