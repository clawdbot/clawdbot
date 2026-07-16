import { describe, expect, it } from "vitest";
import { compareCapturedToolCallShape } from "./parity-shared.js";

const call = { tool: "image_generate", argsHash: "same-args" };

describe("compareCapturedToolCallShape", () => {
  it("accepts exact repeated executions", () => {
    expect(compareCapturedToolCallShape([call, call], [call, call])).toBeUndefined();
  });

  it("accepts a duplicated process-global capture row", () => {
    expect(compareCapturedToolCallShape([call, call], [call])).toBeUndefined();
    expect(compareCapturedToolCallShape([call, call, call], [call, call])).toBeUndefined();
  });

  it("preserves execution count for non-image tools", () => {
    const readCall = { tool: "read", argsHash: "same-args" };
    expect(compareCapturedToolCallShape([readCall, readCall], [readCall])).toBe(
      "tool call count differs (2 vs 1)",
    );
  });

  it("preserves canonical execution count", () => {
    expect(compareCapturedToolCallShape([call], [call, call])).toBe(
      "tool call count differs (1 vs 2)",
    );
  });
});
