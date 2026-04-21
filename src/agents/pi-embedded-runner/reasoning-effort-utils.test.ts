import { describe, expect, it } from "vitest";
import { mapThinkingLevelToReasoningEffort } from "./reasoning-effort-utils.js";

describe("mapThinkingLevelToReasoningEffort", () => {
  it('maps "off" to "none"', () => {
    expect(mapThinkingLevelToReasoningEffort("off")).toBe("none");
  });

  it('maps "adaptive" to "medium"', () => {
    expect(mapThinkingLevelToReasoningEffort("adaptive")).toBe("medium");
  });

  it('maps "max" to "xhigh"', () => {
    expect(mapThinkingLevelToReasoningEffort("max")).toBe("xhigh");
  });

  it.each(["minimal", "low", "medium", "high", "xhigh"] as const)(
    "passes through %s unchanged",
    (level) => {
      expect(mapThinkingLevelToReasoningEffort(level)).toBe(level);
    },
  );
});
